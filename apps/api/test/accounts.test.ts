import { describe, expect, it } from 'vitest';
import { createSignal, get, loginCookie, PASSWORD, send, setup } from './helpers.js';

describe('member profile', () => {
  it('returns the profile fields with sensible defaults', async () => {
    const ctx = await setup();
    const u = (await get(ctx, '/api/me', ctx.cookies.free)).json().user;
    expect(u).toMatchObject({ country: null, tradingExperience: null, preferredAssets: [], notificationPrefs: { newSignals: true, signalUpdates: true, announcements: false } });
    expect(u).not.toHaveProperty('password_hash');
    expect(JSON.stringify(u)).not.toMatch(/password/i);
  });

  it('updates name, country, experience, preferred assets and notification preferences', async () => {
    const ctx = await setup();
    const res = await send(ctx, 'PATCH', '/api/me', ctx.cookies.free, {
      displayName: 'Ada Trader', country: 'Kenya', tradingExperience: 'intermediate',
      preferredAssets: ['xauusd', 'EURUSD', 'XAUUSD', ' btc/usd '],
      notificationPrefs: { newSignals: false, signalUpdates: true, announcements: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({
      displayName: 'Ada Trader', country: 'Kenya', tradingExperience: 'intermediate',
      preferredAssets: ['XAUUSD', 'EURUSD', 'BTC/USD'], // normalised and de-duplicated
      notificationPrefs: { newSignals: false, signalUpdates: true, announcements: true },
    });
    expect((await get(ctx, '/api/me', ctx.cookies.free)).json().user.country).toBe('Kenya'); // persisted
  });

  it('supports partial updates and clearing optional fields', async () => {
    const ctx = await setup();
    await send(ctx, 'PATCH', '/api/me', ctx.cookies.free, { country: 'Kenya', tradingExperience: 'advanced' });
    const res = await send(ctx, 'PATCH', '/api/me', ctx.cookies.free, { country: '', tradingExperience: null });
    expect(res.json().user).toMatchObject({ country: null, tradingExperience: null, displayName: 'free user' });
  });

  it.each([
    ['empty body', {}],
    ['short name', { displayName: 'x' }],
    ['unknown experience level', { tradingExperience: 'guru' }],
    ['too many assets', { preferredAssets: Array.from({ length: 11 }, (_, i) => `ASSET${i}`) }],
    ['invalid asset', { preferredAssets: ['<script>'] }],
    ['non-boolean notification flag', { notificationPrefs: { newSignals: 'yes', signalUpdates: true, announcements: true } }],
    ['incomplete notification prefs', { notificationPrefs: { newSignals: true } }],
  ])('rejects %s', async (_n, payload) => {
    const ctx = await setup();
    expect((await send(ctx, 'PATCH', '/api/me', ctx.cookies.free, payload)).statusCode).toBe(400);
  });

  it('cannot be used to change role, email or other protected fields', async () => {
    const ctx = await setup();
    const res = await send(ctx, 'PATCH', '/api/me', ctx.cookies.free, { displayName: 'Still Free', role: 'admin', email: 'evil@example.com' });
    expect(res.json().user).toMatchObject({ role: 'free', email: 'free@example.com', displayName: 'Still Free' });
    expect((await get(ctx, '/api/admin/overview', ctx.cookies.free)).statusCode).toBe(403);
  });

  it('requires authentication', async () => {
    const ctx = await setup();
    expect((await send(ctx, 'PATCH', '/api/me', undefined, { displayName: 'Nope' })).statusCode).toBe(401);
  });
});

describe('account settings: password change', () => {
  const change = (ctx: Awaited<ReturnType<typeof setup>>, cookie: string, payload: unknown) => send(ctx, 'POST', '/api/me/password', cookie, payload);

  it('changes the password, keeps this session, signs out other devices and invalidates the old password', async () => {
    const ctx = await setup();
    const other = await loginCookie(ctx.app, 'free@example.com'); // second device
    const res = await change(ctx, ctx.cookies.free, { currentPassword: PASSWORD, newPassword: 'a-brand-new-passphrase' });
    expect(res.statusCode).toBe(200);
    expect((await get(ctx, '/api/me', ctx.cookies.free)).statusCode).toBe(200);
    expect((await get(ctx, '/api/me', other)).statusCode).toBe(401);
    const oldLogin = await send(ctx, 'POST', '/api/auth/login', undefined, { email: 'free@example.com', password: PASSWORD });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await send(ctx, 'POST', '/api/auth/login', undefined, { email: 'free@example.com', password: 'a-brand-new-passphrase' });
    expect(newLogin.statusCode).toBe(200);
  });

  it('rejects a wrong current password (400, not 401) and weak new passwords', async () => {
    const ctx = await setup();
    const wrong = await change(ctx, ctx.cookies.free, { currentPassword: 'nope-nope-nope', newPassword: 'a-brand-new-passphrase' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('INVALID_PASSWORD');
    expect((await change(ctx, ctx.cookies.free, { currentPassword: PASSWORD, newPassword: 'short' })).statusCode).toBe(400);
    expect((await get(ctx, '/api/me', ctx.cookies.free)).statusCode).toBe(200); // session unaffected
  });

  it('requires authentication', async () => {
    const ctx = await setup();
    expect((await send(ctx, 'POST', '/api/me/password', undefined, { currentPassword: PASSWORD, newPassword: 'a-brand-new-passphrase' })).statusCode).toBe(401);
  });
});

describe('admin user management', () => {
  it('only admins can list users or change roles', async () => {
    const ctx = await setup();
    for (const role of ['free', 'premium', 'moderator'] as const) {
      expect((await get(ctx, '/api/admin/users', ctx.cookies[role])).statusCode).toBe(403);
      expect((await send(ctx, 'PATCH', `/api/admin/users/${ctx.users.free.id}/role`, ctx.cookies[role], { role: 'admin' })).statusCode).toBe(403);
    }
  });

  it('changes roles, rejects invalid roles, self-changes and unknown users', async () => {
    const ctx = await setup();
    const url = (id: string) => `/api/admin/users/${id}/role`;
    const ok = await send(ctx, 'PATCH', url(ctx.users.free.id), ctx.cookies.admin, { role: 'moderator' });
    expect(ok.json().user).toMatchObject({ role: 'moderator' });
    expect((await get(ctx, '/api/admin/overview', ctx.cookies.free)).statusCode).toBe(403); // moderator is not admin
    expect((await get(ctx, '/api/moderation/overview', ctx.cookies.free)).statusCode).toBe(200);
    expect((await send(ctx, 'PATCH', url(ctx.users.free.id), ctx.cookies.admin, { role: 'superuser' })).statusCode).toBe(400);
    expect((await send(ctx, 'PATCH', url(ctx.users.admin.id), ctx.cookies.admin, { role: 'free' })).statusCode).toBe(400);
    expect((await send(ctx, 'PATCH', url('00000000-0000-4000-8000-000000000000'), ctx.cookies.admin, { role: 'free' })).statusCode).toBe(404);
    expect((await send(ctx, 'PATCH', url('nope'), ctx.cookies.admin, { role: 'free' })).statusCode).toBe(404);
  });

  it('the admin user list exposes only account basics, not profile details', async () => {
    const ctx = await setup();
    await send(ctx, 'PATCH', '/api/me', ctx.cookies.free, { country: 'Kenya', preferredAssets: ['XAUUSD'] });
    const res = await get(ctx, '/api/admin/users', ctx.cookies.admin);
    expect(res.body).not.toContain('Kenya');
    expect(res.json().users[0]).not.toHaveProperty('country');
  });

  it('end-to-end: a promoted member can open a premium signal', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    expect((await get(ctx, `/api/signals/${sig.id}`, ctx.cookies.free)).json().signal.locked).toBe(true);
    await send(ctx, 'PATCH', `/api/admin/users/${ctx.users.free.id}/role`, ctx.cookies.admin, { role: 'premium' });
    expect((await get(ctx, `/api/signals/${sig.id}`, ctx.cookies.free)).json().signal.locked).toBe(false);
  });
});
