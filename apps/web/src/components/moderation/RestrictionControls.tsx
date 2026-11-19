import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { untilText, type RestrictionSummary, type UserRestrictions } from '../../lib/moderation';
import { Alert, Badge, Button } from '../ui';

const LABEL = { muted: 'Muted', suspended: 'Suspended' } as const;
const DURATIONS: { hours: number | null; label: string }[] = [
  { hours: 24, label: '24 hours' }, { hours: 72, label: '3 days' }, { hours: 168, label: '7 days' }, { hours: 720, label: '30 days' }, { hours: null, label: 'Until I lift it' },
];

/**
 * Administrator tools for one account: see what is in force, lift it, or add a mute/suspension. Only rendered for administrators;
 * the API enforces that regardless. Used on the admin user list and on moderation report cards.
 */
export default function RestrictionControls({ userId, name, restrictions, onChange }: {
  userId: string; name: string; restrictions: UserRestrictions;
  /** Called after a change with a plain-language confirmation. The parent shows it, because the list reloads and this component remounts. */
  onChange: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<'muted' | 'suspended'>('muted');
  const [hours, setHours] = useState<string>('24');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setError('');
    try { await fn(); onChange(ok); return true; } catch (e) { setError(e instanceof ApiError ? e.message : 'Something went wrong.'); return false; } finally { setBusy(false); }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 3) { setError('Give a reason. The person will see it.'); return; }
    const good = await act(
      () => api(`/admin/users/${userId}/restrictions`, { method: 'POST', body: { type, reason: reason.trim(), ...(hours ? { durationHours: Number(hours) } : {}) } }),
      `${name} is now ${type === 'muted' ? 'muted' : 'suspended'}.`,
    );
    if (good) { setOpen(false); setReason(''); }
  };
  const lift = (r: RestrictionSummary) => act(() => api(`/admin/restrictions/${r.id}/lift`, { method: 'POST', body: {} }), `${LABEL[r.type]} lifted for ${name}.`);

  const active = [restrictions.suspended, restrictions.muted].filter((r): r is RestrictionSummary => !!r);
  return (
    <div className="stack restriction-controls">
      {active.map((r) => (
        <div key={r.id} className="row">
          <Badge accent>{LABEL[r.type]}</Badge>
          <span className="small muted">{untilText(r.expiresAt)}. {r.reason}</span>
          <Button small variant="ghost" disabled={busy} aria-label={`Lift ${r.type === 'muted' ? 'mute' : 'suspension'} for ${name}`} onClick={() => lift(r)}>Lift</Button>
        </div>
      ))}
      {!open && <div><Button small variant="ghost" aria-label={`Restrict ${name}`} onClick={() => { setOpen(true); setError(''); }}>Restrict…</Button></div>}
      {open && (
        <form className="chat-form stack" onSubmit={submit} aria-label={`Restrict ${name}`}>
          <div className="form-grid">
            <div className="field">
              <label htmlFor={`rt-${userId}`}>Restriction</label>
              <select id={`rt-${userId}`} className="input" value={type} onChange={(e) => setType(e.target.value as 'muted' | 'suspended')}>
                <option value="muted">Mute: can read, cannot post</option>
                <option value="suspended">Suspend: blocks the whole account</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor={`rd-${userId}`}>Duration</label>
              <select id={`rd-${userId}`} className="input" value={hours} onChange={(e) => setHours(e.target.value)}>
                {DURATIONS.map((d) => <option key={d.label} value={d.hours ?? ''}>{d.label}</option>)}
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor={`rr-${userId}`}>Reason (the member will see this)</label>
            <input id={`rr-${userId}`} className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="row">
            <Button small type="submit" loading={busy}>{type === 'muted' ? 'Mute member' : 'Suspend account'}</Button>
            <Button small type="button" variant="ghost" disabled={busy} onClick={() => { setOpen(false); setError(''); }}>Cancel</Button>
          </div>
        </form>
      )}
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
