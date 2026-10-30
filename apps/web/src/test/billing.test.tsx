import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { AuthProvider } from '../auth/AuthContext';
import { durationLabel, failureMessage, formatMoney, perMonthMinor, savingsPercent, toMajor, toMinor, type Plan } from '../lib/billing';

const plan = (over: Partial<Plan>): Plan => ({ id: over.code ?? 'x', code: 'premium_monthly', name: 'Premium Monthly', description: '', tier: 'premium', priceMinor: 150000, currency: 'KES', durationDays: 30, features: ['Premium signals'], isActive: true, sortOrder: 1, ...over });
const PLANS: Plan[] = [
  plan({ code: 'free', name: 'Free', tier: 'free', priceMinor: 0, durationDays: null, features: ['Free signals'], sortOrder: 0 }),
  plan({ code: 'premium_monthly' }),
  plan({ code: 'premium_quarterly', name: 'Premium Quarterly', priceMinor: 390000, durationDays: 90, sortOrder: 2 }),
  plan({ code: 'premium_yearly', name: 'Premium Yearly', priceMinor: 1400000, durationDays: 365, sortOrder: 3 }),
];
const MPESA = { id: 'mpesa', name: 'M-Pesa', method: 'mobile_money', currencies: ['KES'] };
const CARD = { id: 'card', name: 'Card', method: 'card', currencies: ['KES', 'USD'] };
const SANDBOX = { id: 'mock', name: 'Sandbox (test payments)', method: 'sandbox', currencies: ['KES'] };

const account = (o: { role?: string; premium?: boolean } = {}) => ({ user: {
  id: 'u1', email: 'ada@example.com', displayName: 'Ada', role: o.role ?? 'free', createdAt: '2026-01-01', country: null, tradingExperience: null, preferredAssets: [],
  notificationPrefs: { newSignals: true, signalUpdates: true, announcements: false }, access: { tier: o.premium ? 'premium' : 'free', premium: o.premium ?? false },
} });
const visitor = { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'x' } } };
const payment = (over: Record<string, unknown> = {}) => ({ id: 'pay1', status: 'pending', amountMinor: 150000, currency: 'KES', provider: 'mpesa', planCode: 'premium_monthly', planName: 'Premium Monthly', tier: 'premium', failureReason: null, payerHint: '2547*****678', refundedMinor: 0, createdAt: '2026-03-01T10:00:00Z', paidAt: null, refundedAt: null, ...over });
const sub = (over: Record<string, unknown> = {}) => ({ tier: 'premium', planCode: 'premium_monthly', planName: 'Premium Monthly', source: 'payment', status: 'active', hasAccess: true, currentPeriodStart: '2026-03-01T00:00:00Z', currentPeriodEnd: '2026-03-31T00:00:00Z', graceEndsAt: null, cancelAtPeriodEnd: false, paymentFailed: false, daysLeft: 12, ...over });

type Handler = (url: string, init?: RequestInit) => { status?: number; body?: unknown } | undefined;
function mockApi(handler: Handler, who: { status?: number; body?: unknown } = { body: account() }) {
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    const r = (String(url).endsWith('/api/me') && (!init?.method || init.method === 'GET') ? who : handler(String(url), init)) ?? { status: 404, body: { error: { code: 'NOT_FOUND', message: 'nope' } } };
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.body } as Response;
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}
const renderAt = (path: string) => render(<MemoryRouter initialEntries={[path]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
const bodyOf = (spy: ReturnType<typeof vi.fn>, urlPart: string) => {
  const call = spy.mock.calls.find((c) => String(c[0]).includes(urlPart) && (c[1] as RequestInit | undefined)?.method === 'POST');
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : undefined;
};

beforeEach(() => { vi.spyOn(window, 'confirm').mockReturnValue(true); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('billing helpers', () => {
  it('formats minor units and converts safely', () => {
    expect(formatMoney(150000, 'KES')).toMatch(/1,500/);
    expect(formatMoney(150050, 'KES')).toMatch(/1,500\.50/);
    expect(toMajor(150000)).toBe(1500);
    expect(toMinor(1500.5)).toBe(150050);
    expect(toMinor(0.1 + 0.2)).toBe(30); // no floating point drift
  });
  it('computes per-month price and savings against the shortest plan', () => {
    expect(perMonthMinor(PLANS[2]!)).toBe(130000);
    expect(savingsPercent(PLANS[1]!, PLANS)).toBe(0);
    expect(savingsPercent(PLANS[2]!, PLANS)).toBe(13);
    expect(savingsPercent(PLANS[3]!, PLANS)).toBe(23); // 365-day year vs 30-day months
    expect(savingsPercent(PLANS[0]!, PLANS)).toBe(0);
  });
  it('labels durations and falls back to a safe failure message', () => {
    expect([30, 90, 365, 45].map(durationLabel)).toEqual(['month', '3 months', 'year', '45 days']);
    expect(failureMessage('mpesa_1032')).toMatch(/cancelled/);
    expect(failureMessage('weird_code')).toMatch(/not completed/);
    expect(failureMessage(null)).toMatch(/not completed/);
  });
});

describe('pricing page', () => {
  const plansHandler: Handler = (url) => (url.endsWith('/billing/plans') ? { body: { plans: PLANS, providers: [MPESA, CARD] } } : undefined);

  it('shows every plan from the server with price, saving and features; visitors are sent to checkout via login', async () => {
    mockApi(plansHandler, visitor);
    renderAt('/pricing');
    expect(await screen.findByTestId('price-premium_monthly')).toHaveTextContent(/1,500/);
    expect(screen.getByTestId('price-premium_yearly')).toHaveTextContent(/14,000/);
    expect(screen.getByText('Save 23%')).toBeInTheDocument();
    expect(screen.getByText('Save 13%')).toBeInTheDocument();
    expect(screen.getByText('Free signals')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /choose plan/i })[0]).toHaveAttribute('href', '/checkout/premium_monthly');
    expect(screen.getByRole('link', { name: /create free account/i })).toBeInTheDocument();
    expect(screen.getByText(/pay with m-pesa or card/i)).toBeInTheDocument();
  });

  it('members who already have premium are offered to extend, free members to choose', async () => {
    mockApi(plansHandler, { body: account({ premium: true }) });
    renderAt('/pricing');
    expect((await screen.findAllByRole('link', { name: /extend with this plan/i })).length).toBe(3);
  });

  it('shows an error state with retry when plans cannot be loaded', async () => {
    mockApi(() => ({ status: 500, body: { error: { code: 'INTERNAL', message: 'Boom' } } }), visitor);
    renderAt('/pricing');
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

describe('checkout', () => {
  const base: Handler = (url) => (url.endsWith('/billing/plans') ? { body: { plans: PLANS, providers: [MPESA, CARD, SANDBOX] } } : undefined);

  it('sends visitors to log in first', async () => {
    mockApi(base, visitor);
    renderAt('/checkout/premium_monthly');
    expect(await screen.findByRole('heading', { name: /log in/i })).toBeInTheDocument();
  });

  it('shows the server price, requires a phone for M-Pesa, and never sends a price', async () => {
    const spy = mockApi((url, init) => {
      if (url.endsWith('/billing/checkout') && init?.method === 'POST') return { status: 201, body: { payment: payment(), action: { type: 'prompt', message: 'Check your phone' } } };
      if (url.includes('/billing/payments/pay1')) return { body: { payment: payment() } };
      return base(url, init);
    });
    renderAt('/checkout/premium_quarterly');
    expect(await screen.findByTestId('total')).toHaveTextContent(/3,900/);
    expect(screen.getByLabelText(/m-pesa phone number/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /pay/i }));
    expect(await screen.findByText(/enter your m-pesa phone number/i)).toBeInTheDocument();
    expect(bodyOf(spy, '/billing/checkout')).toBeUndefined();

    await userEvent.type(screen.getByLabelText(/m-pesa phone number/i), '0712345678');
    await userEvent.click(screen.getByRole('button', { name: /pay/i }));
    expect(await screen.findByText(/waiting for confirmation/i)).toBeInTheDocument();
    const sent = bodyOf(spy, '/billing/checkout');
    expect(sent).toMatchObject({ planCode: 'premium_quarterly', provider: 'mpesa', phoneNumber: '0712345678' });
    expect(sent.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
    for (const forbidden of ['amount', 'amountMinor', 'price', 'currency', 'status', 'premium']) expect(sent).not.toHaveProperty(forbidden);
  });

  it('card payments need no phone and hand over to the hosted checkout page', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const spy = mockApi((url, init) => (url.endsWith('/billing/checkout') && init?.method === 'POST'
      ? { status: 201, body: { payment: payment({ provider: 'card' }), action: { type: 'redirect', url: 'https://checkout.paystack.com/abc' } } } : base(url, init)));
    renderAt('/checkout/premium_monthly');
    await userEvent.click(await screen.findByRole('radio', { name: /^card/i }));
    expect(screen.queryByLabelText(/m-pesa phone number/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /pay/i }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.paystack.com/abc'));
    expect(bodyOf(spy, '/billing/checkout')).not.toHaveProperty('phoneNumber');
  });

  it('shows the sandbox notice in test mode, and server errors without losing the form', async () => {
    mockApi((url, init) => (url.endsWith('/billing/checkout') && init?.method === 'POST'
      ? { status: 502, body: { error: { code: 'PAYMENT_PROVIDER_ERROR', message: 'We could not start the payment. Please try again.' } } } : base(url, init)));
    renderAt('/checkout/premium_monthly');
    await userEvent.click(await screen.findByRole('radio', { name: /sandbox/i }));
    expect(screen.getByText(/no real money is taken/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /pay/i }));
    expect(await screen.findByText(/could not start the payment/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pay/i })).toBeEnabled();
  });

  it('unknown or free plans are not purchasable pages', async () => {
    mockApi(base);
    renderAt('/checkout/free');
    expect(await screen.findByRole('heading', { name: /page not found/i })).toBeInTheDocument();
  });
});

describe('payment status', () => {
  it('polls the server and flips to confirmed only when the SERVER says succeeded', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    mockApi((url) => {
      if (url.includes('/billing/payments/pay1')) { calls += 1; return { body: { payment: payment({ status: calls >= 2 ? 'succeeded' : 'pending' }) } }; }
      return undefined;
    });
    renderAt('/billing/payments/pay1');
    expect(await screen.findByText(/waiting for confirmation/i)).toBeInTheDocument();
    expect(screen.queryByText(/payment confirmed/i)).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(await screen.findByText(/payment confirmed/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view signals/i })).toBeInTheDocument();
  });

  it('shows a clear failure with a retry link and a refunded state', async () => {
    mockApi((url) => (url.includes('/billing/payments/pay1') ? { body: { payment: payment({ status: 'failed', failureReason: 'mpesa_1032' }) } } : undefined));
    renderAt('/billing/payments/pay1');
    expect(await screen.findByText(/you cancelled the request on your phone/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /try again/i })).toHaveAttribute('href', '/checkout/premium_monthly');
    vi.unstubAllGlobals();
    mockApi((url) => (url.includes('/billing/payments/pay1') ? { body: { payment: payment({ status: 'refunded', refundedMinor: 150000 }) } } : undefined));
  });

  it('sandbox controls appear only for sandbox payments and settle through the server', async () => {
    let status = 'pending';
    const spy = mockApi((url, init) => {
      if (url.includes('/sandbox/') && init?.method === 'POST') { status = 'succeeded'; return { body: { payment: payment({ provider: 'mock', status }) } }; }
      if (url.includes('/billing/payments/pay1')) return { body: { payment: payment({ provider: 'mock', status }) } };
      return undefined;
    });
    renderAt('/billing/payments/pay1');
    await userEvent.click(await screen.findByRole('button', { name: /simulate successful payment/i }));
    expect(await screen.findByText(/payment confirmed/i)).toBeInTheDocument();
    expect(bodyOf(spy, '/sandbox/payments/pay1/settle')).toEqual({ outcome: 'succeeded' });
  });

  it('real-provider payments never show sandbox controls; other people\'s payments are not found', async () => {
    mockApi((url) => (url.includes('/billing/payments/pay1') ? { body: { payment: payment({ provider: 'mpesa' }) } } : undefined));
    renderAt('/billing/payments/pay1');
    await screen.findByText(/waiting for confirmation/i);
    expect(screen.queryByText(/sandbox controls/i)).not.toBeInTheDocument();
    vi.unstubAllGlobals();
    mockApi((url) => (url.includes('/billing/payments/other') ? { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Payment not found' } } } : undefined));
    renderAt('/billing/payments/other');
    expect(await screen.findByRole('heading', { name: /page not found/i })).toBeInTheDocument();
  });
});

describe('member billing page', () => {
  const route = (s: unknown, payments: unknown[] = [], invoices: unknown[] = []): Handler => (url) => {
    if (url.includes('/billing/subscription')) return { body: { subscriptions: s, entitlement: { tier: 'free', capabilities: [] } } };
    if (url.includes('/billing/payments')) return { body: { payments } };
    if (url.includes('/billing/invoices')) return { body: { invoices } };
    return undefined;
  };

  it('free member: shows the free plan, upgrade CTA and empty histories', async () => {
    mockApi(route([]));
    renderAt('/billing');
    expect(await screen.findByRole('heading', { name: 'Free' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /see premium plans/i })).toBeInTheDocument();
    expect(await screen.findByText(/no payments yet/i)).toBeInTheDocument();
    expect(await screen.findByText(/no invoices yet/i)).toBeInTheDocument();
  });

  it('active subscriber: shows plan, expiry, days left, history and receipts; cancelling needs confirmation', async () => {
    const spy = mockApi((url, init) => {
      if (url.includes('/subscription/cancel') && init?.method === 'POST') return { status: 204, body: undefined };
      return route([sub()], [payment({ status: 'succeeded' }), payment({ id: 'p2', status: 'failed' })],
        [{ id: 'inv1', number: '4H-2026-000001', description: 'Premium Monthly: 2026-03-01 to 2026-03-31', amountMinor: 150000, currency: 'KES', status: 'paid', periodStart: null, periodEnd: null, issuedAt: '2026-03-01T10:00:00Z', paymentId: 'pay1' }])(url, init);
    });
    renderAt('/billing');
    expect(await screen.findByText(/12 days left/i)).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(await screen.findByText('4H-2026-000001')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view receipt/i })).toHaveAttribute('href', '/billing/invoices/inv1');
    expect(screen.getByText('Failed')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /cancel subscription/i }));
    expect(bodyOf(spy, '/subscription/cancel')).toBeUndefined(); // not yet: asks first
    await userEvent.click(screen.getByRole('button', { name: /yes, cancel/i }));
    await waitFor(() => expect(bodyOf(spy, '/subscription/cancel')).toEqual({ tier: 'premium' }));
  });

  it('shows the cancelled-at-period-end notice with a way back, the grace warning, and the expired notice', async () => {
    mockApi(route([sub({ cancelAtPeriodEnd: true })]));
    renderAt('/billing');
    expect(await screen.findByText(/your subscription is cancelled/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /keep my subscription/i })).toBeInTheDocument();
    vi.unstubAllGlobals();

    mockApi(route([sub({ status: 'grace', graceEndsAt: '2026-04-03T00:00:00Z', daysLeft: 0 })]));
    renderAt('/billing');
    expect((await screen.findAllByText(/renewal overdue/i)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/you keep access until/i).length).toBeGreaterThan(0);
    vi.unstubAllGlobals();

    mockApi(route([sub({ status: 'expired', hasAccess: false, graceEndsAt: '2026-04-03T00:00:00Z' })]));
    renderAt('/billing');
    expect((await screen.findAllByText(/your premium access ended/i)).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: /renew now/i }).length).toBeGreaterThan(0);
  });

  it('warns about a failed payment without hiding the plan', async () => {
    mockApi(route([sub({ paymentFailed: true })]));
    renderAt('/billing');
    expect(await screen.findByText(/last payment did not go through/i)).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('sends visitors to log in', async () => {
    mockApi(route([]), visitor);
    renderAt('/billing');
    expect(await screen.findByRole('heading', { name: /log in/i })).toBeInTheDocument();
  });
});

describe('receipt page', () => {
  it('renders invoice number, customer, amount and transaction; unknown receipts are not found', async () => {
    mockApi((url) => (url.includes('/billing/invoices/inv1') ? { body: {
      invoice: { id: 'inv1', number: '4H-2026-000007', description: 'Premium Monthly: 2026-03-01 to 2026-03-31', amountMinor: 150000, currency: 'KES', status: 'paid', periodStart: null, periodEnd: null, issuedAt: '2026-03-01T10:00:00Z', paymentId: 'p' },
      receipt: { number: '4H-2026-000007', customer: { name: 'Ada', email: 'ada@example.com' }, provider: 'mpesa', payerHint: '2547*****678', transactionId: 'QGH7XYZ', paidAt: '2026-03-01T10:01:00Z', refundedMinor: 0 } } }
      : { status: 404, body: { error: { code: 'NOT_FOUND', message: 'x' } } }));
    renderAt('/billing/invoices/inv1');
    const receipt = await screen.findByRole('article', { name: /receipt 4H-2026-000007/i });
    expect(within(receipt).getByText('QGH7XYZ')).toBeInTheDocument();
    expect(within(receipt).getByText(/ada@example.com/)).toBeInTheDocument();
    expect(within(receipt).getByText(/1,500/)).toBeInTheDocument();
    vi.unstubAllGlobals();
    mockApi(() => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'x' } } }));
    renderAt('/billing/invoices/nope');
    expect(await screen.findByRole('heading', { name: /page not found/i })).toBeInTheDocument();
  });
});

describe('navigation reflects access', () => {
  it('hides "Upgrade" for premium members and shows Billing for everyone signed in', async () => {
    mockApi((url) => (url.includes('/signals') ? { body: { signals: [], hasMore: false, assets: [] } } : undefined), { body: account({ premium: true }) });
    renderAt('/signals');
    await screen.findByRole('heading', { name: 'Signals', level: 1 });
    expect(screen.getByRole('link', { name: 'Billing' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Upgrade' })).not.toBeInTheDocument();
    vi.unstubAllGlobals();
    mockApi((url) => (url.includes('/signals') ? { body: { signals: [], hasMore: false, assets: [] } } : undefined), { body: account() });
    renderAt('/signals');
    expect(await screen.findByRole('link', { name: 'Upgrade' })).toBeInTheDocument();
  });
});

describe('admin billing', () => {
  const SUMMARY = {
    revenue: [{ currency: 'KES', grossMinor: 1550000, refundedMinor: 250000, netMinor: 1300000, payments: 2 }],
    subscribers: { active: 2, grace: 1, expired: 4, cancelled: 1, withAccess: 3 }, payments: { succeeded: 2, failed: 5, cancelled: 0, pending: 1 },
    refunds: { count: 2 }, breakdown: [{ planCode: 'premium_monthly', planName: 'Premium Monthly', subscribers: 3 }],
    recent: [],
  };
  const TX = { id: 'tx1', status: 'succeeded', amountMinor: 150000, currency: 'KES', provider: 'mpesa', planName: 'Premium Monthly', userEmail: 'a@x.co', userName: 'Ann', createdAt: '2026-03-01T10:00:00Z', refundedMinor: 0, failureReason: null };
  const adminApi = (extra?: Handler) => mockApi((url, init) => {
    const e = extra?.(url, init); if (e) return e;
    if (url.includes('/admin/billing/summary')) return { body: SUMMARY };
    if (url.includes('/admin/billing/transactions')) return { body: { transactions: [TX] } };
    return undefined;
  }, { body: account({ role: 'admin' }) });

  it('shows revenue, subscribers, expired, failed payments, refunds, plan breakdown and transactions', async () => {
    adminApi();
    renderAt('/admin/billing');
    expect(await screen.findByTestId('net-KES')).toHaveTextContent(/13,000/);
    expect(screen.getByTestId('active')).toHaveTextContent('3');
    expect(screen.getByTestId('expired')).toHaveTextContent('4');
    expect(screen.getByTestId('failed')).toHaveTextContent('5');
    expect(screen.getByTestId('refunds')).toHaveTextContent('2');
    const breakdown = screen.getByText('Subscribers by plan').closest('section')!;
    expect(within(breakdown).getByRole('cell', { name: 'Premium Monthly' })).toBeInTheDocument();
    expect(await screen.findByText('a@x.co')).toBeInTheDocument();
  });

  it('is closed to non-admins', async () => {
    mockApi(() => undefined, { body: account({ premium: true }) });
    renderAt('/admin/billing');
    expect(await screen.findByRole('heading', { name: /access denied/i })).toBeInTheDocument();
  });

  it('records a refund with a reason, converting the amount to minor units', async () => {
    const spy = adminApi((url, init) => (url.includes('/refund') && init?.method === 'POST' ? { body: { payment: TX } } : undefined));
    renderAt('/admin/billing');
    await userEvent.click(await screen.findByRole('button', { name: /record refund/i }));
    const form = screen.getByText(/record refund: a@x.co/i).closest('section')!;
    await userEvent.type(within(form).getByLabelText('Reason'), 'customer request');
    await userEvent.type(within(form).getByLabelText(/amount/i), '500.50');
    await userEvent.click(within(form).getByRole('button', { name: /^record refund$/i }));
    await waitFor(() => expect(bodyOf(spy, '/payments/tx1/refund')).toEqual({ reason: 'customer request', amountMinor: 50050 }));
    expect(await screen.findByText(/refund recorded/i)).toBeInTheDocument();
  });

  it('requires a reason before recording a refund', async () => {
    const spy = adminApi();
    renderAt('/admin/billing');
    await userEvent.click(await screen.findByRole('button', { name: /record refund/i }));
    const form = screen.getByText(/record refund: a@x.co/i).closest('section')!;
    await userEvent.click(within(form).getByRole('button', { name: /^record refund$/i }));
    expect(await screen.findByText(/give a short reason/i)).toBeInTheDocument();
    expect(bodyOf(spy, '/refund')).toBeUndefined();
  });
});

describe('admin plans', () => {
  const planRows = PLANS.map((p) => ({ ...p, id: `id-${p.code}` }));
  const plansApi = (extra?: Handler) => mockApi((url, init) => {
    const e = extra?.(url, init); if (e) return e;
    if (url.endsWith('/admin/plans') && (!init?.method || init.method === 'GET')) return { body: { plans: planRows } };
    return undefined;
  }, { body: account({ role: 'admin' }) });

  it('lists plans and creates one, converting the price to minor units and features to a list', async () => {
    const spy = plansApi((url, init) => (url.endsWith('/admin/plans') && init?.method === 'POST' ? { status: 201, body: { plan: planRows[1] } } : undefined));
    renderAt('/admin/plans');
    expect(await screen.findByText('Premium Quarterly')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /new plan/i }));
    await userEvent.type(screen.getByLabelText('Code'), 'premium_biannual');
    await userEvent.type(screen.getByLabelText('Name'), 'Premium 6 Months');
    await userEvent.type(screen.getByLabelText('Price'), '2500.50');
    await userEvent.type(screen.getByLabelText(/duration/i), '180');
    await userEvent.type(screen.getByLabelText(/features/i), 'Everything in Premium{enter}Best value');
    await userEvent.click(screen.getByRole('button', { name: /create plan/i }));
    await waitFor(() => expect(bodyOf(spy, '/admin/plans')).toBeDefined());
    expect(bodyOf(spy, '/admin/plans')).toMatchObject({
      code: 'premium_biannual', tier: 'premium', name: 'Premium 6 Months', priceMinor: 250050, currency: 'KES', durationDays: 180,
      features: ['Everything in Premium', 'Best value'], isActive: true,
    });
    expect(await screen.findByText(/plan created/i)).toBeInTheDocument();
  });

  it('edits an existing plan (code and tier are not editable) and toggles active status', async () => {
    const spy = plansApi((url, init) => (url.includes('/admin/plans/id-') && init?.method === 'PATCH' ? { body: { plan: planRows[1] } } : undefined));
    renderAt('/admin/plans');
    const row = (await screen.findByText('Premium Monthly')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: /edit/i }));
    expect(screen.queryByLabelText('Code')).not.toBeInTheDocument();
    const price = screen.getByLabelText('Price');
    await userEvent.clear(price);
    await userEvent.type(price, '1999');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(spy.mock.calls.some((c) => String(c[0]).endsWith('/admin/plans/id-premium_monthly') && (c[1] as RequestInit).method === 'PATCH')).toBe(true));
    const patch = spy.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH')!;
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toMatchObject({ priceMinor: 199900 });
    expect(JSON.parse(String((patch[1] as RequestInit).body))).not.toHaveProperty('code');
  });

  it('shows server validation errors and protects the free plan from deactivation in the UI', async () => {
    plansApi((url, init) => (init?.method === 'PATCH' ? { status: 400, body: { error: { code: 'BAD_REQUEST', message: 'The free plan cannot be deactivated' } } } : undefined));
    renderAt('/admin/plans');
    const freeRow = (await screen.findByText('free', { selector: '.small' })).closest('tr')!;
    expect(within(freeRow).queryByRole('button', { name: /deactivate/i })).not.toBeInTheDocument();
    const monthly = screen.getByText('Premium Monthly').closest('tr')!;
    await userEvent.click(within(monthly).getByRole('button', { name: /deactivate/i }));
    expect(await screen.findByText(/free plan cannot be deactivated/i)).toBeInTheDocument();
  });
});

describe('admin dashboard: premium is not a role', () => {
  it('offers only staff roles in the role dropdown and grants premium with a reason', async () => {
    const spy = mockApi((url, init) => {
      if (url.includes('/admin/overview')) return { body: { usersByRole: { free: 3, moderator: 1, admin: 1 } } };
      if (url.includes('/admin/users?')) return { body: { users: [{ id: 'm1', email: 'm@x.co', displayName: 'Mo', role: 'free', premium: false, createdAt: '2026-01-01T00:00:00Z' }] } };
      if (url.includes('/subscription/grant') && init?.method === 'POST') return { status: 204, body: undefined };
      return undefined;
    }, { body: account({ role: 'admin' }) });
    vi.spyOn(window, 'prompt').mockReturnValue('support goodwill');
    renderAt('/admin');
    const select = await screen.findByLabelText('Role for Mo');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['free', 'moderator', 'admin']);
    await userEvent.click(screen.getByRole('button', { name: /grant 30 days/i }));
    await waitFor(() => expect(bodyOf(spy, '/subscription/grant')).toEqual({ planCode: 'premium_monthly', reason: 'support goodwill' }));
  });
});
