import { describe, expect, it } from 'vitest';
import { buildEntitlement, subscriptionState, type SubscriptionFields } from '../src/billing/subscriptions.js';
import { countRows, createSignal, get, pay, row, send, setup, sigLocked, startPayment, type Ctx } from './helpers.js';

const DAY = 86_400_000;
const end = new Date('2026-01-31T00:00:00Z');
const at = (days: number) => new Date(end.getTime() + days * DAY);
const sub = (over: Partial<SubscriptionFields> = {}): SubscriptionFields => ({
  tier: 'premium', current_period_end: end, cancel_at_period_end: false, revoked_at: null, last_failed_payment_at: null, ...over,
});

describe('subscriptionState (the single rule mapping dates to access)', () => {
  it('active before the period ends', () => {
    expect(subscriptionState(sub(), at(-0.001), 3)).toMatchObject({ status: 'active', hasAccess: true, graceEndsAt: null });
    expect(subscriptionState(sub(), at(-30), 3).status).toBe('active');
  });
  it('enters grace exactly when the period ends and keeps access until grace ends', () => {
    expect(subscriptionState(sub(), at(0), 3)).toMatchObject({ status: 'grace', hasAccess: true });
    expect(subscriptionState(sub(), at(2.99), 3)).toMatchObject({ status: 'grace', hasAccess: true, graceEndsAt: at(3) });
  });
  it('expires exactly when grace ends', () => {
    expect(subscriptionState(sub(), at(3), 3)).toMatchObject({ status: 'expired', hasAccess: false });
    expect(subscriptionState(sub(), at(400), 3).status).toBe('expired');
  });
  it('a zero-day grace setting means no grace', () => {
    expect(subscriptionState(sub(), at(0), 0)).toMatchObject({ status: 'expired', hasAccess: false });
  });
  it('a member who cancelled keeps access until the end, then loses it with NO grace', () => {
    const s = sub({ cancel_at_period_end: true });
    expect(subscriptionState(s, at(-1), 3)).toMatchObject({ status: 'active', hasAccess: true, cancelAtPeriodEnd: true });
    expect(subscriptionState(s, at(0), 3)).toMatchObject({ status: 'expired', hasAccess: false, graceEndsAt: null });
    expect(subscriptionState(s, at(1), 3).hasAccess).toBe(false);
  });
  it('a revoked subscription has no access even with time remaining', () => {
    expect(subscriptionState(sub({ revoked_at: at(-5) }), at(-1), 3)).toMatchObject({ status: 'cancelled', hasAccess: false });
  });
  it('surfaces a failed payment without changing access', () => {
    const s = subscriptionState(sub({ last_failed_payment_at: at(-2) }), at(-1), 3);
    expect(s).toMatchObject({ paymentFailed: true, hasAccess: true, status: 'active' });
  });
});

describe('buildEntitlement', () => {
  const now = at(-1);
  it('is free with no subscriptions', () => expect(buildEntitlement([], now, 3)).toEqual({ tier: 'free', capabilities: [] }));
  it('grants the tier capabilities while access lasts', () => expect(buildEntitlement([sub()], now, 3)).toEqual({ tier: 'premium', capabilities: ['premium_signals', 'premium_community'] }));
  it('is free again once expired, revoked, or for tiers it does not know', () => {
    expect(buildEntitlement([sub()], at(10), 3).tier).toBe('free');
    expect(buildEntitlement([sub({ revoked_at: at(-3) })], now, 3).tier).toBe('free');
    expect(buildEntitlement([sub({ tier: 'platinum_unknown' })], now, 3).tier).toBe('free');
  });
});

describe('subscription lifecycle', () => {
  const view = async (ctx: Ctx, cookie: string) => (await get(ctx, '/api/billing/subscription', cookie)).json().subscriptions[0] as Record<string, unknown> | undefined;

  it('access follows the calendar: active, then grace, then expired and locked (no background job)', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    await pay(ctx, ctx.cookies.free); // 30 days
    ctx.clock.advanceDays(29);
    expect(await view(ctx, ctx.cookies.free)).toMatchObject({ status: 'active', hasAccess: true, daysLeft: 1 });
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(false);

    ctx.clock.advanceDays(1.5); // day 30.5: renewal overdue, inside the 3-day grace
    expect(await view(ctx, ctx.cookies.free)).toMatchObject({ status: 'grace', hasAccess: true });
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(false);
    expect((await get(ctx, '/api/me', ctx.cookies.free)).json().user.access.premium).toBe(true);

    ctx.clock.advanceDays(2.6); // day 33.1: grace over
    expect(await view(ctx, ctx.cookies.free)).toMatchObject({ status: 'expired', hasAccess: false });
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(true);
    expect((await get(ctx, '/api/me', ctx.cookies.free)).json().user.access.premium).toBe(false);
    const gated = await get(ctx, '/api/member/premium', ctx.cookies.free);
    expect(gated.statusCode).toBe(403);
    expect(gated.json().error.code).toBe('PREMIUM_REQUIRED');
  });

  it('the grace period length is configurable', async () => {
    const ctx = await setup({ SUBSCRIPTION_GRACE_DAYS: '0' });
    const sig = await createSignal(ctx);
    await pay(ctx, ctx.cookies.free);
    ctx.clock.advanceDays(30.01);
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(true);
  });

  it('renewal while active extends from the current end (no lost days) and is recorded as a renewal', async () => {
    const ctx = await setup();
    const t0 = ctx.clock.now();
    await pay(ctx, ctx.cookies.free);
    ctx.clock.advanceDays(10);
    await pay(ctx, ctx.cookies.free);
    const s = (await view(ctx, ctx.cookies.free))!;
    expect(new Date(s.currentPeriodEnd as string).getTime()).toBe(t0.getTime() + 60 * DAY);
    expect(s.status).toBe('active');
    const kinds = (await row<{ kind: string }>(ctx, 'select p.kind from subscription_periods p join subscriptions s on s.id = p.subscription_id where s.user_id = $1 order by p.period_start', [ctx.users.free.id])).map((r) => r.kind);
    expect(kinds).toEqual(['initial', 'renewal']);
    expect(await countRows(ctx, 'subscriptions', 'user_id = $1', [ctx.users.free.id])).toBe(1); // one subscription, not two
    expect(await countRows(ctx, 'invoices', 'user_id = $1', [ctx.users.free.id])).toBe(2);
  });

  it('renewal during the grace period restores a full active period starting now', async () => {
    const ctx = await setup();
    await pay(ctx, ctx.cookies.free);
    ctx.clock.advanceDays(31);
    expect((await view(ctx, ctx.cookies.free))!.status).toBe('grace');
    const now = ctx.clock.now();
    await pay(ctx, ctx.cookies.free);
    const s = (await view(ctx, ctx.cookies.free))!;
    expect(s.status).toBe('active');
    expect(new Date(s.currentPeriodEnd as string).getTime()).toBe(now.getTime() + 30 * DAY);
  });

  it('paying after full expiry reactivates from now', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    await pay(ctx, ctx.cookies.free);
    ctx.clock.advanceDays(60);
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(true);
    const now = ctx.clock.now();
    await pay(ctx, ctx.cookies.free, 'premium_quarterly');
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(false);
    const s = (await view(ctx, ctx.cookies.free))!;
    expect(new Date(s.currentPeriodEnd as string).getTime()).toBe(now.getTime() + 90 * DAY);
    expect(s.planCode).toBe('premium_quarterly');
    const kinds = (await row<{ kind: string }>(ctx, 'select kind from subscription_periods p join subscriptions s on s.id = p.subscription_id where s.user_id = $1 order by period_start', [ctx.users.free.id])).map((r) => r.kind);
    expect(kinds).toEqual(['initial', 'reactivation']);
  });

  it('upgrading to a longer plan while active switches the plan and stacks the time', async () => {
    const ctx = await setup();
    const t0 = ctx.clock.now();
    await pay(ctx, ctx.cookies.free, 'premium_monthly');
    ctx.clock.advanceDays(5);
    await pay(ctx, ctx.cookies.free, 'premium_yearly');
    const s = (await view(ctx, ctx.cookies.free))!;
    expect(s.planCode).toBe('premium_yearly');
    expect(new Date(s.currentPeriodEnd as string).getTime()).toBe(t0.getTime() + (30 + 365) * DAY);
    expect((await row<{ kind: string }>(ctx, "select kind from subscription_periods where kind = 'upgrade'")).length).toBe(1);
  });

  it('paying on top of a complimentary grant keeps the granted time and relabels the subscription as paid', async () => {
    const ctx = await setup();
    expect((await view(ctx, ctx.cookies.premium))!.source).toBe('admin_grant'); // fixture grant: 30 days
    await pay(ctx, ctx.cookies.premium);
    const s = (await view(ctx, ctx.cookies.premium))!;
    expect(s.source).toBe('payment');
    expect(s.daysLeft).toBe(60); // 30 granted + 30 purchased
  });

  it('a failed renewal payment is flagged but does not cut access short; the next success clears the flag', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    await pay(ctx, ctx.cookies.free);
    ctx.clock.advanceDays(20);
    await pay(ctx, ctx.cookies.free, 'premium_monthly', 'failed');
    expect(await view(ctx, ctx.cookies.free)).toMatchObject({ paymentFailed: true, hasAccess: true, status: 'active' });
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(false);
    await pay(ctx, ctx.cookies.free);
    expect((await view(ctx, ctx.cookies.free))!.paymentFailed).toBe(false);
  });

  it('a failed FIRST payment leaves no subscription and no failed-state flag to confuse things', async () => {
    const ctx = await setup();
    await pay(ctx, ctx.cookies.free, 'premium_monthly', 'failed');
    expect(await view(ctx, ctx.cookies.free)).toBeUndefined();
  });

  it('cancellation keeps access until the paid period ends, then ends it immediately (no grace)', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    await pay(ctx, ctx.cookies.free);
    expect((await send(ctx, 'POST', '/api/billing/subscription/cancel', ctx.cookies.free)).statusCode).toBe(204);
    expect(await view(ctx, ctx.cookies.free)).toMatchObject({ status: 'active', cancelAtPeriodEnd: true, hasAccess: true });
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(false);
    expect((await send(ctx, 'POST', '/api/billing/subscription/cancel', ctx.cookies.free)).statusCode).toBe(409); // already cancelling
    ctx.clock.advanceDays(30.01);
    expect(await view(ctx, ctx.cookies.free)).toMatchObject({ status: 'expired', hasAccess: false });
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(true);
    expect(await countRows(ctx, 'audit_log', "action = 'subscription.cancel_requested'")).toBe(1);
  });

  it('a member can change their mind: resume restores renewal behaviour', async () => {
    const ctx = await setup();
    await pay(ctx, ctx.cookies.free);
    await send(ctx, 'POST', '/api/billing/subscription/cancel', ctx.cookies.free);
    expect((await send(ctx, 'POST', '/api/billing/subscription/resume', ctx.cookies.free)).statusCode).toBe(204);
    expect(await view(ctx, ctx.cookies.free)).toMatchObject({ cancelAtPeriodEnd: false });
    expect((await send(ctx, 'POST', '/api/billing/subscription/resume', ctx.cookies.free)).statusCode).toBe(409); // nothing to resume
    ctx.clock.advanceDays(31);
    expect((await view(ctx, ctx.cookies.free))!.status).toBe('grace'); // grace applies again
  });

  it('cancel/resume need an existing, current subscription and a signed-in member', async () => {
    const ctx = await setup();
    expect((await send(ctx, 'POST', '/api/billing/subscription/cancel', ctx.cookies.free)).statusCode).toBe(404);
    expect((await send(ctx, 'POST', '/api/billing/subscription/cancel')).statusCode).toBe(401);
    await pay(ctx, ctx.cookies.free);
    ctx.clock.advanceDays(40);
    expect((await send(ctx, 'POST', '/api/billing/subscription/cancel', ctx.cookies.free)).statusCode).toBe(409); // already expired
  });

  it('admin revocation downgrades immediately; a later payment reactivates', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    await pay(ctx, ctx.cookies.free);
    const r = await send(ctx, 'POST', `/api/admin/users/${ctx.users.free.id}/subscription/revoke`, ctx.cookies.admin, { reason: 'chargeback' });
    expect(r.statusCode).toBe(204);
    expect(await view(ctx, ctx.cookies.free)).toMatchObject({ status: 'cancelled', hasAccess: false });
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(true);
    await pay(ctx, ctx.cookies.free);
    expect(await view(ctx, ctx.cookies.free)).toMatchObject({ status: 'active', hasAccess: true });
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(false);
  });

  it('subscription state cannot be tampered with by a member', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    await send(ctx, 'PATCH', '/api/me', ctx.cookies.free, { displayName: 'Still Free', premium: true, role: 'admin', tier: 'premium', subscription: { status: 'active' }, access: { premium: true } });
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(true);
    for (const [url, body] of [
      [`/api/admin/users/${ctx.users.free.id}/subscription/grant`, { planCode: 'premium_yearly', reason: 'please' }],
      [`/api/admin/users/${ctx.users.premium.id}/subscription/revoke`, { reason: 'grief' }],
      ['/api/admin/payments/00000000-0000-4000-8000-000000000000/refund', { reason: 'give money' }],
    ] as const) {
      expect((await send(ctx, 'POST', url, ctx.cookies.free, body)).statusCode, url).toBe(403);
      expect((await send(ctx, 'POST', url, ctx.cookies.premium, body)).statusCode, url).toBe(403);
    }
    expect(await sigLocked(ctx, sig.id, ctx.cookies.premium)).toBe(false); // the victim kept access
    expect(await countRows(ctx, 'subscriptions', 'user_id = $1', [ctx.users.free.id])).toBe(0);
  });

  it('a free member sees an empty subscription list and the free entitlement', async () => {
    const ctx = await setup();
    const b = (await get(ctx, '/api/billing/subscription', ctx.cookies.free)).json();
    expect(b.subscriptions).toEqual([]);
    expect(b.entitlement).toEqual({ tier: 'free', capabilities: [] });
    expect((await get(ctx, '/api/billing/subscription')).statusCode).toBe(401);
  });

  it('pending (unpaid) checkouts never create or extend a subscription', async () => {
    const ctx = await setup();
    const before = (await view(ctx, ctx.cookies.premium))!.currentPeriodEnd;
    await startPayment(ctx, ctx.cookies.free);
    await startPayment(ctx, ctx.cookies.premium);
    expect(await countRows(ctx, 'subscriptions', 'user_id = $1', [ctx.users.free.id])).toBe(0);
    expect((await view(ctx, ctx.cookies.premium))!.currentPeriodEnd).toBe(before);
  });
});
