import { describe, expect, it } from 'vitest';
import { deliver, get, pay, row, send, setup, startPayment } from './helpers.js';

describe('member access summary on /me, login and register', () => {
  it('reports premium only where it is real: free=false, subscriber=true, staff=true', async () => {
    const ctx = await setup();
    const acc = async (cookie: string) => (await get(ctx, '/api/me', cookie)).json().user.access;
    expect(await acc(ctx.cookies.free)).toEqual({ tier: 'free', premium: false });
    expect(await acc(ctx.cookies.premium)).toEqual({ tier: 'premium', premium: true });
    expect((await acc(ctx.cookies.admin)).premium).toBe(true); // content staff
    expect((await acc(ctx.cookies.moderator)).premium).toBe(true);
  });
  it('login and registration responses carry the same access summary', async () => {
    const ctx = await setup();
    const login = await send(ctx, 'POST', '/api/auth/login', undefined, { email: 'premium@example.com', password: 'correct-horse-battery' });
    expect(login.json().user.access).toEqual({ tier: 'premium', premium: true });
    const reg = await send(ctx, 'POST', '/api/auth/register', undefined, { email: 'new@example.com', password: 'a-long-passphrase', displayName: 'New' });
    expect(reg.json().user).toMatchObject({ role: 'free', access: { tier: 'free', premium: false } });
  });
});

describe('current subscription page data', () => {
  it('shows plan, status, expiry, days left and how it was obtained', async () => {
    const ctx = await setup();
    const s = (await get(ctx, '/api/billing/subscription', ctx.cookies.premium)).json().subscriptions[0];
    expect(s).toMatchObject({ tier: 'premium', planCode: 'premium_monthly', planName: 'Premium Monthly', status: 'active', hasAccess: true, source: 'admin_grant', cancelAtPeriodEnd: false, paymentFailed: false, daysLeft: 30 });
    expect(new Date(s.currentPeriodEnd).getTime() - new Date(s.currentPeriodStart).getTime()).toBe(30 * 86_400_000);
  });
});

describe('payment and billing history', () => {
  it('lists the member\'s payments (any status) and invoices (paid only), each member seeing only their own', async () => {
    const ctx = await setup();
    await pay(ctx, ctx.cookies.free, 'premium_monthly');
    await pay(ctx, ctx.cookies.free, 'premium_quarterly');
    await pay(ctx, ctx.cookies.free, 'premium_monthly', 'failed');
    await startPayment(ctx, ctx.cookies.free); // still pending
    await pay(ctx, ctx.cookies.moderator, 'premium_monthly');

    const payments = (await get(ctx, '/api/billing/payments', ctx.cookies.free)).json().payments;
    expect(payments.map((p: { status: string }) => p.status).sort()).toEqual(['failed', 'pending', 'succeeded', 'succeeded']);
    const invoices = (await get(ctx, '/api/billing/invoices', ctx.cookies.free)).json().invoices;
    expect(invoices).toHaveLength(2);
    expect((await get(ctx, '/api/billing/invoices', ctx.cookies.moderator)).json().invoices).toHaveLength(1);
    expect((await get(ctx, '/api/billing/invoices', ctx.cookies.premium)).json().invoices).toHaveLength(0);
    expect((await get(ctx, '/api/billing/invoices')).statusCode).toBe(401);
    expect((await get(ctx, '/api/billing/payments')).statusCode).toBe(401);
  });

  it('invoices have unique, sequential numbers and describe the period they cover', async () => {
    const ctx = await setup();
    await pay(ctx, ctx.cookies.free);
    await pay(ctx, ctx.cookies.premium);
    await pay(ctx, ctx.cookies.free);
    const all = (await row<{ seq: number }>(ctx, 'select seq from invoices order by seq')).map((r) => r.seq);
    expect(new Set(all).size).toBe(3);
    const inv = (await get(ctx, '/api/billing/invoices', ctx.cookies.free)).json().invoices as { number: string; description: string; amountMinor: number; currency: string; status: string }[];
    for (const i of inv) {
      expect(i.number).toMatch(/^4H-\d{4}-\d{6}$/);
      expect(i.description).toMatch(/Premium Monthly: \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/);
      expect(i).toMatchObject({ amountMinor: 150000, currency: 'KES', status: 'paid' });
    }
    expect(new Set(inv.map((i) => i.number)).size).toBe(2);
  });

  it('a receipt shows the customer, method and transaction id, and is private to its owner', async () => {
    const ctx = await setup();
    await pay(ctx, ctx.cookies.free);
    const id = (await get(ctx, '/api/billing/invoices', ctx.cookies.free)).json().invoices[0].id as string;
    const r = (await get(ctx, `/api/billing/invoices/${id}`, ctx.cookies.free)).json();
    expect(r.receipt).toMatchObject({ customer: { name: 'free user', email: 'free@example.com' }, provider: 'mock', refundedMinor: 0 });
    expect(r.receipt.transactionId).toMatch(/^MOCKTX/);
    expect(r.receipt.paidAt).toBeTruthy();
    expect((await get(ctx, `/api/billing/invoices/${id}`, ctx.cookies.premium)).statusCode).toBe(404);
    expect((await get(ctx, `/api/billing/invoices/${id}`, ctx.cookies.admin)).statusCode).toBe(404);
    expect((await get(ctx, `/api/billing/invoices/${id}`)).statusCode).toBe(401);
    expect((await get(ctx, '/api/billing/invoices/not-a-uuid', ctx.cookies.free)).statusCode).toBe(404);
  });

  it('paginates history', async () => {
    const ctx = await setup();
    for (let i = 0; i < 3; i++) await pay(ctx, ctx.cookies.free);
    expect((await get(ctx, '/api/billing/payments?limit=2', ctx.cookies.free)).json().payments).toHaveLength(2);
    expect((await get(ctx, '/api/billing/payments?limit=2&offset=2', ctx.cookies.free)).json().payments).toHaveLength(1);
    expect((await get(ctx, '/api/billing/invoices?limit=1', ctx.cookies.free)).json().invoices).toHaveLength(1);
    expect((await get(ctx, '/api/billing/payments?limit=0', ctx.cookies.free)).statusCode).toBe(400);
  });

  it('a refund is reflected on both the payment and the invoice the member sees', async () => {
    const ctx = await setup();
    const r = await pay(ctx, ctx.cookies.free);
    await deliver(ctx, ctx.mock.signedEvent({ id: 'rf', type: 'payment.refunded', reference: r.reference }));
    expect((await get(ctx, '/api/billing/payments', ctx.cookies.free)).json().payments[0]).toMatchObject({ status: 'refunded', refundedMinor: 150000 });
    expect((await get(ctx, '/api/billing/invoices', ctx.cookies.free)).json().invoices[0].status).toBe('refunded');
  });
});
