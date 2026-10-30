import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MpesaProvider } from '../src/billing/providers/mpesa.js';
import { PaystackCardProvider } from '../src/billing/providers/paystack.js';
import type { FetchLike } from '../src/billing/providers/types.js';
import { checkoutReq, countRows, createSignal, deliver, get, pay, row, setup, sigLocked, startPayment, type Ctx } from './helpers.js';

const payment = async (ctx: Ctx, id: string) =>
  (await row<{ status: string; failure_reason: string | null; paid_at: Date | null; provider_transaction_id: string | null; refunded_minor: number }>(ctx, 'select * from payments where id = $1', [id]))[0]!;
const subOf = async (ctx: Ctx, userId: string) => (await row<{ current_period_start: Date; current_period_end: Date; plan_id: string }>(ctx, 'select * from subscriptions where user_id = $1', [userId]))[0];
const DAY = 86_400_000;

describe('successful payment', () => {
  it('verifies, marks the payment paid, activates a 30-day subscription, issues an invoice and unlocks premium content', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(true);

    const t0 = ctx.clock.now();
    const r = await pay(ctx, ctx.cookies.free, 'premium_monthly');
    expect(r.res.statusCode).toBe(200);
    expect(r.res.json()).toEqual({ received: true, outcome: 'applied' });

    const p = await payment(ctx, r.id);
    expect(p.status).toBe('succeeded');
    expect(p.paid_at).not.toBeNull();
    expect(p.provider_transaction_id).toMatch(/^MOCKTX/);

    const sub = (await subOf(ctx, ctx.users.free.id))!;
    expect(sub.current_period_start.getTime()).toBe(t0.getTime());
    expect(sub.current_period_end.getTime()).toBe(t0.getTime() + 30 * DAY);

    expect(await countRows(ctx, 'invoices', 'payment_id = $1', [r.id])).toBe(1);
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(false); // premium now, per verified backend state
    expect((await get(ctx, '/api/me', ctx.cookies.free)).json().user.access).toMatchObject({ premium: true, tier: 'premium' });
  });

  it('writes an audit trail: payment created, payment succeeded, subscription activated', async () => {
    const ctx = await setup();
    const r = await pay(ctx, ctx.cookies.free);
    const actions = (await row<{ action: string }>(ctx, "select action from audit_log where entity_id = $1 or data like $2 order by created_at", [r.id, `%${r.id}%`])).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['payment.created', 'payment.succeeded', 'subscription.initial']));
    expect(await countRows(ctx, 'payment_events', "outcome = 'applied' and payment_id = $1", [r.id])).toBe(1);
  });

  it.each([['premium_quarterly', 90], ['premium_yearly', 365]])('%s grants %i days', async (code, days) => {
    const ctx = await setup();
    const t0 = ctx.clock.now();
    await pay(ctx, ctx.cookies.free, code);
    expect((await subOf(ctx, ctx.users.free.id))!.current_period_end.getTime()).toBe(t0.getTime() + days * DAY);
  });
});

describe('failed payment', () => {
  it('records the failure and grants nothing', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    const r = await pay(ctx, ctx.cookies.free, 'premium_monthly', 'failed');
    expect(r.res.json().outcome).toBe('applied');
    expect(await payment(ctx, r.id)).toMatchObject({ status: 'failed' });
    expect(await subOf(ctx, ctx.users.free.id)).toBeUndefined();
    expect(await countRows(ctx, 'invoices', 'payment_id = $1', [r.id])).toBe(0);
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(true);
    expect(await countRows(ctx, 'audit_log', "action = 'payment.failed'")).toBe(1);
  });

  it('records a cancelled payment', async () => {
    const ctx = await setup();
    const r = await pay(ctx, ctx.cookies.free, 'premium_monthly', 'cancelled');
    expect((await payment(ctx, r.id)).status).toBe('cancelled');
    expect(await subOf(ctx, ctx.users.free.id)).toBeUndefined();
  });

  it('a late failure event can never undo a payment that already succeeded', async () => {
    const ctx = await setup();
    const r = await pay(ctx, ctx.cookies.free);
    const late = ctx.mock.signedEvent({ id: 'late-fail', type: 'payment.failed', reference: r.reference });
    expect((await deliver(ctx, late)).json().outcome).toBe('ignored');
    expect((await payment(ctx, r.id)).status).toBe('succeeded');
    expect(await sigLocked(ctx, (await createSignal(ctx)).id, ctx.cookies.free)).toBe(false);
  });

  it('a verified late success after an earlier failure still activates (e.g. delayed M-Pesa confirmation)', async () => {
    const ctx = await setup();
    const p = await startPayment(ctx, ctx.cookies.free);
    await deliver(ctx, ctx.mock.settle(p.reference, 'failed'));
    expect((await payment(ctx, p.id)).status).toBe('failed');
    expect((await deliver(ctx, ctx.mock.settle(p.reference, 'succeeded'))).json().outcome).toBe('applied');
    expect((await payment(ctx, p.id)).status).toBe('succeeded');
    expect(await subOf(ctx, ctx.users.free.id)).toBeDefined();
  });
});

describe('webhook authentication', () => {
  async function pending() {
    const ctx = await setup();
    const p = await startPayment(ctx, ctx.cookies.free);
    return { ctx, p };
  }
  const unchanged = async (ctx: Ctx, id: string) => {
    expect((await payment(ctx, id)).status).toBe('pending');
    expect(await subOf(ctx, ctx.users.free.id)).toBeUndefined();
    expect(await countRows(ctx, 'payment_events')).toBe(0);
  };

  it('rejects an unsigned webhook (401), changes nothing, and audits the rejection', async () => {
    const { ctx, p } = await pending();
    const body = Buffer.from(JSON.stringify({ id: 'x', type: 'payment.succeeded', reference: p.reference }));
    const res = await ctx.app.inject({ method: 'POST', url: '/api/webhooks/payments/mock', payload: body, headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_WEBHOOK');
    await unchanged(ctx, p.id);
    expect(await countRows(ctx, 'audit_log', "action = 'webhook.rejected'")).toBe(1);
  });

  it('rejects a signature made with the wrong secret', async () => {
    const { ctx, p } = await pending();
    const evt = ctx.mock.signedEvent({ id: 'x', type: 'payment.succeeded', reference: p.reference, amountMinor: 150000, currency: 'KES' }, 'attacker-secret');
    expect((await deliver(ctx, evt)).statusCode).toBe(401);
    await unchanged(ctx, p.id);
  });

  it('rejects a body altered after signing (e.g. amount or reference swapped)', async () => {
    const { ctx, p } = await pending();
    const good = ctx.mock.signedEvent({ id: 'x', type: 'payment.succeeded', reference: p.reference, amountMinor: 150000, currency: 'KES' });
    const tampered = { raw: Buffer.from(good.raw.toString().replace('payment.succeeded', 'payment.refunded')), headers: good.headers };
    expect((await deliver(ctx, tampered)).statusCode).toBe(401);
    await unchanged(ctx, p.id);
  });

  it('rejects garbage, empty bodies, wrong content and unknown providers', async () => {
    const { ctx, p } = await pending();
    expect((await ctx.app.inject({ method: 'POST', url: '/api/webhooks/payments/mock', payload: 'not json', headers: { 'content-type': 'application/json' } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/webhooks/payments/mock' })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/webhooks/payments/mock', payload: 'x=1', headers: { 'content-type': 'text/plain' } })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await deliver(ctx, ctx.mock.signedEvent({ id: 'a', type: 'payment.succeeded', reference: 'r' }), 'stripe')).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/webhooks/payments/mock' })).statusCode).toBe(404);
    await unchanged(ctx, p.id);
  });

  it('does not depend on, or get authorised by, a browser session', async () => {
    const { ctx, p } = await pending();
    const evt = ctx.mock.settle(p.reference, 'succeeded');
    // a logged-in user's cookie does not make an unsigned request valid
    const res = await ctx.app.inject({ method: 'POST', url: '/api/webhooks/payments/mock', payload: evt.raw, headers: { 'content-type': 'application/json', cookie: ctx.cookies.admin } });
    expect(res.statusCode).toBe(401);
  });
});

describe('idempotency and duplicate protection', () => {
  it('processing the same event twice creates ONE subscription period, ONE invoice and does not extend access', async () => {
    const ctx = await setup();
    const p = await startPayment(ctx, ctx.cookies.free);
    const evt = ctx.mock.settle(p.reference, 'succeeded', 'evt-fixed-1');
    expect((await deliver(ctx, evt)).json().outcome).toBe('applied');
    const first = (await subOf(ctx, ctx.users.free.id))!;
    ctx.clock.advanceDays(2);
    for (let i = 0; i < 3; i++) expect((await deliver(ctx, evt)).json().outcome).toBe('duplicate');
    const after = (await subOf(ctx, ctx.users.free.id))!;
    expect(after.current_period_end.getTime()).toBe(first.current_period_end.getTime());
    expect(await countRows(ctx, 'subscription_periods', 'payment_id = $1', [p.id])).toBe(1);
    expect(await countRows(ctx, 'invoices', 'payment_id = $1', [p.id])).toBe(1);
    expect(await countRows(ctx, 'payment_events', 'provider_reference = $1', [p.reference])).toBe(1);
    expect(await countRows(ctx, 'audit_log', "action = 'subscription.initial'")).toBe(1);
  });

  it('the same payment confirmed by DIFFERENT event ids still grants only once', async () => {
    const ctx = await setup();
    const p = await startPayment(ctx, ctx.cookies.free);
    expect((await deliver(ctx, ctx.mock.settle(p.reference, 'succeeded', 'evt-a'))).json().outcome).toBe('applied');
    expect((await deliver(ctx, ctx.mock.settle(p.reference, 'succeeded', 'evt-b'))).json().outcome).toBe('ignored');
    expect((await deliver(ctx, ctx.mock.settle(p.reference, 'succeeded', 'evt-c'))).json().outcome).toBe('ignored');
    expect(await countRows(ctx, 'subscription_periods', 'payment_id = $1', [p.id])).toBe(1);
    const sub = (await subOf(ctx, ctx.users.free.id))!;
    expect(sub.current_period_end.getTime() - sub.current_period_start.getTime()).toBe(30 * DAY);
  });

  it('simultaneous duplicate deliveries apply exactly once', async () => {
    const ctx = await setup();
    const p = await startPayment(ctx, ctx.cookies.free);
    const evt = ctx.mock.settle(p.reference, 'succeeded', 'evt-race');
    const results = await Promise.all(Array.from({ length: 6 }, () => deliver(ctx, evt)));
    const outcomes = results.map((r) => r.json().outcome as string);
    expect(outcomes.filter((o) => o === 'applied')).toHaveLength(1);
    expect(outcomes.filter((o) => o !== 'applied').every((o) => o === 'duplicate' || o === 'ignored')).toBe(true);
    expect(await countRows(ctx, 'subscription_periods', 'payment_id = $1', [p.id])).toBe(1);
    expect(await countRows(ctx, 'invoices', 'payment_id = $1', [p.id])).toBe(1);
    const sub = (await subOf(ctx, ctx.users.free.id))!;
    expect(sub.current_period_end.getTime() - sub.current_period_start.getTime()).toBe(30 * DAY);
  });

  it('a webhook racing with the customer\'s own verify call still grants once', async () => {
    const ctx = await setup();
    const p = await startPayment(ctx, ctx.cookies.free);
    const evt = ctx.mock.settle(p.reference, 'succeeded');
    await Promise.all([
      deliver(ctx, evt),
      ctx.app.inject({ method: 'POST', url: `/api/billing/payments/${p.id}/verify`, headers: { cookie: ctx.cookies.free } }),
    ]);
    expect(await countRows(ctx, 'subscription_periods', 'payment_id = $1', [p.id])).toBe(1);
    expect(await countRows(ctx, 'invoices', 'payment_id = $1', [p.id])).toBe(1);
  });
});

describe('verification before access', () => {
  it('a correctly SIGNED success is still not believed if the provider says the payment is not paid', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    const p = await startPayment(ctx, ctx.cookies.free);
    // e.g. a leaked signing secret: the event is authentic-looking but the provider ledger says "pending"
    const forged = ctx.mock.signedEvent({ id: 'forged-1', type: 'payment.succeeded', reference: p.reference, amountMinor: 150000, currency: 'KES' });
    const res = await deliver(ctx, forged);
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('rejected_unverified');
    expect((await payment(ctx, p.id)).status).toBe('pending');
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(true);
    expect(await countRows(ctx, 'audit_log', "action = 'payment.verification_failed'")).toBe(1);

    // when the provider really does confirm, the SAME event id is accepted on redelivery
    ctx.mock.settle(p.reference, 'succeeded', 'unused');
    expect((await deliver(ctx, forged)).json().outcome).toBe('applied');
    expect((await payment(ctx, p.id)).status).toBe('succeeded');
  });

  it('refuses to grant when the amount differs from what we recorded at checkout, and flags the payment', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    const p = await startPayment(ctx, ctx.cookies.free);
    ctx.mock.settle(p.reference, 'succeeded', 'ignored-evt');
    const underpaid = ctx.mock.signedEvent({ id: 'under-1', type: 'payment.succeeded', reference: p.reference, amountMinor: 100, currency: 'KES' });
    expect((await deliver(ctx, underpaid)).json().outcome).toBe('rejected_mismatch');
    expect(await payment(ctx, p.id)).toMatchObject({ status: 'failed', failure_reason: 'amount_mismatch' });
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(true);
    expect(await countRows(ctx, 'audit_log', "action = 'payment.amount_mismatch'")).toBe(1);
  });

  it('refuses to grant when the currency differs', async () => {
    const ctx = await setup();
    const p = await startPayment(ctx, ctx.cookies.free);
    ctx.mock.settle(p.reference, 'succeeded', 'x');
    const wrong = ctx.mock.signedEvent({ id: 'cur-1', type: 'payment.succeeded', reference: p.reference, amountMinor: 150000, currency: 'USD' });
    expect((await deliver(ctx, wrong)).json().outcome).toBe('rejected_mismatch');
    expect(await subOf(ctx, ctx.users.free.id)).toBeUndefined();
  });

  it('when the provider cannot be reached the event is NOT consumed, so the retry succeeds', async () => {
    const ctx = await setup();
    const p = await startPayment(ctx, ctx.cookies.free);
    const evt = ctx.mock.settle(p.reference, 'succeeded', 'evt-retry');
    ctx.mock.failNextVerify = true;
    expect((await deliver(ctx, evt)).statusCode).toBe(503);
    expect((await payment(ctx, p.id)).status).toBe('pending');
    expect(await countRows(ctx, 'payment_events')).toBe(0);
    expect((await deliver(ctx, evt)).json().outcome).toBe('applied');
    expect((await payment(ctx, p.id)).status).toBe('succeeded');
  });

  it('an event for an unknown payment is acknowledged but changes nothing', async () => {
    const ctx = await setup();
    const evt = ctx.mock.signedEvent({ id: 'orphan', type: 'payment.succeeded', reference: 'mock_does_not_exist', amountMinor: 150000, currency: 'KES' });
    const res = await deliver(ctx, evt);
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('unmatched');
    expect(await countRows(ctx, 'invoices')).toBe(0);
  });
});

describe('refunds', () => {
  const refundEvt = (ctx: Ctx, ref: string, id: string, amount?: number) =>
    ctx.mock.signedEvent({ id, type: 'payment.refunded', reference: ref, ...(amount ? { refundAmountMinor: amount } : {}) });

  it('a full refund event marks the payment and invoice refunded and removes the access it bought', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    const r = await pay(ctx, ctx.cookies.free);
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(false);
    expect((await deliver(ctx, refundEvt(ctx, r.reference, 'rf-1'))).json().outcome).toBe('applied');
    expect(await payment(ctx, r.id)).toMatchObject({ status: 'refunded', refunded_minor: 150000 });
    expect((await row<{ status: string }>(ctx, 'select status from invoices where payment_id = $1', [r.id]))[0]!.status).toBe('refunded');
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(true);
    expect((await get(ctx, '/api/billing/subscription', ctx.cookies.free)).json().subscriptions[0].status).toBe('cancelled');
    expect(await countRows(ctx, 'audit_log', "action = 'payment.refunded'")).toBe(1);
    // duplicate refund event is harmless
    expect((await deliver(ctx, refundEvt(ctx, r.reference, 'rf-1'))).json().outcome).toBe('duplicate');
  });

  it('a partial refund is recorded without removing access', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    const r = await pay(ctx, ctx.cookies.free);
    await deliver(ctx, refundEvt(ctx, r.reference, 'rf-p', 50000));
    expect(await payment(ctx, r.id)).toMatchObject({ status: 'partially_refunded', refunded_minor: 50000 });
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(false);
  });

  it('refunding a stacked renewal only takes back the period that payment bought', async () => {
    const ctx = await setup();
    const first = await pay(ctx, ctx.cookies.free);
    const second = await pay(ctx, ctx.cookies.free);
    const before = (await subOf(ctx, ctx.users.free.id))!;
    expect(before.current_period_end.getTime() - before.current_period_start.getTime()).toBe(60 * DAY);
    await deliver(ctx, refundEvt(ctx, second.reference, 'rf-s'));
    const after = (await subOf(ctx, ctx.users.free.id))!;
    expect(after.current_period_end.getTime() - after.current_period_start.getTime()).toBe(30 * DAY);
    expect(first.id).not.toBe(second.id);
    expect((await get(ctx, '/api/billing/subscription', ctx.cookies.free)).json().subscriptions[0].status).toBe('active');
  });

  it('ignores refund events for payments that were never paid', async () => {
    const ctx = await setup();
    const p = await startPayment(ctx, ctx.cookies.free);
    expect((await deliver(ctx, refundEvt(ctx, p.reference, 'rf-x'))).json().outcome).toBe('ignored');
    expect((await payment(ctx, p.id)).status).toBe('pending');
  });
});

describe('real adapters through the live endpoint (fake network underneath)', () => {
  it('M-Pesa: STK push -> token-authenticated callback -> STK query confirms -> premium', async () => {
    const ctx = await setup();
    let queryResult: object = { ResponseCode: '0', ResultCode: '1037' };
    const http: FetchLike = async (url, init) => {
      const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
      if (url.includes('oauth')) return json({ access_token: 't', expires_in: '3599' });
      if (url.includes('processrequest')) { expect(JSON.parse(init!.body!).PartyA).toBe('254712345678'); return json({ ResponseCode: '0', CheckoutRequestID: 'ws_CO_E2E' }); }
      if (url.includes('stkpushquery')) return json(queryResult);
      throw new Error(url);
    };
    ctx.registry.register(new MpesaProvider({ env: 'sandbox', consumerKey: 'k', consumerSecret: 's', shortcode: '174379', passkey: 'pk', callbackToken: 'mpesa-callback-token-1' }, http, ctx.clock.now));
    const sig = await createSignal(ctx);

    expect((await checkoutReq(ctx, ctx.cookies.free, { planCode: 'premium_monthly', provider: 'mpesa' })).statusCode).toBe(400); // phone required
    const res = await checkoutReq(ctx, ctx.cookies.free, { planCode: 'premium_monthly', provider: 'mpesa', phoneNumber: '0712 345 678' });
    expect(res.statusCode).toBe(201);
    const id = res.json().payment.id as string;
    // the full phone number is never stored; only a masked hint
    const stored = JSON.stringify(await row(ctx, 'select * from payments where id = $1', [id]));
    expect(stored).not.toContain('712345678');
    expect(res.json().payment.payerHint).toBe('2547*****678');

    const body = (code: number, amount = 1500) => Buffer.from(JSON.stringify({ Body: { stkCallback: { MerchantRequestID: 'm', CheckoutRequestID: 'ws_CO_E2E', ResultCode: code, ResultDesc: 'd',
      ...(code === 0 ? { CallbackMetadata: { Item: [{ Name: 'Amount', Value: amount }, { Name: 'MpesaReceiptNumber', Value: 'RCPT1' }] } } : {}) } } }));
    const hdr = { 'content-type': 'application/json' };

    expect((await deliver(ctx, { raw: body(0), headers: hdr }, 'mpesa')).statusCode).toBe(401); // no token
    expect((await deliver(ctx, { raw: body(0), headers: hdr }, 'mpesa', '?token=guess')).statusCode).toBe(401);
    expect((await payment(ctx, id)).status).toBe('pending');

    const url = '?token=mpesa-callback-token-1';
    // callback claims success but Safaricom's own query says "not yet": not believed
    expect((await deliver(ctx, { raw: body(0), headers: hdr }, 'mpesa', url)).json().outcome).toBe('rejected_unverified');
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(true);

    queryResult = { ResponseCode: '0', ResultCode: '0' };
    // Safaricom now confirms: the very same callback is accepted on redelivery (the earlier rejection was not final)
    expect((await deliver(ctx, { raw: body(0), headers: hdr }, 'mpesa', url)).json().outcome).toBe('applied');
    expect((await payment(ctx, id))).toMatchObject({ status: 'succeeded', provider_transaction_id: 'RCPT1' });
    expect(await sigLocked(ctx, sig.id, ctx.cookies.free)).toBe(false);
    expect((await deliver(ctx, { raw: body(0), headers: hdr }, 'mpesa', url)).json().outcome).toBe('duplicate');
    void body;
  });

  it('M-Pesa: a callback with the wrong amount is rejected and flagged, and the customer can still recover via server-side verification', async () => {
    const ctx = await setup();
    const http: FetchLike = async (url) => {
      const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
      if (url.includes('oauth')) return json({ access_token: 't', expires_in: '3599' });
      if (url.includes('processrequest')) return json({ ResponseCode: '0', CheckoutRequestID: 'ws_CO_MIS' });
      return json({ ResponseCode: '0', ResultCode: '0' }); // Safaricom's own query: paid
    };
    ctx.registry.register(new MpesaProvider({ env: 'sandbox', consumerKey: 'k', consumerSecret: 's', shortcode: '174379', passkey: 'pk', callbackToken: 'mpesa-callback-token-1' }, http, ctx.clock.now));
    const id = (await checkoutReq(ctx, ctx.cookies.free, { planCode: 'premium_monthly', provider: 'mpesa', phoneNumber: '0712345678' })).json().payment.id as string;
    const cb = Buffer.from(JSON.stringify({ Body: { stkCallback: { MerchantRequestID: 'm', CheckoutRequestID: 'ws_CO_MIS', ResultCode: 0, CallbackMetadata: { Item: [{ Name: 'Amount', Value: 1 }] } } } }));
    const res = await deliver(ctx, { raw: cb, headers: { 'content-type': 'application/json' } }, 'mpesa', '?token=mpesa-callback-token-1');
    expect(res.json().outcome).toBe('rejected_mismatch');
    expect(await payment(ctx, id)).toMatchObject({ status: 'failed', failure_reason: 'amount_mismatch' });
    expect(await subOf(ctx, ctx.users.free.id)).toBeUndefined();
    // the provider's authoritative status says paid, so the customer's own verify recovers it
    const v = await ctx.app.inject({ method: 'POST', url: `/api/billing/payments/${id}/verify`, headers: { cookie: ctx.cookies.free } });
    expect(v.json().payment.status).toBe('succeeded');
    expect(await countRows(ctx, 'subscription_periods', 'payment_id = $1', [id])).toBe(1);
  });

  it('recovery of a failed payment works inside the 7-day window and stops after it', async () => {
    const run = async (days: number) => {
      const ctx = await setup();
      const p = await startPayment(ctx, ctx.cookies.free);
      await deliver(ctx, ctx.mock.settle(p.reference, 'failed'));
      ctx.mock.settle(p.reference, 'succeeded', 'later-confirmation'); // the provider later reports it as paid
      ctx.clock.advanceDays(days);
      const v = await ctx.app.inject({ method: 'POST', url: `/api/billing/payments/${p.id}/verify`, headers: { cookie: ctx.cookies.free } });
      return v.json().payment.status as string;
    };
    expect(await run(6)).toBe('succeeded');
    expect(await run(8)).toBe('failed');
  });

  it('Card: hosted-checkout redirect -> HMAC-signed webhook -> verify API confirms -> premium', async () => {
    const ctx = await setup();
    const SECRET = 'sk_test_e2e';
    let verifyData: object = { status: 'pending' };
    const http: FetchLike = async (url, init) => {
      const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
      if (url.includes('transaction/initialize')) return json({ status: true, data: { authorization_url: 'https://checkout.paystack.com/e2e', reference: JSON.parse(init!.body!).reference } });
      if (url.includes('transaction/verify')) return json({ status: true, data: verifyData });
      throw new Error(url);
    };
    ctx.registry.register(new PaystackCardProvider(SECRET, http));
    const res = await checkoutReq(ctx, ctx.cookies.free, { planCode: 'premium_yearly', provider: 'card' });
    expect(res.statusCode).toBe(201);
    expect(res.json().action).toEqual({ type: 'redirect', url: 'https://checkout.paystack.com/e2e' });
    const id = res.json().payment.id as string;

    const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { id: 555, reference: id, amount: 1400000, currency: 'KES', status: 'success' } }));
    const sign = (secret: string) => createHmac('sha512', secret).update(raw).digest('hex');
    expect((await deliver(ctx, { raw, headers: { 'content-type': 'application/json', 'x-paystack-signature': sign('wrong') } }, 'card')).statusCode).toBe(401);
    expect((await payment(ctx, id)).status).toBe('pending');

    const signed = { raw, headers: { 'content-type': 'application/json', 'x-paystack-signature': sign(SECRET) } };
    expect((await deliver(ctx, signed, 'card')).json().outcome).toBe('rejected_unverified'); // gateway says not paid yet
    verifyData = { status: 'success', amount: 1400000, currency: 'KES', id: 555 };
    expect((await deliver(ctx, signed, 'card')).json().outcome).toBe('applied');
    expect(await payment(ctx, id)).toMatchObject({ status: 'succeeded', provider_transaction_id: '555' });
    expect((await get(ctx, '/api/me', ctx.cookies.free)).json().user.access.premium).toBe(true);
  });
});
