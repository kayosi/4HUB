import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import {
  PAYMENT_STATUS_LABEL, SUBSCRIPTION_LABEL, fmtDate, formatMoney, paymentTone,
  type Invoice, type Payment, type Subscription,
} from '../lib/billing';
import { Alert, Badge, Button, ButtonLink, Card, Spinner } from '../components/ui';
import { EmptyState, ErrorState } from '../components/ui/states';

export default function Billing() {
  const sub = useAsync(() => api<{ subscriptions: Subscription[] }>('/billing/subscription'));
  const pay = useAsync(() => api<{ payments: Payment[] }>('/billing/payments?limit=50'));
  const inv = useAsync(() => api<{ invoices: Invoice[] }>('/billing/invoices?limit=50'));

  return (
    <div className="stack">
      <div className="page-head"><h1>Billing</h1><p className="muted">Your plan, payments and receipts.</p></div>
      {sub.status === 'loading' && <Spinner />}
      {sub.status === 'error' && <ErrorState message={sub.error.message} onRetry={sub.reload} />}
      {sub.status === 'ready' && <SubscriptionCard sub={sub.data.subscriptions.find((s) => s.tier === 'premium')} onChange={sub.reload} />}

      <Card title="Payment history">
        {pay.status === 'loading' && <Spinner />}
        {pay.status === 'error' && <ErrorState message={pay.error.message} onRetry={pay.reload} />}
        {pay.status === 'ready' && (pay.data.payments.length === 0 ? <EmptyState title="No payments yet" /> : (
          <div className="table-wrap"><table className="stack">
            <thead><tr><th>Date</th><th>Plan</th><th>Amount</th><th>Status</th><th></th></tr></thead>
            <tbody>{pay.data.payments.map((p) => (
              <tr key={p.id}>
                <td data-label="Date">{fmtDate(p.createdAt)}</td><td data-label="Plan">{p.planName}</td><td data-label="Amount">{formatMoney(p.amountMinor, p.currency)}</td>
                <td data-label="Status"><span className={`badge result-${paymentTone(p.status)}`}>{PAYMENT_STATUS_LABEL[p.status]}</span></td>
                <td>{p.status === 'pending' && <Link to={`/billing/payments/${p.id}`}>Check status</Link>}</td>
              </tr>))}</tbody>
          </table></div>
        ))}
      </Card>

      <Card title="Invoices & receipts">
        {inv.status === 'loading' && <Spinner />}
        {inv.status === 'error' && <ErrorState message={inv.error.message} onRetry={inv.reload} />}
        {inv.status === 'ready' && (inv.data.invoices.length === 0 ? <EmptyState title="No invoices yet" message="A receipt appears here after each successful payment." /> : (
          <div className="table-wrap"><table className="stack">
            <thead><tr><th>Invoice</th><th>Description</th><th>Amount</th><th>Status</th><th></th></tr></thead>
            <tbody>{inv.data.invoices.map((i) => (
              <tr key={i.id}>
                <td data-label="Invoice">{i.number}</td><td data-label="Period">{i.description}</td><td data-label="Amount">{formatMoney(i.amountMinor, i.currency)}</td>
                <td data-label="Status"><Badge>{i.status === 'paid' ? 'Paid' : i.status === 'refunded' ? 'Refunded' : 'Partly refunded'}</Badge></td>
                <td><Link to={`/billing/invoices/${i.id}`}>View receipt</Link></td>
              </tr>))}</tbody>
          </table></div>
        ))}
      </Card>
    </div>
  );
}

function SubscriptionCard({ sub, onChange }: { sub: Subscription | undefined; onChange: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const act = async (path: 'cancel' | 'resume') => {
    setBusy(true); setErr(undefined);
    try { await api(`/billing/subscription/${path}`, { method: 'POST', body: { tier: 'premium' } }); setConfirming(false); onChange(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Something went wrong'); } finally { setBusy(false); }
  };

  if (!sub) {
    return (
      <Card title="Current plan">
        <h2>Free</h2>
        <p className="muted">You can read free signals. Upgrade to see entry, stop loss, targets, charts and full analysis on premium signals.</p>
        <ButtonLink to="/pricing">See premium plans</ButtonLink>
      </Card>
    );
  }
  return (
    <Card title="Current plan">
      <div className="row"><h2 style={{ margin: 0 }}>{sub.planName ?? 'Premium'}</h2><span className={`badge ${sub.hasAccess ? 'badge-premium' : 'result-negative'}`}>{SUBSCRIPTION_LABEL[sub.status]}</span></div>
      {sub.source === 'admin_grant' && <p className="muted small">Complimentary access granted by 4HUB.</p>}
      {sub.status === 'active' && !sub.cancelAtPeriodEnd && <p>Your access runs until <strong>{fmtDate(sub.currentPeriodEnd)}</strong> ({sub.daysLeft} day{sub.daysLeft === 1 ? '' : 's'} left). Renewal is manual: you choose when to pay again, and the time is added to what you have.</p>}
      {sub.status === 'active' && sub.cancelAtPeriodEnd && <Alert kind="info">Your subscription is cancelled. You keep premium until <strong>{fmtDate(sub.currentPeriodEnd)}</strong>, then it ends.</Alert>}
      {sub.status === 'grace' && <Alert>Your period ended on {fmtDate(sub.currentPeriodEnd)}. You keep access until <strong>{fmtDate(sub.graceEndsAt)}</strong>. Renew now to stay premium.</Alert>}
      {sub.status === 'expired' && <Alert>Your premium access ended on {fmtDate(sub.graceEndsAt ?? sub.currentPeriodEnd)}. Renew to get it back.</Alert>}
      {sub.status === 'cancelled' && <Alert>Your premium access has been ended. Contact support if you think this is a mistake, or buy a new plan.</Alert>}
      {sub.paymentFailed && <Alert>Your last payment did not go through. Try again from the pricing page.</Alert>}
      {err && <Alert>{err}</Alert>}
      <div className="row" style={{ marginTop: 12 }}>
        <ButtonLink to="/pricing" small>{sub.hasAccess ? 'Renew or upgrade' : 'Renew now'}</ButtonLink>
        {sub.status === 'active' && sub.cancelAtPeriodEnd && <Button small variant="secondary" loading={busy} onClick={() => act('resume')}>Keep my subscription</Button>}
        {sub.hasAccess && !sub.cancelAtPeriodEnd && !confirming && <Button small variant="ghost" onClick={() => setConfirming(true)}>Cancel subscription</Button>}
      </div>
      {confirming && (
        <div className="alert" style={{ marginTop: 12 }} role="alertdialog" aria-label="Confirm cancellation">
          <p style={{ marginTop: 0 }}>Cancel? You keep premium until {fmtDate(sub.currentPeriodEnd)}. No refund is issued for the time left.</p>
          <div className="row"><Button small variant="secondary" loading={busy} onClick={() => act('cancel')}>Yes, cancel</Button><Button small variant="ghost" onClick={() => setConfirming(false)}>Keep it</Button></div>
        </div>
      )}
    </Card>
  );
}
