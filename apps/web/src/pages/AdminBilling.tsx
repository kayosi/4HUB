import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { PAYMENT_STATUS_LABEL, fmtDate, formatMoney, paymentTone, toMinor, type PaymentStatus } from '../lib/billing';
import { Alert, Badge, Button, Card, Field, Spinner } from '../components/ui';
import { EmptyState, ErrorState } from '../components/ui/states';

interface Tx { id: string; status: PaymentStatus; amountMinor: number; currency: string; provider: string; planName: string; userEmail: string; userName: string; createdAt: string; refundedMinor: number; failureReason: string | null }
interface Summary {
  revenue: { currency: string; grossMinor: number; refundedMinor: number; netMinor: number; payments: number }[];
  subscribers: { active: number; grace: number; expired: number; cancelled: number; withAccess: number };
  payments: { succeeded: number; failed: number; cancelled: number; pending: number };
  refunds: { count: number };
  breakdown: { planCode: string; planName: string; subscribers: number }[];
  recent: Tx[];
}

export default function AdminBilling() {
  const s = useAsync(() => api<Summary>('/admin/billing/summary'));
  const [status, setStatus] = useState('');
  const tx = useAsync(() => api<{ transactions: Tx[] }>(`/admin/billing/transactions?limit=50${status ? `&status=${status}` : ''}`), status);
  const [refunding, setRefunding] = useState<Tx>();
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();

  const refresh = () => { s.reload(); tx.reload(); };
  const refund = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!refunding) return;
    const fd = new FormData(e.currentTarget);
    const reason = String(fd.get('reason') ?? '').trim();
    const amount = String(fd.get('amount') ?? '').trim();
    if (reason.length < 3) return setMsg({ kind: 'error', text: 'Give a short reason' });
    try {
      await api(`/admin/payments/${refunding.id}/refund`, { method: 'POST', body: { reason, ...(amount ? { amountMinor: toMinor(Number(amount)) } : {}) } });
      setMsg({ kind: 'success', text: 'Refund recorded.' }); setRefunding(undefined); refresh();
    } catch (err) { setMsg({ kind: 'error', text: err instanceof Error ? err.message : 'Could not record refund' }); }
  };

  return (
    <div className="stack">
      <div className="page-head"><h1>Revenue &amp; billing</h1></div>
      {s.status === 'loading' && <Spinner />}
      {s.status === 'error' && <ErrorState message={s.error.message} onRetry={s.reload} />}
      {s.status === 'ready' && (
        <>
          <div className="grid grid-3">
            {s.data.revenue.length === 0 && <Card title="Net revenue"><div className="stat">—</div><p className="muted small">No paid payments yet</p></Card>}
            {s.data.revenue.map((r) => (
              <Card key={r.currency} title={`Net revenue (${r.currency})`}>
                <div className="stat" data-testid={`net-${r.currency}`}>{formatMoney(r.netMinor, r.currency)}</div>
                <p className="muted small">Gross {formatMoney(r.grossMinor, r.currency)} − refunds {formatMoney(r.refundedMinor, r.currency)}</p>
              </Card>
            ))}
            <Card title="Active subscribers"><div className="stat" data-testid="active">{s.data.subscribers.withAccess}</div><p className="muted small">{s.data.subscribers.active} active · {s.data.subscribers.grace} in grace</p></Card>
            <Card title="Expired subscriptions"><div className="stat" data-testid="expired">{s.data.subscribers.expired}</div><p className="muted small">{s.data.subscribers.cancelled} cancelled/revoked</p></Card>
            <Card title="Failed payments"><div className="stat negative" data-testid="failed">{s.data.payments.failed}</div><p className="muted small">{s.data.payments.pending} pending · {s.data.payments.cancelled} cancelled</p></Card>
            <Card title="Refunds"><div className="stat" data-testid="refunds">{s.data.refunds.count}</div><p className="muted small">{s.data.payments.succeeded} paid payments</p></Card>
          </div>

          <Card title="Subscribers by plan">
            {s.data.breakdown.length === 0 ? <EmptyState title="No active subscribers" /> : (
              <div className="table-wrap"><table><thead><tr><th>Plan</th><th>Subscribers</th></tr></thead>
                <tbody>{s.data.breakdown.map((b) => <tr key={b.planCode}><td>{b.planName}</td><td>{b.subscribers}</td></tr>)}</tbody></table></div>
            )}
          </Card>
        </>
      )}

      <h2>Transactions</h2>
      <div className="filters" style={{ maxWidth: 260 }}>
        <div className="field"><label htmlFor="tx-status">Status</label>
          <select id="tx-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>{(Object.keys(PAYMENT_STATUS_LABEL) as PaymentStatus[]).map((k) => <option key={k} value={k}>{PAYMENT_STATUS_LABEL[k]}</option>)}
          </select></div>
      </div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {refunding && (
        <Card title={`Record refund: ${refunding.userEmail}`}>
          <p className="muted small">Records a refund you already issued outside 4HUB (e.g. an M-Pesa reversal). No money is moved by this form. A full refund ends the access that payment bought.</p>
          <form className="stack" onSubmit={refund} noValidate style={{ maxWidth: 420 }}>
            <Field label="Reason" name="reason" maxLength={200} />
            <Field label={`Amount (${refunding.currency}, blank = full)`} name="amount" inputMode="decimal" />
            <div className="row"><Button type="submit" variant="secondary">Record refund</Button><Button type="button" variant="ghost" onClick={() => setRefunding(undefined)}>Cancel</Button></div>
          </form>
        </Card>
      )}
      {tx.status === 'loading' && <Spinner />}
      {tx.status === 'error' && <ErrorState message={tx.error.message} onRetry={tx.reload} />}
      {tx.status === 'ready' && (tx.data.transactions.length === 0 ? <EmptyState title="No transactions" /> : (
        <div className="table-wrap"><table className="stack">
          <thead><tr><th>Date</th><th>Member</th><th>Plan</th><th>Amount</th><th>Method</th><th>Status</th><th></th></tr></thead>
          <tbody>{tx.data.transactions.map((t) => (
            <tr key={t.id}>
              <td data-label="Date">{fmtDate(t.createdAt)}</td><td data-label="Member">{t.userName}<br /><span className="muted small">{t.userEmail}</span></td><td data-label="Plan">{t.planName}</td>
              <td data-label="Amount">{formatMoney(t.amountMinor, t.currency)}</td><td data-label="Method">{t.provider}</td>
              <td data-label="Status"><span className={`badge result-${paymentTone(t.status)}`}>{PAYMENT_STATUS_LABEL[t.status]}</span>{t.refundedMinor > 0 && <Badge>−{formatMoney(t.refundedMinor, t.currency)}</Badge>}</td>
              <td>{(t.status === 'succeeded' || t.status === 'partially_refunded') && <Button small variant="ghost" onClick={() => { setMsg(undefined); setRefunding(t); }}>Record refund</Button>}</td>
            </tr>))}</tbody>
        </table></div>
      ))}
    </div>
  );
}
