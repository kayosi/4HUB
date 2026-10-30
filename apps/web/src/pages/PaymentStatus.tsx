import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { failureMessage, fmtDate, formatMoney, type Payment } from '../lib/billing';
import { Alert, Button, ButtonLink, Card, Spinner } from '../components/ui';
import { NotFoundState } from '../components/ui/states';
import { useAuth } from '../auth/AuthContext';

const POLL_MS = 3000;
const VERIFY_AFTER_MS = 12_000;

/** Shows the payment's status as recorded by the server. It never marks anything paid on its own. */
export default function PaymentStatus() {
  const { id = '' } = useParams();
  const loc = useLocation();
  const { user, refresh } = useAuth();
  const [payment, setPayment] = useState<Payment>();
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  useEffect(() => {
    let live = true;
    const startedAt = Date.now(); // local to this polling session
    let lastVerify = 0;
    const tick = async () => {
      try {
        const { payment: p } = await api<{ payment: Payment }>(`/billing/payments/${id}`);
        if (live) setPayment(p);
        // The customer may have missed the callback: after a while, ask the server to re-check with the provider.
        if (p.status === 'pending' && Date.now() - startedAt > VERIFY_AFTER_MS && Date.now() - lastVerify > VERIFY_AFTER_MS) {
          lastVerify = Date.now();
          const v = await api<{ payment: Payment }>(`/billing/payments/${id}/verify`, { method: 'POST' }).catch(() => null);
          if (live && v) setPayment(v.payment);
        }
      } catch (e) {
        if (live && e instanceof ApiError && e.status === 404) setMissing(true);
      }
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [id]);

  // Once the server says the payment succeeded, re-read the account so premium shows up everywhere.
  useEffect(() => {
    if (payment?.status === 'succeeded' && user && !user.access.premium) void refresh();
  }, [payment?.status, user, refresh]);

  const settle = async (outcome: 'succeeded' | 'failed') => {
    setBusy(true); setErr(undefined);
    try { setPayment((await api<{ payment: Payment }>(`/billing/sandbox/payments/${id}/settle`, { method: 'POST', body: { outcome } })).payment); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Sandbox action failed'); } finally { setBusy(false); }
  };

  if (missing) return <NotFoundState />;
  if (!payment) return <Spinner label="Checking payment" />;
  const message = (loc.state as { message?: string } | null)?.message;

  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      <div className="page-head"><h1>Payment</h1></div>
      <Card>
        <div role="status" aria-live="polite">
          {payment.status === 'pending' && (<>
            <div className="spinner" aria-hidden="true" style={{ margin: '0 0 12px' }} />
            <h2>Waiting for confirmation…</h2>
            <p className="muted">{message ?? 'We are waiting for your payment to be confirmed. This usually takes a few seconds. You can leave this page; your plan activates as soon as the payment is confirmed.'}</p>
          </>)}
          {payment.status === 'succeeded' && (<>
            <h2 className="positive">Payment confirmed</h2>
            <p>Thank you. Your {payment.planName} is active.</p>
            <div className="row"><ButtonLink to="/signals">View signals</ButtonLink><ButtonLink to="/billing" variant="secondary">Billing</ButtonLink></div>
          </>)}
          {(payment.status === 'failed' || payment.status === 'cancelled') && (<>
            <h2 className="negative">{payment.status === 'cancelled' ? 'Payment cancelled' : 'Payment failed'}</h2>
            <p className="muted">{failureMessage(payment.failureReason)}</p>
            <div className="row"><ButtonLink to={`/checkout/${payment.planCode}`}>Try again</ButtonLink><ButtonLink to="/billing" variant="secondary">Billing</ButtonLink></div>
          </>)}
          {(payment.status === 'refunded' || payment.status === 'partially_refunded') && (<>
            <h2>Payment refunded</h2>
            <p className="muted">{formatMoney(payment.refundedMinor, payment.currency)} was refunded.</p>
            <ButtonLink to="/billing" variant="secondary">Billing</ButtonLink>
          </>)}
        </div>
        <dl className="kv">
          <div><dt>Plan</dt><dd>{payment.planName}</dd></div>
          <div><dt>Amount</dt><dd>{formatMoney(payment.amountMinor, payment.currency)}</dd></div>
          <div><dt>Started</dt><dd>{fmtDate(payment.createdAt)}</dd></div>
          {payment.payerHint && <div><dt>Phone</dt><dd>{payment.payerHint}</dd></div>}
        </dl>
      </Card>

      {payment.provider === 'mock' && payment.status === 'pending' && (
        <Card title="Sandbox controls (test mode only)">
          <p className="muted small">These simulate the payment provider. They go through the same signed-webhook verification as a real payment.</p>
          {err && <Alert>{err}</Alert>}
          <div className="row">
            <Button small loading={busy} onClick={() => settle('succeeded')}>Simulate successful payment</Button>
            <Button small variant="secondary" disabled={busy} onClick={() => settle('failed')}>Simulate failed payment</Button>
          </div>
        </Card>
      )}
      <p className="muted small"><Link to="/billing">Back to billing</Link></p>
    </div>
  );
}
