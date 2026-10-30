import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { MockProvider } from '../src/billing/providers/mock.js';
import { MpesaProvider, normalizeKenyanMsisdn } from '../src/billing/providers/mpesa.js';
import { PaystackCardProvider } from '../src/billing/providers/paystack.js';
import { createRegistry } from '../src/billing/providers/registry.js';
import { InvalidWebhookError, ProviderError, type FetchLike } from '../src/billing/providers/types.js';

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }
/** Fake HTTP layer: records calls and answers from a route table. */
function fakeHttp(routes: Record<string, (c: Call) => { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const http: FetchLike = async (url, init) => {
    const call: Call = { url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected request: ${url}`);
    const { status = 200, body } = routes[key]!(call);
    return { ok: status < 400, status, json: async () => body };
  };
  return { http, calls };
}
const none = Buffer.alloc(0);

describe('MockProvider (sandbox)', () => {
  const p = new MockProvider('secret-123456');
  const evt = { id: 'e1', type: 'payment.succeeded', reference: 'r1', amountMinor: 100, currency: 'KES' };

  it('accepts a correctly signed event and normalises it', () => {
    const { raw, headers } = p.signedEvent(evt);
    expect(p.verifyWebhook(raw, headers)).toMatchObject({ eventId: 'e1', type: 'payment.succeeded', providerReference: 'r1', amountMinor: 100, currency: 'KES' });
  });
  it('rejects missing, wrong-secret, tampered and malformed events', () => {
    const good = p.signedEvent(evt);
    expect(() => p.verifyWebhook(good.raw, {})).toThrow(InvalidWebhookError);
    const wrong = p.signedEvent(evt, 'another-secret');
    expect(() => p.verifyWebhook(wrong.raw, wrong.headers)).toThrow(InvalidWebhookError);
    expect(() => p.verifyWebhook(Buffer.from(JSON.stringify({ ...evt, amountMinor: 1 })), good.headers)).toThrow(InvalidWebhookError);
    const junk = p.signedEvent({ nope: true });
    expect(() => p.verifyWebhook(junk.raw, junk.headers)).toThrow(InvalidWebhookError);
    expect(() => p.verifyWebhook(good.raw, { 'x-mock-signature': 'zz' })).toThrow(InvalidWebhookError);
  });
  it('returns null for authentic but irrelevant events', () => {
    const { raw, headers } = p.signedEvent({ ...evt, type: 'customer.updated' });
    expect(p.verifyWebhook(raw, headers)).toBeNull();
  });
});

describe('M-Pesa adapter (Daraja STK push)', () => {
  const cfg = { env: 'sandbox' as const, consumerKey: 'ck', consumerSecret: 'cs', shortcode: '174379', passkey: 'passkey', callbackToken: 'cb-token-0123456789' };
  const now = () => new Date('2026-03-01T10:20:30Z');
  const base = {
    'oauth/v1/generate': () => ({ body: { access_token: 'tok', expires_in: '3599' } }),
    'stkpush/v1/processrequest': () => ({ body: { ResponseCode: '0', CheckoutRequestID: 'ws_CO_1', MerchantRequestID: 'm1', CustomerMessage: 'Success' } }),
  };
  const input = { paymentId: 'p1', amountMinor: 150000, currency: 'KES', description: '4HUB Premium Monthly', customer: { userId: 'u', email: 'a@b.co', phoneNumber: '254712345678' }, returnUrl: 'https://web/x', callbackUrl: 'https://api/cb' };

  it('normalises Kenyan numbers and masks them for storage', () => {
    for (const n of ['0712345678', '+254712345678', '254712345678', '0712 345 678', '0112345678']) expect(normalizeKenyanMsisdn(n)).toMatch(/^254[71]\d{8}$/);
    for (const n of ['071234567', '0812345678', '12345', 'abc']) expect(normalizeKenyanMsisdn(n)).toBeNull();
    const { http } = fakeHttp(base);
    const p = new MpesaProvider(cfg, http, now);
    expect(p.prepareCustomer({ phoneNumber: '0712345678' })).toEqual({ ok: true, phoneNumber: '254712345678', payerHint: '2547*****678' });
    expect(p.prepareCustomer({})).toMatchObject({ ok: false });
    expect(p.prepareCustomer({ phoneNumber: '12' })).toMatchObject({ ok: false });
  });

  it('sends a correct STK push: whole shillings, Daraja password, callback with secret token', async () => {
    const { http, calls } = fakeHttp(base);
    const r = await new MpesaProvider(cfg, http, now).initiate(input);
    expect(r).toMatchObject({ providerReference: 'ws_CO_1', action: { type: 'prompt' } });
    const stk = calls.find((c) => c.url.includes('processrequest'))!;
    expect(stk.url.startsWith('https://sandbox.safaricom.co.ke')).toBe(true);
    expect(stk.headers.Authorization).toBe('Bearer tok');
    expect(stk.body).toMatchObject({
      BusinessShortCode: '174379', Timestamp: '20260301102030', Amount: 1500, PartyA: '254712345678', PartyB: '174379', TransactionType: 'CustomerPayBillOnline',
      CallBackURL: 'https://api/cb?token=cb-token-0123456789',
    });
    expect((stk.body as { Password: string }).Password).toBe(Buffer.from('174379passkey20260301102030').toString('base64'));
    expect(calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from('ck:cs').toString('base64')}`);
  });

  it('turns provider failures into ProviderError', async () => {
    const rejected = fakeHttp({ ...base, 'stkpush/v1/processrequest': () => ({ body: { ResponseCode: '1', ResponseDescription: 'no' } }) });
    await expect(new MpesaProvider(cfg, rejected.http, now).initiate(input)).rejects.toBeInstanceOf(ProviderError);
    const noToken = fakeHttp({ ...base, 'oauth/v1/generate': () => ({ status: 401, body: {} }) });
    await expect(new MpesaProvider(cfg, noToken.http, now).initiate(input)).rejects.toBeInstanceOf(ProviderError);
    await expect(new MpesaProvider(cfg, fakeHttp(base).http, now).initiate({ ...input, amountMinor: 150050 })).rejects.toBeInstanceOf(ProviderError);
  });

  const cb = (code: number, extra: object = {}) => Buffer.from(JSON.stringify({ Body: { stkCallback: { MerchantRequestID: 'm1', CheckoutRequestID: 'ws_CO_1', ResultCode: code, ResultDesc: 'x', ...extra } } }));
  const meta = { CallbackMetadata: { Item: [{ Name: 'Amount', Value: 1500 }, { Name: 'MpesaReceiptNumber', Value: 'QGH7XYZ123' }, { Name: 'PhoneNumber', Value: 254712345678 }] } };

  it('authenticates callbacks by secret token and parses success, cancellation and failure', () => {
    const p = new MpesaProvider(cfg, fakeHttp(base).http, now);
    const q = { token: 'cb-token-0123456789' };
    expect(p.verifyWebhook(cb(0, meta), {}, q)).toEqual({ eventId: 'ws_CO_1:0', type: 'payment.succeeded', providerReference: 'ws_CO_1', currency: 'KES', amountMinor: 150000, providerTransactionId: 'QGH7XYZ123' });
    expect(p.verifyWebhook(cb(1032), {}, q)).toMatchObject({ type: 'payment.cancelled', failureReason: 'mpesa_1032' });
    expect(p.verifyWebhook(cb(1), {}, q)).toMatchObject({ type: 'payment.failed', failureReason: 'mpesa_1' });
    expect(() => p.verifyWebhook(cb(0, meta), {}, {})).toThrow(InvalidWebhookError);
    expect(() => p.verifyWebhook(cb(0, meta), {}, { token: 'guess' })).toThrow(InvalidWebhookError);
    expect(() => p.verifyWebhook(Buffer.from('{"nope":1}'), {}, q)).toThrow(InvalidWebhookError);
    expect(() => p.verifyWebhook(none, {}, q)).toThrow(InvalidWebhookError);
  });

  it('verifyPayment maps STK query results', async () => {
    const q = (body: object) => new MpesaProvider(cfg, fakeHttp({ ...base, 'stkpushquery/v1/query': () => ({ body }) }).http, now).verifyPayment('ws_CO_1');
    expect(await q({ ResponseCode: '0', ResultCode: '0' })).toMatchObject({ status: 'succeeded', currency: 'KES' });
    expect(await q({ ResponseCode: '0', ResultCode: '1032' })).toMatchObject({ status: 'cancelled' });
    expect(await q({ ResponseCode: '0', ResultCode: '1' })).toMatchObject({ status: 'failed' });
    expect(await q({ errorCode: '500.001.1001', errorMessage: 'still processing' })).toEqual({ status: 'pending' });
  });
});

describe('Card adapter (Paystack hosted checkout)', () => {
  const SECRET = 'sk_test_abc';
  const init = { paymentId: 'pay-uuid-1', amountMinor: 390000, currency: 'KES', description: 'x', customer: { userId: 'u', email: 'a@b.co' }, returnUrl: 'https://web/back', callbackUrl: 'https://api/cb' };
  const sign = (raw: Buffer, secret = SECRET) => createHmac('sha512', secret).update(raw).digest('hex');

  it('initialises a hosted checkout using our payment id as the reference and never handles card data', async () => {
    const { http, calls } = fakeHttp({ 'transaction/initialize': () => ({ body: { status: true, data: { authorization_url: 'https://checkout.paystack.com/abc', reference: 'pay-uuid-1' } } }) });
    const r = await new PaystackCardProvider(SECRET, http).initiate(init);
    expect(r).toEqual({ providerReference: 'pay-uuid-1', action: { type: 'redirect', url: 'https://checkout.paystack.com/abc' } });
    expect(calls[0]!.body).toMatchObject({ email: 'a@b.co', amount: 390000, currency: 'KES', reference: 'pay-uuid-1', channels: ['card'], callback_url: 'https://web/back' });
    expect(JSON.stringify(calls[0]!.body)).not.toMatch(/card_number|cvv|pan/i);
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${SECRET}`);
  });

  it('wraps HTTP failures in ProviderError', async () => {
    const { http } = fakeHttp({ 'transaction/initialize': () => ({ status: 500, body: {} }) });
    await expect(new PaystackCardProvider(SECRET, http).initiate(init)).rejects.toBeInstanceOf(ProviderError);
  });

  it('verifies the HMAC-SHA512 signature over the raw body', () => {
    const p = new PaystackCardProvider(SECRET, fakeHttp({}).http);
    const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: { id: 302961, reference: 'pay-uuid-1', amount: 390000, currency: 'KES', status: 'success' } }));
    expect(p.verifyWebhook(raw, { 'x-paystack-signature': sign(raw) })).toEqual({
      eventId: 'charge.success:302961', type: 'payment.succeeded', providerReference: 'pay-uuid-1', amountMinor: 390000, currency: 'KES', providerTransactionId: '302961',
    });
    expect(() => p.verifyWebhook(raw, {})).toThrow(InvalidWebhookError);
    expect(() => p.verifyWebhook(raw, { 'x-paystack-signature': sign(raw, 'sk_other') })).toThrow(InvalidWebhookError);
    expect(() => p.verifyWebhook(Buffer.from(raw.toString().replace('390000', '1')), { 'x-paystack-signature': sign(raw) })).toThrow(InvalidWebhookError);
    expect(() => p.verifyWebhook(raw, { 'x-paystack-signature': 'abcd' })).toThrow(InvalidWebhookError);
  });

  it('parses refunds and ignores authentic-but-irrelevant events', () => {
    const p = new PaystackCardProvider(SECRET, fakeHttp({}).http);
    const refund = Buffer.from(JSON.stringify({ event: 'refund.processed', data: { id: 77, transaction_reference: 'pay-uuid-1', amount: 100000 } }));
    expect(p.verifyWebhook(refund, { 'x-paystack-signature': sign(refund) })).toMatchObject({ type: 'payment.refunded', providerReference: 'pay-uuid-1', refundAmountMinor: 100000 });
    const other = Buffer.from(JSON.stringify({ event: 'customeridentification.success', data: {} }));
    expect(p.verifyWebhook(other, { 'x-paystack-signature': sign(other) })).toBeNull();
  });

  it('verifyPayment maps transaction states', async () => {
    const v = (data: object) => new PaystackCardProvider(SECRET, fakeHttp({ 'transaction/verify': () => ({ body: { status: true, data } }) }).http).verifyPayment('r');
    expect(await v({ status: 'success', amount: 390000, currency: 'KES', id: 9 })).toEqual({ status: 'succeeded', amountMinor: 390000, currency: 'KES', providerTransactionId: '9' });
    expect(await v({ status: 'failed', gateway_response: 'Declined' })).toMatchObject({ status: 'failed', failureReason: 'Declined' });
    expect(await v({ status: 'abandoned' })).toMatchObject({ status: 'cancelled' });
    expect(await v({ status: 'ongoing' })).toEqual({ status: 'pending' });
    expect(await v({ status: 'weird' })).toEqual({ status: 'unknown' });
  });
});

describe('provider registry and configuration', () => {
  const noHttp: FetchLike = async () => { throw new Error('no network'); };
  const cfg = (env: Record<string, string>) => loadConfig({ DATABASE_URL: 'x', ...env });

  it('refuses to enable the sandbox provider in production (config and registry)', () => {
    expect(() => cfg({ NODE_ENV: 'production', PAYMENT_PROVIDERS: 'mock' })).toThrow(/not allowed in production/);
    const bypass = { ...cfg({ PAYMENT_PROVIDERS: 'mock' }), NODE_ENV: 'production' as const };
    expect(() => createRegistry(bypass, noHttp, () => new Date())).toThrow(/production/);
  });
  it('requires credentials for real providers and rejects unknown ones', () => {
    expect(() => createRegistry(cfg({ PAYMENT_PROVIDERS: 'mpesa' }), noHttp, () => new Date())).toThrow(/MPESA/);
    expect(() => createRegistry(cfg({ PAYMENT_PROVIDERS: 'card' }), noHttp, () => new Date())).toThrow(/PAYSTACK/);
    expect(() => createRegistry(cfg({ PAYMENT_PROVIDERS: 'bitcoin' }), noHttp, () => new Date())).toThrow(/Unknown payment provider/);
  });
  it('builds real providers from complete config; no providers by default', () => {
    const full = cfg({ PAYMENT_PROVIDERS: 'mpesa, card', MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's', MPESA_SHORTCODE: '1', MPESA_PASSKEY: 'p', MPESA_CALLBACK_TOKEN: '0123456789abcdef', PAYSTACK_SECRET_KEY: 'sk' });
    expect(createRegistry(full, noHttp, () => new Date()).list().map((p) => p.id)).toEqual(['mpesa', 'card']);
    expect(createRegistry(cfg({}), noHttp, () => new Date()).list()).toEqual([]);
  });
});
