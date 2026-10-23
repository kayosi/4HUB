import { useState, type FormEvent } from 'react';
import { useAuth, type User } from '../auth/AuthContext';
import { api, ApiError } from '../lib/api';
import { Alert, Badge, Button, Card, Field } from '../components/ui';

export default function Profile() {
  const { user, setUser } = useAuth();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  const [fieldErr, setFieldErr] = useState<string>();
  if (!user) return null;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const displayName = String(new FormData(e.currentTarget).get('displayName') ?? '').trim();
    setMsg(undefined);
    if (displayName.length < 2) return setFieldErr('Enter at least 2 characters');
    setFieldErr(undefined);
    setBusy(true);
    try {
      setUser((await api<{ user: User }>('/me', { method: 'PATCH', body: { displayName } })).user);
      setMsg({ kind: 'success', text: 'Profile updated.' });
    } catch (err) {
      setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not update profile.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="page-head"><h1>Profile</h1></div>
      <Card title="Account">
        <p><span className="muted">Email:</span> {user.email}</p>
        <p><span className="muted">Role:</span> <Badge accent>{user.role}</Badge></p>
        <p><span className="muted">Member since:</span> {new Date(user.createdAt).toLocaleDateString()}</p>
      </Card>
      <Card title="Edit profile">
        <form className="stack" onSubmit={submit} noValidate style={{ maxWidth: 420 }}>
          {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
          <Field label="Display name" name="displayName" defaultValue={user.displayName} error={fieldErr} />
          <Button type="submit" loading={busy}>Save changes</Button>
        </form>
      </Card>
    </div>
  );
}
