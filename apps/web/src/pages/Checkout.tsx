import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { durationLabel, formatMoney, type NextAction, type Payment, type Plan, type ProviderInfo } from '../lib/billing';
import { Alert, Button, Card, Field, Spinner } from '../components/ui';
import { ErrorState, NotFoundState } from '../components/ui/states';

export default function Checkout() {
  const { planCode = '' } = useParams();
  const nav = useNavigate();
  const s = useAsync(() => api<{ plans: Plan[]; providers: ProviderInfo[] }>('/billing/plans'), planCode);
  // One key per checkout screen: double-clicks and retries after a flaky network cannot create two payments.
  const idem = useRef(crypto.randomUUID());
  const [provider, setProvider] = useState<string>();
  const [error, setError] = useState<string>();
  const [fieldErr, setFieldErr] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (s.status === 'loading') return <Spinner label="Loading checkout" />;
  if (s.status === 'error') return <ErrorState message={s.error.message} onRetry={s.reload} />;
  const plan = s.data.plans.find((p) => p.code === planCode);
  if (!plan || plan.tier === 'free') return <NotFoundState />;
  const usable = s.data.providers.filter((p) => p.currencies.includes(plan.currency));
  const chosen = usable.find((p) => p.id === provider) ?? usable[0];

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!chosen) return;
    const phone = String(new FormData(e.currentTarget).get('phoneNumber') ?? '').trim();
    setError(undefined); setFieldErr(undefined);
    if (chosen.method === 'mobile_money' && !phone) return setFieldErr('Enter your M-Pesa phone number');
    setBusy(true);
    try {
      // Only WHAT to buy and HOW to pay is sent. The price is decided by the server.
      const r = await api<{ payment: Payment; action: NextAction | null }>('/billing/checkout', {
        method: 'POST',
        body: { planCode: plan.code, provider: chosen.id, idempotencyKey: idem.current, ...(chosen.method === 'mobile_money' ? { phoneNumber: phone } : {}) },
      });
      if (r.action?.type === 'redirect') window.location.assign(r.action.url);
      else nav(`/billing/payments/${r.payment.id}`, { replace: true, state: { message: r.action?.message } });
    } catch (err) {
      if (err instanceof ApiError && err.details?.phoneNumber) setFieldErr(err.details.phoneNumber);
      else setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      setBusy(false);
    }
  };

  return (
    <div className="container page" style={{ maxWidth: 720 }}>
      <div className="page-head"><h1>Checkout</h1><p><Link to="/pricing">← Back to plans</Link></p></div>
      <Card title="Order summary">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div><strong>{plan.name}</strong><p className="muted small" style={{ margin: 0 }}>Access for {plan.durationDays} days</p></div>
          <div style={{ textAlign: 'right' }}><div className="price" style={{ margin: 0 }} data-testid="total">{formatMoney(plan.priceMinor, plan.currency)}</div><span className="muted small">per {durationLabel(plan.durationDays)}</span></div>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>One-off payment: you choose when to renew. Time you buy is added after any time you already have.</p>
      </Card>

      <form className="stack" onSubmit={submit} noValidate style={{ marginTop: 16 }}>
        <Card title="Payment method">
          {usable.length === 0 && <Alert>No payment method is available for this plan right now. Please try again later.</Alert>}
          <div className="stack" role="radiogroup" aria-label="Payment method">
            {usable.map((p) => (
              <label key={p.id} className="check method">
                <input type="radio" name="provider" value={p.id} checked={chosen?.id === p.id} onChange={() => setProvider(p.id)} /> {p.name}
                {p.method === 'card' && <span className="muted small"> · you will be taken to our payment partner</span>}
              </label>
            ))}
          </div>
          {chosen?.method === 'mobile_money' && (
            <div style={{ marginTop: 12 }}>
              <Field label="M-Pesa phone number" name="phoneNumber" inputMode="tel" autoComplete="tel" placeholder="0712 345 678" hint="You will get a prompt on this phone to enter your PIN." error={fieldErr} />
            </div>
          )}
          {chosen?.method === 'sandbox' && <p className="alert" role="note" style={{ marginTop: 12 }}>Sandbox mode: no real money is taken. You will complete the payment with test controls on the next screen.</p>}
        </Card>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" block loading={busy} disabled={!chosen}>Pay {formatMoney(plan.priceMinor, plan.currency)}</Button>
        <p className="muted small">We never see or store your card details. Premium is activated only after the payment is confirmed by our payment partner.</p>
      </form>
    </div>
  );
}
