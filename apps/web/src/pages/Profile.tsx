import { useState, type FormEvent } from 'react';
import { useAuth, type User } from '../auth/AuthContext';
import { api, ApiError } from '../lib/api';
import { Alert, Badge, Button, Card, Field } from '../components/ui';

const LEVELS = ['beginner', 'intermediate', 'advanced', 'professional'];

export default function Profile() {
  const { user, setUser } = useAuth();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  const [errs, setErrs] = useState<Record<string, string>>({});
  if (!user) return null;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const displayName = String(fd.get('displayName') ?? '').trim();
    const assets = String(fd.get('preferredAssets') ?? '').split(/[\s,]+/).map((a) => a.trim()).filter(Boolean);
    setMsg(undefined);
    if (displayName.length < 2) return setErrs({ displayName: 'Enter at least 2 characters' });
    if (assets.length > 10) return setErrs({ preferredAssets: 'Choose up to 10 assets' });
    setErrs({});
    setBusy(true);
    try {
      const r = await api<{ user: User }>('/me', {
        method: 'PATCH',
        body: {
          displayName,
          country: String(fd.get('country') ?? '').trim(),
          tradingExperience: String(fd.get('tradingExperience') ?? '') || null,
          preferredAssets: assets,
          notificationPrefs: { newSignals: fd.get('newSignals') === 'on', signalUpdates: fd.get('signalUpdates') === 'on', announcements: fd.get('announcements') === 'on' },
        },
      });
      setUser(r.user);
      setMsg({ kind: 'success', text: 'Profile saved.' });
    } catch (err) {
      if (err instanceof ApiError && err.details) setErrs(err.details);
      setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not save your profile.' });
    } finally { setBusy(false); }
  };

  const p = user.notificationPrefs;
  return (
    <div className="stack">
      <div className="page-head"><h1>Profile</h1></div>
      <Card title="Account">
        <p><span className="muted">Email:</span> {user.email}</p>
        <p><span className="muted">Plan:</span> <Badge accent>{user.access.premium ? 'Premium' : 'Free'}</Badge></p>
        <p style={{ marginBottom: 0 }}><span className="muted">Member since:</span> {new Date(user.createdAt).toLocaleDateString()}</p>
      </Card>
      <Card title="Your details">
        <form className="stack" onSubmit={submit} noValidate style={{ maxWidth: 520 }}>
          {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
          <Field label="Name" name="displayName" defaultValue={user.displayName} error={errs.displayName} />
          <Field label="Country" name="country" defaultValue={user.country ?? ''} autoComplete="country-name" error={errs.country} />
          <div className="field">
            <label htmlFor="exp">Trading experience</label>
            <select id="exp" name="tradingExperience" className="input" defaultValue={user.tradingExperience ?? ''}>
              <option value="">Prefer not to say</option>
              {LEVELS.map((l) => <option key={l} value={l}>{l[0]!.toUpperCase() + l.slice(1)}</option>)}
            </select>
          </div>
          <Field label="Preferred assets" name="preferredAssets" defaultValue={user.preferredAssets.join(', ')} hint="Comma-separated, e.g. XAUUSD, EURUSD, BTCUSD" error={errs.preferredAssets} />
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="card-title">Notifications</legend>
            <label className="check"><input type="checkbox" name="newSignals" defaultChecked={p.newSignals} /> New signals</label>
            <label className="check"><input type="checkbox" name="signalUpdates" defaultChecked={p.signalUpdates} /> Signal updates and results</label>
            <label className="check"><input type="checkbox" name="announcements" defaultChecked={p.announcements} /> Announcements</label>
            <p className="field-hint">Your choices are saved now; delivery will be switched on in a later release.</p>
          </fieldset>
          <Button type="submit" loading={busy}>Save changes</Button>
        </form>
      </Card>
    </div>
  );
}
