import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { Alert, Button, Card, Field } from '../components/ui';

export default function Settings() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  const [errs, setErrs] = useState<Record<string, string>>({});

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const currentPassword = String(fd.get('currentPassword') ?? '');
    const newPassword = String(fd.get('newPassword') ?? '');
    const confirm = String(fd.get('confirm') ?? '');
    const next: Record<string, string> = {};
    if (!currentPassword) next.currentPassword = 'Enter your current password';
    if (newPassword.length < 10) next.newPassword = 'Use at least 10 characters';
    else if (newPassword !== confirm) next.confirm = 'Passwords do not match';
    setErrs(next); setMsg(undefined);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      await api('/me/password', { method: 'POST', body: { currentPassword, newPassword } });
      form.reset();
      setMsg({ kind: 'success', text: 'Password changed. Other devices have been signed out.' });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_PASSWORD') setErrs({ currentPassword: err.message });
      else setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not change password.' });
    } finally { setBusy(false); }
  };

  return (
    <div className="stack">
      <div className="page-head"><h1>Account settings</h1></div>
      <Card title="Change password">
        <form className="stack" onSubmit={submit} noValidate style={{ maxWidth: 420 }}>
          {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
          <Field label="Current password" name="currentPassword" type="password" autoComplete="current-password" error={errs.currentPassword} />
          <Field label="New password" name="newPassword" type="password" autoComplete="new-password" hint="At least 10 characters" error={errs.newPassword} />
          <Field label="Confirm new password" name="confirm" type="password" autoComplete="new-password" error={errs.confirm} />
          <Button type="submit" loading={busy}>Update password</Button>
        </form>
      </Card>
    </div>
  );
}
