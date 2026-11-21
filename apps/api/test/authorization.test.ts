import { describe, expect, it } from 'vitest';
import { makeApp, ROLES as roles, setup, type TestRole as Role } from './helpers.js';

// url -> roles that may access it. Anyone else must get 403; visitors must get 401.
const matrix: Record<string, Role[]> = {
  '/api/member/overview': ['free', 'premium', 'moderator', 'admin'],
  '/api/member/premium': ['premium', 'moderator', 'admin'],
  '/api/moderation/overview': ['moderator', 'admin'],
  '/api/moderation/reports': ['moderator', 'admin'],
  '/api/notifications': ['free', 'premium', 'moderator', 'admin'],
  '/api/notifications/unread-count': ['free', 'premium', 'moderator', 'admin'],
  '/api/admin/overview': ['admin'],
  '/api/admin/announcements': ['admin'],
  '/api/admin/users': ['admin'],
};

describe('server-side authorization matrix', () => {
  it('returns 401 to visitors on every protected route', async () => {
    const { app } = await makeApp();
    for (const url of Object.keys(matrix)) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
  });

  it('allows and denies each role exactly as specified', async () => {
    const { app, cookies } = await setup();
    for (const role of roles) {
      const cookie = cookies[role];
      for (const [url, allowed] of Object.entries(matrix)) {
        const res = await app.inject({ method: 'GET', url, headers: { cookie } });
        expect(res.statusCode, `${role} -> ${url}`).toBe(allowed.includes(role) ? 200 : 403);
      }
    }
  });

  it('serves health publicly and unknown routes as JSON 404', async () => {
    const { app } = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({ status: 'ok' });
    const nf = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(nf.statusCode).toBe(404);
    expect(nf.json().error.code).toBe('NOT_FOUND');
  });

  it('does not leak internals in unexpected errors', async () => {
    const { app } = await makeApp();
    app.get('/api/boom', async () => {
      throw new Error('secret database detail');
    });
    const res = await app.inject({ method: 'GET', url: '/api/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toMatch(/secret/);
  });
});
