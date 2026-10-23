import { describe, expect, it } from 'vitest';
import { makeApp, PASSWORD, seedUser, loginCookie } from './helpers.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { hashToken } from '../src/auth/tokens.js';

describe('password hashing', () => {
  it('uses argon2id and verifies correctly', async () => {
    const h = await hashPassword('s3cret-passphrase');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(h, 's3cret-passphrase')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
    expect(await verifyPassword('garbage', 'x')).toBe(false);
  });
  it('hashes tokens deterministically', () => {
    expect(hashToken('a')).toBe(hashToken('a'));
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});

describe('registration', () => {
  it('creates a free member, sets an httpOnly session cookie and never returns the hash', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'New@Example.com', password: PASSWORD, displayName: 'New User' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user).toMatchObject({ email: 'new@example.com', role: 'free' });
    expect(JSON.stringify(body)).not.toMatch(/password/i);
    expect(res.cookies[0]).toMatchObject({ name: '4hub_session', httpOnly: true, sameSite: 'Lax' });
  });

  it('ignores a client-supplied role (no privilege escalation)', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@example.com', password: PASSWORD, displayName: 'Mallory', role: 'admin' },
    });
    expect(res.json().user.role).toBe('free');
  });

  it('validates input and rejects duplicates', async () => {
    const { app } = await makeApp();
    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'nope', password: 'short', displayName: 'x' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('BAD_REQUEST');

    const payload = { email: 'dup@example.com', password: PASSWORD, displayName: 'Dup' };
    await app.inject({ method: 'POST', url: '/api/auth/register', payload });
    const dup = await app.inject({ method: 'POST', url: '/api/auth/register', payload });
    expect(dup.statusCode).toBe(409);
  });
});

describe('login / session / logout', () => {
  it('logs in, resolves /me, and logout invalidates the session', async () => {
    const { app, db } = await makeApp();
    await seedUser(db, 'free');
    const cookie = await loginCookie(app, 'free@example.com');

    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('free@example.com');

    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(204);
    const after = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('returns the same generic error for wrong password and unknown email', async () => {
    const { app, db } = await makeApp();
    await seedUser(db, 'free');
    const a = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'free@example.com', password: 'wrong-password-1' } });
    const b = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ghost@example.com', password: 'wrong-password-1' } });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json()).toEqual(b.json());
  });

  it('rejects requests without a session or with a forged one', async () => {
    const { app } = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    const forged = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: '4hub_session=forged' } });
    expect(forged.statusCode).toBe(401);
  });

  it('rejects cross-origin state-changing requests', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://evil.example' },
      payload: { email: 'a@example.com', password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('password reset', () => {
  it('does not reveal whether an email exists', async () => {
    const { app, db, resetTokens } = await makeApp();
    await seedUser(db, 'free');
    const known = await app.inject({ method: 'POST', url: '/api/auth/password-reset/request', payload: { email: 'free@example.com' } });
    const unknown = await app.inject({ method: 'POST', url: '/api/auth/password-reset/request', payload: { email: 'ghost@example.com' } });
    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(resetTokens['free@example.com']).toBeTruthy();
    expect(resetTokens['ghost@example.com']).toBeUndefined();
  });

  it('resets the password once, signs out other sessions, and rejects token reuse', async () => {
    const { app, db, resetTokens } = await makeApp();
    await seedUser(db, 'free');
    const oldCookie = await loginCookie(app, 'free@example.com');
    await app.inject({ method: 'POST', url: '/api/auth/password-reset/request', payload: { email: 'free@example.com' } });
    const token = resetTokens['free@example.com']!;

    const ok = await app.inject({ method: 'POST', url: '/api/auth/password-reset/confirm', payload: { token, password: 'brand-new-password' } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: oldCookie } })).statusCode).toBe(401);

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'free@example.com', password: 'brand-new-password' } });
    expect(login.statusCode).toBe(200);

    const reuse = await app.inject({ method: 'POST', url: '/api/auth/password-reset/confirm', payload: { token, password: 'another-new-password' } });
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json().error.code).toBe('INVALID_TOKEN');
  });
});

describe('profile', () => {
  it('updates the display name with validation', async () => {
    const { app, db } = await makeApp();
    await seedUser(db, 'free');
    const cookie = await loginCookie(app, 'free@example.com');
    const ok = await app.inject({ method: 'PATCH', url: '/api/me', headers: { cookie }, payload: { displayName: 'Renamed' } });
    expect(ok.json().user.displayName).toBe('Renamed');
    const bad = await app.inject({ method: 'PATCH', url: '/api/me', headers: { cookie }, payload: { displayName: '' } });
    expect(bad.statusCode).toBe(400);
  });
});
