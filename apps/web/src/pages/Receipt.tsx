import { useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { fmtDate, formatMoney, type Invoice, type Receipt as ReceiptData } from '../lib/billing';
import { Button, Spinner } from '../components/ui';
import { ErrorState, NotFoundState } from '../components/ui/states';

export default function Receipt() {
  const { id = '' } = useParams();
  const s = useAsync(() => api<{ invoice: Invoice; receipt: ReceiptData }>(`/billing/invoices/${id}`), id);
  if (s.status === 'loading') return <Spinner />;
  if (s.status === 'error') return s.error instanceof ApiError && s.error.status === 404 ? <NotFoundState /> : <ErrorState message={s.error.message} onRetry={s.reload} />;
  const { invoice: i, receipt: r } = s.data;
  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      <article className="card receipt" aria-label={`Receipt ${r.number}`}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div><strong>4HUB</strong><p className="muted small" style={{ margin: 0 }}>Receipt</p></div>
          <div style={{ textAlign: 'right' }}><strong>{r.number}</strong><p className="muted small" style={{ margin: 0 }}>Issued {fmtDate(i.issuedAt)}</p></div>
        </div>
        <hr />
        <dl className="kv">
          <div><dt>Billed to</dt><dd>{r.customer.name}<br /><span className="muted">{r.customer.email}</span></dd></div>
          <div><dt>Description</dt><dd>{i.description}</dd></div>
          <div><dt>Amount</dt><dd><strong>{formatMoney(i.amountMinor, i.currency)}</strong></dd></div>
          {r.refundedMinor > 0 && <div><dt>Refunded</dt><dd>{formatMoney(r.refundedMinor, i.currency)}</dd></div>}
          <div><dt>Status</dt><dd>{i.status === 'paid' ? 'Paid' : i.status === 'refunded' ? 'Refunded' : 'Partly refunded'}</dd></div>
          <div><dt>Paid on</dt><dd>{fmtDate(r.paidAt)}</dd></div>
          {r.provider && <div><dt>Method</dt><dd>{r.provider}{r.payerHint ? ` · ${r.payerHint}` : ''}</dd></div>}
          {r.transactionId && <div><dt>Transaction</dt><dd>{r.transactionId}</dd></div>}
        </dl>
      </article>
      <div className="row no-print"><Button variant="secondary" onClick={() => window.print()}>Print / save as PDF</Button></div>
    </div>
  );
}
