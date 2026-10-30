import { describe, expect, it } from 'vitest';
import { checkoutReq, countRows, createSignal, deliver, get, row, send, setup, sigLocked, startPayment } from './helpers.js';

describe('checkout', () => {
  it('requires a signed-in member', async () => {
    const ctx = await setup();
    expect((await checkoutReq(ctx, undefined, { planCode: 'premium_monthly', provider: 'mock' })).statusCode).toBe(401);
    expect(await countRows(ctx, 'payments')).toBe(0);
  });

  it('creates a PENDING payment priced by the server, and grants nothing yet', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    const res = await checkoutReq(ctx, ctx.cookies.free, { planCode: 'premium_quarterly', provider: 'mock' });
    expect(res.statusCode).toBe(201);
    expect(res.json().payment).toMatchObject({ status: 'pending', amountMinor: 390000, currency: 'KES', provider: 'mock', planCode: 'premium_quarterly', tier: 'premium' });
    expect(res.json().action).toMatchObject({ type: 'prompt' });
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(true); // starting a payment is not paying
    expect(await countRows(ctx, 'subscriptions', "user_id = $1", [ctx.users.free.id])).toBe(0);
    expect((await get(ctx, '/api/me', ctx.cookies.free)).json().user.access.premium).toBe(false);
  });

  it.each([
    ['amountMinor', 1], ['amount', 1], ['price', 1], ['currency', 'USD'], ['status', 'succeeded'], ['premium', true], ['durationDays', 9999],
  ])('rejects a client-supplied %s (price/state manipulation)', async (field, value) => {
    const ctx = await setup();
    const res = await checkoutReq(ctx, ctx.cookies.free, { planCode: 'premium_monthly', provider: 'mock', [field]: value });
    expect(res.statusCode).toBe(400);
    expect(await countRows(ctx, 'payments')).toBe(0);
  });

  it('refuses unknown, free and inactive plans, unknown providers and malformed input', async () => {
    const ctx = await setup();
    for (const body of [{ planCode: 'nope', provider: 'mock' }, { planCode: 'free', provider: 'mock' }, { planCode: 'premium_monthly', provider: 'paypal' }, { provider: 'mock' }, { planCode: 'premium_monthly' }]) {
      expect((await checkoutReq(ctx, ctx.cookies.free, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await countRows(ctx, 'payments')).toBe(0);
  });

  it('is idempotent per key: a double-click creates one payment; a different plan with the same key conflicts', async () => {
    const ctx = await setup();
    const body = { planCode: 'premium_monthly', provider: 'mock', idempotencyKey: 'checkout-key-0001' };
    const a = await checkoutReq(ctx, ctx.cookies.free, body);
    const b = await checkoutReq(ctx, ctx.cookies.free, body);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json().payment.id).toBe(a.json().payment.id);
    expect(await countRows(ctx, 'payments')).toBe(1);
    expect((await checkoutReq(ctx, ctx.cookies.free, { ...body, planCode: 'premium_yearly' })).statusCode).toBe(409);
    expect((await checkoutReq(ctx, ctx.cookies.premium, body)).statusCode).toBe(201); // keys are per member
    expect((await checkoutReq(ctx, ctx.cookies.free, { ...body, idempotencyKey: 'x' })).statusCode).toBe(400);
  });

  it('simultaneous identical submits still produce a single payment', async () => {
    const ctx = await setup();
    const body = { planCode: 'premium_monthly', provider: 'mock', idempotencyKey: 'race-key-00000001' };
    const results = await Promise.all(Array.from({ length: 5 }, () => checkoutReq(ctx, ctx.cookies.free, body)));
    expect(results.every((r) => r.statusCode === 200 || r.statusCode === 201)).toBe(true);
    expect(new Set(results.map((r) => r.json().payment.id)).size).toBe(1);
    expect(await countRows(ctx, 'payments')).toBe(1);
  });

  it('records a failed payment and returns 502 when the provider cannot start it', async () => {
    const ctx = await setup();
    ctx.mock.failNextInitiate = true;
    const res = await checkoutReq(ctx, ctx.cookies.free, { planCode: 'premium_monthly', provider: 'mock' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('PAYMENT_PROVIDER_ERROR');
    expect(res.body).not.toMatch(/mock: initiation/); // internals are not leaked
    const [p] = await row<{ status: string; failure_reason: string }>(ctx, 'select status, failure_reason from payments');
    expect(p).toMatchObject({ status: 'failed', failure_reason: 'initiation_failed' });
    expect(await countRows(ctx, 'audit_log', "action = 'payment.initiation_failed'")).toBe(1);
    expect(await countRows(ctx, 'subscriptions', 'user_id = $1', [ctx.users.free.id])).toBe(0);
  });
});

describe('payment status', () => {
  it('only the owner can see a payment; others get 404; malformed ids 404', async () => {
    const ctx = await setup();
    const p = await startPayment(ctx, ctx.cookies.free);
    expect((await get(ctx, `/api/billing/payments/${p.id}`, ctx.cookies.free)).json().payment).toMatchObject({ id: p.id, status: 'pending' });
    expect((await get(ctx, `/api/billing/payments/${p.id}`, ctx.cookies.premium)).statusCode).toBe(404);
    expect((await get(ctx, `/api/billing/payments/${p.id}`, ctx.cookies.admin)).statusCode).toBe(404);
    expect((await get(ctx, `/api/billing/payments/${p.id}`)).statusCode).toBe(401);
    expect((await get(ctx, '/api/billing/payments/nope', ctx.cookies.free)).statusCode).toBe(404);
  });

  it('never exposes provider references or idempotency keys to the customer', async () => {
    const ctx = await setup();
    const p = await startPayment(ctx, ctx.cookies.free, 'premium_monthly', { idempotencyKey: 'secret-key-00001' });
    const res = await get(ctx, `/api/billing/payments/${p.id}`, ctx.cookies.free);
    expect(res.body).not.toContain(p.reference);
    expect(res.body).not.toContain('secret-key-00001');
  });

  it('reading status repeatedly never changes it (the browser cannot "confirm" a payment)', async () => {
    const ctx = await setup();
    const p = await startPayment(ctx, ctx.cookies.free);
    for (let i = 0; i < 3; i++) expect((await get(ctx, `/api/billing/payments/${p.id}`, ctx.cookies.free)).json().payment.status).toBe('pending');
    // and the old tamper routes simply do not exist
    for (const [m, u] of [['PATCH', `/api/billing/payments/${p.id}`], ['PUT', `/api/billing/payments/${p.id}`], ['POST', `/api/billing/payments/${p.id}/confirm`], ['POST', `/api/billing/payments/${p.id}/success`]] as const) {
      expect((await send(ctx, m, u, ctx.cookies.free, { status: 'succeeded' })).statusCode, `${m} ${u}`).toBe(404);
    }
    expect(await countRows(ctx, 'subscriptions', 'user_id = $1', [ctx.users.free.id])).toBe(0);
  });

  it('lists only the member\'s own payments, newest first', async () => {
    const ctx = await setup();
    const a = await startPayment(ctx, ctx.cookies.free, 'premium_monthly');
    const b = await startPayment(ctx, ctx.cookies.free, 'premium_yearly');
    await startPayment(ctx, ctx.cookies.premium, 'premium_monthly');
    await ctx.db.query('update payments set created_at = $2 where id = $1', [a.id, new Date('2026-01-01')]);
    const list = (await get(ctx, '/api/billing/payments', ctx.cookies.free)).json().payments;
    expect(list.map((p: { id: string }) => p.id)).toEqual([b.id, a.id]);
    expect((await get(ctx, '/api/billing/payments')).statusCode).toBe(401);
  });
});

describe('server-side verification (lost-callback recovery)', () => {
  it('re-checks with the provider: still pending -> no access; provider says paid -> activates exactly once', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    const p = await startPayment(ctx, ctx.cookies.free);
    const url = `/api/billing/payments/${p.id}/verify`;

    expect((await send(ctx, 'POST', url, ctx.cookies.free)).json().payment.status).toBe('pending');
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(true);

    ctx.mock.settle(p.reference, 'succeeded'); // provider-side success, but our webhook never arrived
    expect((await send(ctx, 'POST', url, ctx.cookies.free)).json().payment.status).toBe('succeeded');
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(false);

    await send(ctx, 'POST', url, ctx.cookies.free);
    await send(ctx, 'POST', url, ctx.cookies.free);
    expect(await countRows(ctx, 'subscription_periods', 'payment_id = $1', [p.id])).toBe(1);
    expect(await countRows(ctx, 'invoices', 'payment_id = $1', [p.id])).toBe(1);
  });

  it('records provider-reported failure; another member cannot trigger a check', async () => {
    const ctx = await setup();
    const p = await startPayment(ctx, ctx.cookies.free);
    expect((await send(ctx, 'POST', `/api/billing/payments/${p.id}/verify`, ctx.cookies.premium)).statusCode).toBe(404);
    ctx.mock.settle(p.reference, 'failed');
    expect((await send(ctx, 'POST', `/api/billing/payments/${p.id}/verify`, ctx.cookies.free)).json().payment.status).toBe('failed');
    expect(await countRows(ctx, 'subscriptions', 'user_id = $1', [ctx.users.free.id])).toBe(0);
  });

  it('reports 503 (and changes nothing) when the provider cannot be reached', async () => {
    const ctx = await setup();
    const p = await startPayment(ctx, ctx.cookies.free);
    ctx.mock.failNextVerify = true;
    expect((await send(ctx, 'POST', `/api/billing/payments/${p.id}/verify`, ctx.cookies.free)).statusCode).toBe(503);
    expect((await get(ctx, `/api/billing/payments/${p.id}`, ctx.cookies.free)).json().payment.status).toBe('pending');
  });
});

describe('sandbox controls', () => {
  it('let the owner settle their own sandbox payment through the real webhook pipeline', async () => {
    const ctx = await setup();
    const p = await startPayment(ctx, ctx.cookies.free);
    expect((await send(ctx, 'POST', `/api/billing/sandbox/payments/${p.id}/settle`, ctx.cookies.premium, { outcome: 'succeeded' })).statusCode).toBe(404);
    expect((await send(ctx, 'POST', `/api/billing/sandbox/payments/${p.id}/settle`, undefined, { outcome: 'succeeded' })).statusCode).toBe(401);
    const res = await send(ctx, 'POST', `/api/billing/sandbox/payments/${p.id}/settle`, ctx.cookies.free, { outcome: 'succeeded' });
    expect(res.json().payment.status).toBe('succeeded');
    expect(await countRows(ctx, 'payment_events', "outcome = 'applied'")).toBe(1);
  });

  it('do not exist in production', async () => {
    const ctx = await setup({ NODE_ENV: 'production', PAYMENT_PROVIDERS: '', COOKIE_SECURE: 'x' });
    const res = await send(ctx, 'POST', '/api/billing/sandbox/payments/00000000-0000-4000-8000-000000000000/settle', ctx.cookies.free, { outcome: 'succeeded' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    void deliver;
  });
});
