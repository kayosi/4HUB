import { describe, expect, it } from 'vitest';
import { checkoutReq, countRows, get, send, setup, startPayment, row } from './helpers.js';

const newPlan = (over: Record<string, unknown> = {}) => ({
  code: 'premium_biannual', name: 'Premium 6 Months', tier: 'premium', priceMinor: 750000, currency: 'KES', durationDays: 180,
  features: ['Everything in Premium'], ...over,
});
const post = (ctx: Awaited<ReturnType<typeof setup>>, cookie: string | undefined, body: unknown) => send(ctx, 'POST', '/api/admin/plans', cookie, body);

describe('public pricing', () => {
  it('lists the seeded active plans in order, visible to visitors, with the enabled payment methods', async () => {
    const ctx = await setup();
    const res = await get(ctx, '/api/billing/plans');
    expect(res.statusCode).toBe(200);
    const { plans, providers } = res.json();
    expect(plans.map((p: { code: string }) => p.code)).toEqual(['free', 'premium_monthly', 'premium_quarterly', 'premium_yearly']);
    expect(plans[1]).toMatchObject({ name: 'Premium Monthly', tier: 'premium', priceMinor: 150000, currency: 'KES', durationDays: 30 });
    expect(plans[1].features.length).toBeGreaterThan(0);
    expect(plans[0]).toMatchObject({ tier: 'free', priceMinor: 0, durationDays: null });
    expect(providers).toEqual([expect.objectContaining({ id: 'mock', method: 'sandbox' })]);
  });

  it('hides inactive plans from the public but not from admins', async () => {
    const ctx = await setup();
    const plans = (await get(ctx, '/api/admin/plans', ctx.cookies.admin)).json().plans;
    const quarterly = plans.find((p: { code: string }) => p.code === 'premium_quarterly');
    expect((await send(ctx, 'PATCH', `/api/admin/plans/${quarterly.id}`, ctx.cookies.admin, { isActive: false })).statusCode).toBe(200);
    expect((await get(ctx, '/api/billing/plans')).json().plans.map((p: { code: string }) => p.code)).not.toContain('premium_quarterly');
    expect((await get(ctx, '/api/admin/plans', ctx.cookies.admin)).json().plans.map((p: { code: string }) => p.code)).toContain('premium_quarterly');
  });
});

describe('plan creation (admin)', () => {
  it('creates a plan with name, price, currency, duration, features and status, and audits it', async () => {
    const ctx = await setup();
    const res = await post(ctx, ctx.cookies.admin, newPlan({ isActive: false, sortOrder: 9 }));
    expect(res.statusCode).toBe(201);
    expect(res.json().plan).toMatchObject({ code: 'premium_biannual', name: 'Premium 6 Months', priceMinor: 750000, currency: 'KES', durationDays: 180, isActive: false, sortOrder: 9, features: ['Everything in Premium'] });
    expect((await get(ctx, '/api/billing/plans')).json().plans.map((p: { code: string }) => p.code)).not.toContain('premium_biannual');
    expect(await countRows(ctx, 'audit_log', "action = 'plan.created'")).toBe(1);
  });

  it('only admins may create plans', async () => {
    const ctx = await setup();
    expect((await post(ctx, undefined, newPlan())).statusCode).toBe(401);
    for (const r of ['free', 'premium', 'moderator'] as const) expect((await post(ctx, ctx.cookies[r], newPlan())).statusCode, r).toBe(403);
  });

  it.each([
    ['bad code', { code: 'Premium Plan!' }],
    ['duplicate code (409)', { code: 'premium_monthly' }, 409],
    ['paid plan with zero price', { priceMinor: 0 }],
    ['paid plan without duration', { durationDays: null }],
    ['free tier with a price', { tier: 'free' }],
    ['unknown tier', { tier: 'vip' }],
    ['unsupported currency', { currency: 'XYZ' }],
    ['negative price', { priceMinor: -5 }],
    ['fractional price', { priceMinor: 10.5 }],
    ['zero duration', { durationDays: 0 }],
    ['too many features', { features: Array.from({ length: 21 }, (_, i) => `f${i}`) }],
    ['unknown field', { secret: true }],
  ])('rejects %s', async (_n, over, status = 400) => {
    const ctx = await setup();
    expect((await post(ctx, ctx.cookies.admin, newPlan(over as Record<string, unknown>))).statusCode).toBe(status);
  });
});

describe('plan editing (admin)', () => {
  const find = async (ctx: Awaited<ReturnType<typeof setup>>, code: string) =>
    (await get(ctx, '/api/admin/plans', ctx.cookies.admin)).json().plans.find((p: { code: string }) => p.code === code) as { id: string };

  it('edits name, price, currency, duration, features and active flag, with an audit entry', async () => {
    const ctx = await setup();
    const plan = await find(ctx, 'premium_monthly');
    const res = await send(ctx, 'PATCH', `/api/admin/plans/${plan.id}`, ctx.cookies.admin, {
      name: 'Premium (30 days)', priceMinor: 200000, currency: 'USD', durationDays: 31, features: ['A', 'B'], isActive: false,
    });
    expect(res.json().plan).toMatchObject({ name: 'Premium (30 days)', priceMinor: 200000, currency: 'USD', durationDays: 31, features: ['A', 'B'], isActive: false });
    const [a] = await row<{ data: { changed: string[]; before: { priceMinor: number } } }>(ctx, "select data from audit_log where action = 'plan.updated'");
    expect(a!.data.before.priceMinor).toBe(150000);
    expect(a!.data.changed).toContain('priceMinor');
  });

  it('code and tier are immutable, unknown fields are rejected, empty edits are rejected', async () => {
    const ctx = await setup();
    const plan = await find(ctx, 'premium_monthly');
    for (const body of [{ code: 'hacked' }, { tier: 'free' }, { id: 'x' }, {}, { priceMinor: 0 }, { durationDays: null }]) {
      expect((await send(ctx, 'PATCH', `/api/admin/plans/${plan.id}`, ctx.cookies.admin, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('protects the free plan: cannot be deactivated or given a price', async () => {
    const ctx = await setup();
    const free = await find(ctx, 'free');
    expect((await send(ctx, 'PATCH', `/api/admin/plans/${free.id}`, ctx.cookies.admin, { isActive: false })).statusCode).toBe(400);
    expect((await send(ctx, 'PATCH', `/api/admin/plans/${free.id}`, ctx.cookies.admin, { priceMinor: 100 })).statusCode).toBe(400);
    expect((await send(ctx, 'PATCH', `/api/admin/plans/${free.id}`, ctx.cookies.admin, { name: 'Starter' })).statusCode).toBe(200);
  });

  it('only admins can edit; unknown or malformed ids are 404', async () => {
    const ctx = await setup();
    const plan = await find(ctx, 'premium_monthly');
    expect((await send(ctx, 'PATCH', `/api/admin/plans/${plan.id}`, ctx.cookies.premium, { name: 'Free for all' })).statusCode).toBe(403);
    expect((await send(ctx, 'PATCH', `/api/admin/plans/${plan.id}`, undefined, { name: 'x' })).statusCode).toBe(401);
    expect((await send(ctx, 'PATCH', '/api/admin/plans/nope', ctx.cookies.admin, { name: 'xx' })).statusCode).toBe(404);
    expect((await send(ctx, 'PATCH', '/api/admin/plans/00000000-0000-4000-8000-000000000000', ctx.cookies.admin, { name: 'xx' })).statusCode).toBe(404);
  });

  it('a price change affects new checkouts only; payments in flight keep the price they were sold at', async () => {
    const ctx = await setup();
    const early = await startPayment(ctx, ctx.cookies.free, 'premium_monthly');
    const plan = await find(ctx, 'premium_monthly');
    await send(ctx, 'PATCH', `/api/admin/plans/${plan.id}`, ctx.cookies.admin, { priceMinor: 999900 });
    const late = await startPayment(ctx, ctx.cookies.premium, 'premium_monthly');
    const amounts = Object.fromEntries((await row<{ id: string; amount_minor: number }>(ctx, 'select id, amount_minor from payments')).map((r) => [r.id, r.amount_minor]));
    expect(amounts[early.id]).toBe(150000);
    expect(amounts[late.id]).toBe(999900);
  });

  it('a deactivated plan can no longer be purchased', async () => {
    const ctx = await setup();
    const plan = await find(ctx, 'premium_yearly');
    await send(ctx, 'PATCH', `/api/admin/plans/${plan.id}`, ctx.cookies.admin, { isActive: false });
    const res = await checkoutReq(ctx, ctx.cookies.free, { planCode: 'premium_yearly', provider: 'mock' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PLAN_UNAVAILABLE');
  });
});
