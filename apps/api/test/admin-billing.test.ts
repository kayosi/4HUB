import { describe, expect, it } from 'vitest';
import { addDays, subscriptionState } from '../src/billing/subscriptions.js';
import { countRows, get, loginCookie, pay, row, send, seedUser, setup, startPayment, type Ctx } from './helpers.js';

const members = async (ctx: Ctx, n: number) => {
  const out: { id: string; cookie: string }[] = [];
  for (let i = 0; i < n; i++) {
    const u = await seedUser(ctx.db, 'free', `member${i}@example.com`);
    out.push({ id: u.id, cookie: await loginCookie(ctx.app, `member${i}@example.com`) });
  }
  return out;
};
const summary = async (ctx: Ctx, q = '') => (await get(ctx, `/api/admin/billing/summary${q}`, ctx.cookies.admin)).json();

describe('admin billing dashboard', () => {
  async function scenario() {
    const ctx = await setup();
    const [m1, m2, m3, m4] = await members(ctx, 4);
    const a = await pay(ctx, m1!.cookie, 'premium_monthly'); // 150,000
    const b = await pay(ctx, m2!.cookie, 'premium_yearly'); // 1,400,000
    await pay(ctx, m3!.cookie, 'premium_monthly', 'failed');
    await startPayment(ctx, m4!.cookie, 'premium_quarterly'); // pending
    const refund = (id: string, body: object) => send(ctx, 'POST', `/api/admin/payments/${id}/refund`, ctx.cookies.admin, body);
    expect((await refund(a.id, { reason: 'customer request' })).statusCode).toBe(200); // full
    expect((await refund(b.id, { amountMinor: 100000, reason: 'goodwill' })).statusCode).toBe(200); // partial
    return { ctx, m: [m1!, m2!, m3!, m4!], a, b };
  }

  it('reports revenue net of refunds, payment counts, refunds, subscribers and a per-plan breakdown', async () => {
    const { ctx } = await scenario();
    const s = await summary(ctx);
    expect(s.revenue).toEqual([{ currency: 'KES', grossMinor: 1550000, refundedMinor: 250000, netMinor: 1300000, payments: 2 }]);
    expect(s.payments).toEqual({ succeeded: 2, failed: 1, cancelled: 0, pending: 1 });
    expect(s.refunds.count).toBe(2);
    // fixture premium (granted) + m2 are active; m1 was fully refunded so its access was revoked
    expect(s.subscribers).toEqual({ active: 2, grace: 0, expired: 0, cancelled: 1, withAccess: 2 });
    expect(s.breakdown).toEqual([
      { planCode: 'premium_monthly', planName: 'Premium Monthly', tier: 'premium', subscribers: 1 },
      { planCode: 'premium_yearly', planName: 'Premium Yearly', tier: 'premium', subscribers: 1 },
    ]);
  });

  it('lists recent transactions newest first with the member and status', async () => {
    const { ctx } = await scenario();
    const s = await summary(ctx);
    expect(s.recent).toHaveLength(4);
    expect(s.recent[0]).toMatchObject({ planCode: 'premium_quarterly', status: 'pending', userEmail: 'member3@example.com' });
    expect(s.recent.map((r: { status: string }) => r.status).sort()).toEqual(['failed', 'partially_refunded', 'pending', 'refunded']);
    expect(JSON.stringify(s.recent)).not.toMatch(/password/i);
  });

  it('filters revenue by date range', async () => {
    const { ctx } = await scenario();
    expect((await summary(ctx, '?from=2100-01-01')).revenue).toEqual([]);
    expect((await summary(ctx, '?to=2000-01-01')).revenue).toEqual([]);
    expect((await summary(ctx, '?from=2000-01-01&to=2100-01-01')).revenue[0].grossMinor).toBe(1550000);
    expect((await get(ctx, '/api/admin/billing/summary?from=yesterday', ctx.cookies.admin)).statusCode).toBe(400);
  });

  it('lists and filters transactions with pagination', async () => {
    const { ctx } = await scenario();
    const all = (await get(ctx, '/api/admin/billing/transactions', ctx.cookies.admin)).json().transactions;
    expect(all).toHaveLength(4);
    const failed = (await get(ctx, '/api/admin/billing/transactions?status=failed', ctx.cookies.admin)).json().transactions;
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ status: 'failed', userEmail: 'member2@example.com' });
    expect((await get(ctx, '/api/admin/billing/transactions?limit=1&offset=1', ctx.cookies.admin)).json().transactions).toHaveLength(1);
    expect((await get(ctx, '/api/admin/billing/transactions?status=bogus', ctx.cookies.admin)).statusCode).toBe(400);
  });

  it('counts expired and grace subscribers as time passes', async () => {
    const { ctx } = await scenario();
    ctx.clock.advanceDays(31); // monthly grants lapse into grace
    let s = await summary(ctx);
    expect(s.subscribers).toMatchObject({ active: 1, grace: 1, withAccess: 2 }); // yearly active; fixture in grace
    ctx.clock.advanceDays(5);
    s = await summary(ctx);
    expect(s.subscribers).toMatchObject({ active: 1, grace: 0, expired: 1, withAccess: 1 });
    expect(s.breakdown.map((b: { planCode: string }) => b.planCode)).toEqual(['premium_yearly']);
  });

  it('every billing admin endpoint is closed to visitors, free, premium and moderators', async () => {
    const ctx = await setup();
    const p = await pay(ctx, ctx.cookies.free);
    const uid = ctx.users.free.id;
    const calls: [string, string, unknown?][] = [
      ['GET', '/api/admin/plans'], ['POST', '/api/admin/plans', {}], ['PATCH', '/api/admin/plans/00000000-0000-4000-8000-000000000000', { name: 'xx' }],
      ['GET', '/api/admin/billing/summary'], ['GET', '/api/admin/billing/transactions'],
      ['POST', `/api/admin/payments/${p.id}/refund`, { reason: 'abc' }], ['GET', `/api/admin/users/${uid}/subscription`],
      ['POST', `/api/admin/users/${uid}/subscription/grant`, { planCode: 'premium_monthly', reason: 'abc' }],
      ['POST', `/api/admin/users/${uid}/subscription/revoke`, { reason: 'abc' }],
    ];
    const call = (m: string, u: string, cookie: string | undefined, body: unknown) =>
      ctx.app.inject({ method: m as 'GET' | 'POST' | 'PATCH', url: u, headers: cookie ? { cookie } : {}, ...(body !== undefined ? { payload: body as object } : {}) });
    for (const [m, u, body] of calls) {
      expect((await call(m, u, undefined, body)).statusCode, `visitor ${m} ${u}`).toBe(401);
      for (const r of ['free', 'premium', 'moderator'] as const) expect((await call(m, u, ctx.cookies[r], body)).statusCode, `${r} ${m} ${u}`).toBe(403);
    }
  });
});

describe('admin: grants, revocations and recorded refunds', () => {
  it('grants complimentary premium for a plan (or custom days), audits it, and validates input', async () => {
    const ctx = await setup();
    const uid = ctx.users.free.id;
    const grant = (body: object, id = uid) => send(ctx, 'POST', `/api/admin/users/${id}/subscription/grant`, ctx.cookies.admin, body);
    expect((await grant({ planCode: 'premium_monthly', days: 7, reason: 'support goodwill' })).statusCode).toBe(204);
    const s = (await get(ctx, `/api/admin/users/${uid}/subscription`, ctx.cookies.admin)).json().subscriptions[0];
    expect(s).toMatchObject({ status: 'active', source: 'admin_grant', daysLeft: 7 });
    const [a] = await row<{ actor_id: string; data: { reason: string; days: number } }>(ctx, "select actor_id, data from audit_log where action = 'subscription.granted' order by created_at desc");
    expect(a).toMatchObject({ actor_id: ctx.users.admin.id, data: { reason: 'support goodwill', days: 7 } });

    for (const body of [{ planCode: 'free', reason: 'abc' }, { planCode: 'nope', reason: 'abc' }, { planCode: 'premium_monthly' }, { planCode: 'premium_monthly', reason: 'x' }, { planCode: 'premium_monthly', reason: 'abc', days: 0 }, { planCode: 'premium_monthly', reason: 'abc', days: 99999 }, { planCode: 'premium_monthly', reason: 'abc', extra: 1 }]) {
      expect((await grant(body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await grant({ planCode: 'premium_monthly', reason: 'abc' }, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await grant({ planCode: 'premium_monthly', reason: 'abc' }, 'nope')).statusCode).toBe(404);
  });

  it('revokes access with a mandatory reason; revoking a member without a subscription is a 404', async () => {
    const ctx = await setup();
    const url = (id: string) => `/api/admin/users/${id}/subscription/revoke`;
    expect((await send(ctx, 'POST', url(ctx.users.premium.id), ctx.cookies.admin, {})).statusCode).toBe(400);
    expect((await send(ctx, 'POST', url(ctx.users.premium.id), ctx.cookies.admin, { reason: 'abuse of sharing' })).statusCode).toBe(204);
    expect((await get(ctx, '/api/me', ctx.cookies.premium)).json().user.access.premium).toBe(false);
    expect((await send(ctx, 'POST', url(ctx.users.free.id), ctx.cookies.admin, { reason: 'abc' })).statusCode).toBe(404);
    expect(await countRows(ctx, 'audit_log', "action = 'subscription.revoked'")).toBe(1);
  });

  it('records refunds issued outside 4HUB: amount is capped, double refunds and unpaid payments are refused, all audited', async () => {
    const ctx = await setup();
    const paid = await pay(ctx, ctx.cookies.free);
    const pending = await startPayment(ctx, ctx.cookies.premium);
    const refund = (id: string, body: object) => send(ctx, 'POST', `/api/admin/payments/${id}/refund`, ctx.cookies.admin, body);

    expect((await refund(paid.id, { reason: '' })).statusCode).toBe(400);
    expect((await refund(paid.id, { amountMinor: -5, reason: 'abc' })).statusCode).toBe(400);
    expect((await refund(pending.id, { reason: 'not paid yet' })).statusCode).toBe(409);
    expect((await refund('00000000-0000-4000-8000-000000000000', { reason: 'abc' })).statusCode).toBe(404);

    expect((await refund(paid.id, { amountMinor: 50000, reason: 'partial' })).json().payment).toMatchObject({ status: 'partially_refunded', refundedMinor: 50000 });
    // asking for more than remains is capped, which completes the refund
    expect((await refund(paid.id, { amountMinor: 999999, reason: 'rest' })).json().payment).toMatchObject({ status: 'refunded', refundedMinor: 150000 });
    expect((await refund(paid.id, { reason: 'again' })).statusCode).toBe(409);
    const audits = await row<{ actor_id: string }>(ctx, "select actor_id from audit_log where action = 'payment.refunded'");
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.actor_id === ctx.users.admin.id)).toBe(true);
  });

  it('the admin user list marks who holds a paid subscription, without exposing profile data', async () => {
    const ctx = await setup();
    const users = (await get(ctx, '/api/admin/users', ctx.cookies.admin)).json().users as { email: string; premium: boolean }[];
    expect(Object.fromEntries(users.map((u) => [u.email, u.premium]))).toMatchObject({ 'premium@example.com': true, 'free@example.com': false });
    expect(users[0]).not.toHaveProperty('country');
  });
});

describe('subscriber counts agree with the subscription state rule', () => {
  it('SQL aggregates and subscriptionState() classify the same subscriptions identically (boundaries included)', async () => {
    const ctx = await setup();
    const now = ctx.clock.now();
    const planId = 'a0000000-0000-4000-8000-000000000002';
    // end offsets (days from now) x flags, including exact boundaries at 0 and -3 (grace length)
    const cases: [number, boolean, boolean][] = [
      [10, false, false], [0.0001, false, false], [0, false, false], [-1, false, false], [-2.999, false, false], [-3, false, false], [-30, false, false],
      [10, true, false], [-1, true, false], [10, false, true], [-1, false, true],
    ];
    let i = 0;
    for (const [days, cancelling, revoked] of cases) {
      const u = await seedUser(ctx.db, 'free', `edge${i++}@example.com`);
      await ctx.db.query(
        `insert into subscriptions (id, user_id, plan_id, tier, current_period_start, current_period_end, cancel_at_period_end, revoked_at, source)
         values (gen_random_uuid(), $1, $2, 'premium', $3, $4, $5, $6, 'admin_grant')`,
        [u.id, planId, addDays(now, days - 30), addDays(now, days), cancelling, revoked ? now : null]);
    }
    const subs = await row<{ tier: string; current_period_end: Date; cancel_at_period_end: boolean; revoked_at: Date | null; last_failed_payment_at: Date | null }>(ctx, 'select * from subscriptions');
    const expected = { active: 0, grace: 0, expired: 0, cancelled: 0 };
    for (const s of subs) expected[subscriptionState(s, now, 3).status]++;
    const got = (await summary(ctx)).subscribers;
    expect({ active: got.active, grace: got.grace, expired: got.expired, cancelled: got.cancelled }).toEqual(expected);
    expect(subs.length).toBe(cases.length + 1); // + the fixture premium user
  });
});
