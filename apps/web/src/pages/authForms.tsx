import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { api, ApiError } from '../lib/api';
import { Alert, Button, Card, Field } from '../components/ui';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function useForm() {
  const [error, setError] = useState<string>();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown) => {
    if (e instanceof ApiError) {
      setError(e.details ? undefined : e.message);
      setFields(e.details ?? {});
    } else setError('Something went wrong. Please try again.');
  };
  return { error, setError, fields, setFields, busy, setBusy, fail };
}

const read = (e: FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;

export function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const f = useForm();
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = read(e);
    const errs: Record<string, string> = {};
    if (!EMAIL_RE.test(v.email ?? '')) errs.email = 'Enter a valid email address';
    if (!v.password) errs.password = 'Enter your password';
    f.setFields(errs);
    f.setError(undefined);
    if (Object.keys(errs).length) return;
    f.setBusy(true);
    try {
      await login(v.email!, v.password!);
      nav((loc.state as { from?: string } | null)?.from ?? '/dashboard', { replace: true });
    } catch (err) {
      f.fail(err);
    } finally {
      f.setBusy(false);
    }
  };
  return (
    <div className="container page page-narrow">
      <Card>
        <h1 style={{ fontSize: '1.6rem' }}>Log in</h1>
        <form className="stack" onSubmit={submit} noValidate>
          {f.error && <Alert>{f.error}</Alert>}
          <Field label="Email" name="email" type="email" autoComplete="email" error={f.fields.email} />
          <Field label="Password" name="password" type="password" autoComplete="current-password" error={f.fields.password} />
          <Button type="submit" block loading={f.busy}>Log in</Button>
        </form>
        <p className="muted" style={{ marginTop: 16 }}>
          <Link to="/forgot-password">Forgot password?</Link> · <Link to="/register">Create account</Link>
        </p>
      </Card>
    </div>
  );
}

export function Register() {
  const { register } = useAuth();
  const nav = useNavigate();
  const f = useForm();
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = read(e);
    const errs: Record<string, string> = {};
    if ((v.displayName ?? '').trim().length < 2) errs.displayName = 'Enter at least 2 characters';
    if (!EMAIL_RE.test(v.email ?? '')) errs.email = 'Enter a valid email address';
    if ((v.password ?? '').length < 10) errs.password = 'Use at least 10 characters';
    f.setFields(errs);
    f.setError(undefined);
    if (Object.keys(errs).length) return;
    f.setBusy(true);
    try {
      await register(v.displayName!, v.email!, v.password!);
      nav('/dashboard', { replace: true });
    } catch (err) {
      f.fail(err);
    } finally {
      f.setBusy(false);
    }
  };
  return (
    <div className="container page page-narrow">
      <Card>
        <h1 style={{ fontSize: '1.6rem' }}>Create your account</h1>
        <form className="stack" onSubmit={submit} noValidate>
          {f.error && <Alert>{f.error}</Alert>}
          <Field label="Display name" name="displayName" autoComplete="nickname" error={f.fields.displayName} />
          <Field label="Email" name="email" type="email" autoComplete="email" error={f.fields.email} />
          <Field label="Password" name="password" type="password" autoComplete="new-password" hint="At least 10 characters" error={f.fields.password} />
          <Button type="submit" block loading={f.busy}>Create account</Button>
        </form>
        <p className="muted" style={{ marginTop: 16 }}>Already a member? <Link to="/login">Log in</Link></p>
      </Card>
    </div>
  );
}

export function ForgotPassword() {
  const f = useForm();
  const [sent, setSent] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const { email } = read(e);
    if (!EMAIL_RE.test(email ?? '')) return f.setFields({ email: 'Enter a valid email address' });
    f.setFields({});
    f.setBusy(true);
    try {
      await api('/auth/password-reset/request', { method: 'POST', body: { email } });
      setSent(true);
    } catch (err) {
      f.fail(err);
    } finally {
      f.setBusy(false);
    }
  };
  return (
    <div className="container page page-narrow">
      <Card>
        <h1 style={{ fontSize: '1.6rem' }}>Reset password</h1>
        {sent ? (
          <Alert kind="success">If an account exists for that email, a reset link has been sent.</Alert>
        ) : (
          <form className="stack" onSubmit={submit} noValidate>
            {f.error && <Alert>{f.error}</Alert>}
            <Field label="Email" name="email" type="email" autoComplete="email" error={f.fields.email} />
            <Button type="submit" block loading={f.busy}>Send reset link</Button>
          </form>
        )}
        <p className="muted" style={{ marginTop: 16 }}><Link to="/login">Back to log in</Link></p>
      </Card>
    </div>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const f = useForm();
  const [done, setDone] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const { password } = read(e);
    if ((password ?? '').length < 10) return f.setFields({ password: 'Use at least 10 characters' });
    f.setFields({});
    f.setError(undefined);
    f.setBusy(true);
    try {
      await api('/auth/password-reset/confirm', { method: 'POST', body: { token, password } });
      setDone(true);
    } catch (err) {
      f.fail(err);
    } finally {
      f.setBusy(false);
    }
  };
  return (
    <div className="container page page-narrow">
      <Card>
        <h1 style={{ fontSize: '1.6rem' }}>Choose a new password</h1>
        {!token ? (
          <Alert>This reset link is missing its token. Request a new one.</Alert>
        ) : done ? (
          <Alert kind="success">Password updated. <Link to="/login">Log in</Link> with your new password.</Alert>
        ) : (
          <form className="stack" onSubmit={submit} noValidate>
            {f.error && <Alert>{f.error}</Alert>}
            <Field label="New password" name="password" type="password" autoComplete="new-password" hint="At least 10 characters" error={f.fields.password} />
            <Button type="submit" block loading={f.busy}>Update password</Button>
          </form>
        )}
      </Card>
    </div>
  );
}
