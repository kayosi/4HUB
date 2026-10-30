import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import {
  InvalidWebhookError, ProviderError,
  type FetchLike, type InitiateInput, type InitiateResult, type PaymentProvider, type ProviderPaymentStatus, type WebhookEvent,
} from './types.js';

const BASE = 'https://api.paystack.co';

/**
 * Card payments through Paystack's HOSTED checkout. The customer enters card details on Paystack's page, so card
 * numbers never reach (or get stored by) 4HUB. Another gateway can replace this by implementing PaymentProvider.
 */
export class PaystackCardProvider implements PaymentProvider {
  readonly id = 'card';
  readonly displayName = 'Card';
  readonly method = 'card' as const;
  readonly supportedCurrencies = ['KES', 'USD', 'ZAR', 'NGN', 'GHS'] as const;

  constructor(private readonly secretKey: string, private readonly http: FetchLike) {}

  prepareCustomer() { return { ok: true as const }; }

  private async call(path: string, init: { method?: string; body?: object } = {}): Promise<{ status?: boolean; data?: Record<string, unknown> }> {
    const res = await this.http(`${BASE}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json' },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    }).catch(() => null);
    if (!res) throw new ProviderError('paystack: network error');
    if (!res.ok) throw new ProviderError(`paystack: HTTP ${res.status}`);
    return (await res.json()) as { status?: boolean; data?: Record<string, unknown> };
  }

  async initiate(input: InitiateInput): Promise<InitiateResult> {
    // We choose the reference (our payment id), so webhooks can never arrive before we know it.
    const r = await this.call('/transaction/initialize', {
      method: 'POST',
      body: {
        email: input.customer.email, amount: input.amountMinor, currency: input.currency, reference: input.paymentId,
        callback_url: input.returnUrl, channels: ['card'], metadata: { paymentId: input.paymentId },
      },
    });
    const url = r.data?.authorization_url;
    if (!r.status || typeof url !== 'string') throw new ProviderError('paystack: initialization rejected');
    return { providerReference: input.paymentId, action: { type: 'redirect', url } };
  }

  verifyWebhook(raw: Buffer, headers: IncomingHttpHeaders): WebhookEvent | null {
    const sig = headers['x-paystack-signature'];
    if (typeof sig !== 'string') throw new InvalidWebhookError('missing signature');
    const expected = createHmac('sha512', this.secretKey).update(raw).digest();
    const given = Buffer.from(sig, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new InvalidWebhookError('bad signature');
    let body: { event?: string; data?: Record<string, unknown> };
    try { body = JSON.parse(raw.toString('utf8')) as typeof body; } catch { throw new InvalidWebhookError('malformed body'); }
    const d = body.data ?? {};
    if (body.event === 'charge.success' && typeof d.reference === 'string' && d.id !== undefined) {
      return {
        eventId: `charge.success:${String(d.id)}`, type: 'payment.succeeded', providerReference: d.reference,
        ...(typeof d.amount === 'number' ? { amountMinor: d.amount } : {}), ...(typeof d.currency === 'string' ? { currency: d.currency } : {}),
        providerTransactionId: String(d.id),
      };
    }
    if (body.event === 'refund.processed' && typeof d.transaction_reference === 'string' && d.id !== undefined) {
      return {
        eventId: `refund.processed:${String(d.id)}`, type: 'payment.refunded', providerReference: d.transaction_reference,
        ...(typeof d.amount === 'number' ? { refundAmountMinor: d.amount } : {}),
      };
    }
    return null; // authentic but not something we act on
  }

  async verifyPayment(ref: string): Promise<ProviderPaymentStatus> {
    const r = await this.call(`/transaction/verify/${encodeURIComponent(ref)}`);
    const d = r.data ?? {};
    const common = {
      ...(typeof d.amount === 'number' ? { amountMinor: d.amount } : {}),
      ...(typeof d.currency === 'string' ? { currency: d.currency } : {}),
      ...(d.id !== undefined ? { providerTransactionId: String(d.id) } : {}),
    };
    switch (d.status) {
      case 'success': return { status: 'succeeded', ...common };
      case 'failed': return { status: 'failed', failureReason: typeof d.gateway_response === 'string' ? d.gateway_response : 'card_declined', ...common };
      case 'abandoned': return { status: 'cancelled', failureReason: 'abandoned' };
      case 'pending': case 'ongoing': case 'processing': case 'queued': return { status: 'pending' };
      default: return { status: 'unknown' };
    }
  }
}
