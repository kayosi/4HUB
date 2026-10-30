import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { formatMoney, toMajor, toMinor, type Plan } from '../lib/billing';
import { Alert, Badge, Button, Card, Field, Spinner } from '../components/ui';
import { ErrorState } from '../components/ui/states';

const CURRENCIES = ['KES', 'USD', 'EUR', 'GBP', 'ZAR', 'NGN', 'GHS'];

export default function AdminPlans() {
  const s = useAsync(() => api<{ plans: Plan[] }>('/admin/plans'));
  const [editing, setEditing] = useState<Plan | 'new'>();
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();

  const toggle = async (p: Plan) => {
    try { await api(`/admin/plans/${p.id}`, { method: 'PATCH', body: { isActive: !p.isActive } }); s.reload(); }
    catch (e) { setMsg({ kind: 'error', text: e instanceof Error ? e.message : 'Could not update plan' }); }
  };

  return (
    <div className="stack">
      <div className="page-head"><h1>Plans</h1><p className="muted">Changes apply to new purchases only. Existing payments and subscriptions keep the price and length they were sold at.</p></div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {s.status === 'loading' && <Spinner />}
      {s.status === 'error' && <ErrorState message={s.error.message} onRetry={s.reload} />}
      {s.status === 'ready' && (
        <div className="table-wrap"><table>
          <thead><tr><th>Plan</th><th>Tier</th><th>Price</th><th>Duration</th><th>Status</th><th></th></tr></thead>
          <tbody>{s.data.plans.map((p) => (
            <tr key={p.id}>
              <td>{p.name}<br /><span className="muted small">{p.code}</span></td><td className="cap">{p.tier}</td>
              <td>{p.priceMinor === 0 ? 'Free' : formatMoney(p.priceMinor, p.currency)}</td><td>{p.durationDays ? `${p.durationDays} days` : '—'}</td>
              <td><Badge accent={p.isActive}>{p.isActive ? 'Active' : 'Inactive'}</Badge></td>
              <td><div className="row"><Button small variant="secondary" onClick={() => { setMsg(undefined); setEditing(p); }}>Edit</Button>
                {p.code !== 'free' && <Button small variant="ghost" onClick={() => toggle(p)}>{p.isActive ? 'Deactivate' : 'Activate'}</Button>}</div></td>
            </tr>))}</tbody>
        </table></div>
      )}
      {!editing && <div><Button onClick={() => { setMsg(undefined); setEditing('new'); }}>New plan</Button></div>}
      {editing && <PlanForm key={editing === 'new' ? 'new' : editing.id} plan={editing === 'new' ? undefined : editing} onDone={(text) => { setEditing(undefined); setMsg({ kind: 'success', text }); s.reload(); }} onCancel={() => setEditing(undefined)} />}
    </div>
  );
}

function PlanForm({ plan, onDone, onCancel }: { plan?: Plan; onDone: (m: string) => void; onCancel: () => void }) {
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const free = plan?.tier === 'free';

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const g = (k: string) => String(f.get(k) ?? '').trim();
    const price = Number(g('price'));
    const days = g('durationDays');
    if (Number.isNaN(price) || price < 0) return setErr('Enter a valid price');
    const body: Record<string, unknown> = {
      name: g('name'), description: g('description'), priceMinor: toMinor(price), currency: g('currency'),
      durationDays: days === '' ? null : Number(days),
      features: g('features').split('\n').map((x) => x.trim()).filter(Boolean),
      isActive: f.get('isActive') === 'on', sortOrder: Number(g('sortOrder') || 0),
    };
    setErr(undefined); setBusy(true);
    try {
      if (plan) await api(`/admin/plans/${plan.id}`, { method: 'PATCH', body });
      else await api('/admin/plans', { method: 'POST', body: { ...body, code: g('code'), tier: g('tier') } });
      onDone(plan ? 'Plan updated.' : 'Plan created.');
    } catch (e2) {
      setErr(e2 instanceof ApiError ? (e2.details ? Object.entries(e2.details).map(([k, v]) => `${k}: ${v}`).join(' · ') : e2.message) : 'Could not save plan');
      setBusy(false);
    }
  };

  return (
    <Card title={plan ? `Edit ${plan.name}` : 'New plan'}>
      <form className="stack" onSubmit={submit} noValidate style={{ maxWidth: 560 }}>
        {err && <Alert>{err}</Alert>}
        {!plan && (
          <div className="form-grid">
            <Field label="Code" name="code" placeholder="premium_biannual" hint="Permanent. Lowercase letters, numbers, underscores." />
            <div className="field"><label htmlFor="tier">Tier</label><select id="tier" name="tier" className="input" defaultValue="premium"><option value="premium">premium</option></select></div>
          </div>
        )}
        <Field label="Name" name="name" defaultValue={plan?.name} />
        <Field label="Description" name="description" defaultValue={plan?.description} />
        <div className="form-grid">
          <Field label="Price" name="price" inputMode="decimal" defaultValue={plan ? String(toMajor(plan.priceMinor)) : ''} disabled={false} />
          <div className="field"><label htmlFor="currency">Currency</label>
            <select id="currency" name="currency" className="input" defaultValue={plan?.currency ?? 'KES'}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select></div>
          <Field label="Duration (days)" name="durationDays" inputMode="numeric" defaultValue={plan?.durationDays ? String(plan.durationDays) : ''} hint={free ? 'Free plan has no duration' : undefined} />
          <Field label="Sort order" name="sortOrder" inputMode="numeric" defaultValue={String(plan?.sortOrder ?? 0)} />
        </div>
        <div className="field"><label htmlFor="features">Features (one per line)</label>
          <textarea id="features" name="features" className="input" defaultValue={plan?.features.join('\n')} /></div>
        <label className="check"><input type="checkbox" name="isActive" defaultChecked={plan?.isActive ?? true} /> Active (visible and purchasable)</label>
        <div className="row"><Button type="submit" loading={busy}>{plan ? 'Save changes' : 'Create plan'}</Button><Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button></div>
      </form>
    </Card>
  );
}
