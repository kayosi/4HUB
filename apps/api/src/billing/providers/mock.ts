import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SUPPORTED_CURRENCIES } from '../tiers.js';
import {
  InvalidWebhookError, ProviderError,
  type InitiateInput, type InitiateResult, type PaymentProvider, type ProviderPaymentStatus, type WebhookEvent,
} from './types.js';

type Outcome = 'succeeded' | 'failed' | 'cancelled';
interface Entry { status: 'pending' | Outcome; amountMinor: number; currency: string; transactionId?: string }

/**
 * Sandbox provider for automated tests and local development. It behaves like a real signed-webhook gateway but
 * moves no money. The registry refuses to enable it in production, so it can never "fake" a real payment.
 */
export class MockProvider implements PaymentProvider {
  readonly id = 'mock';
  readonly displayName = 'Sandbox (test payments)';
  readonly method = 'sandbox' as const;
  readonly supportedCurrencies = SUPPORTED_CURRENCIES;
  readonly ledger = new Map<string, Entry>();
  failNextInitiate = false;
  failNextVerify = false;

  constructor(private readonly secret: string) {}

  prepareCustomer() { return { ok: true as const }; }

  async initiate(input: InitiateInput): Promise<InitiateResult> {
    if (this.failNextInitiate) { this.failNextInitiate = false; throw new ProviderError('mock: initiation failed'); }
    const providerReference = `mock_${randomBytes(8).toString('hex')}`;
    this.ledger.set(providerReference, { status: 'pending', amountMinor: input.amountMinor, currency: input.currency });
    return { providerReference, action: { type: 'prompt', message: 'Sandbox payment created. Use the sandbox controls to complete it.' } };
  }

  sign(raw: Buffer | string): string {
    return createHmac('sha256', this.secret).update(raw).digest('hex');
  }

  verifyWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent | null {
    const sig = headers['x-mock-signature'];
    if (typeof sig !== 'string') throw new InvalidWebhookError('missing signature');
    const expected = Buffer.from(this.sign(raw), 'hex');
    const given = Buffer.from(sig, 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new InvalidWebhookError('bad signature');
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>; } catch { throw new InvalidWebhookError('malformed body'); }
    if (typeof body.id !== 'string' || typeof body.type !== 'string' || typeof body.reference !== 'string') throw new InvalidWebhookError('malformed event');
    if (!['payment.succeeded', 'payment.failed', 'payment.cancelled', 'payment.refunded'].includes(body.type)) return null;
    return {
      eventId: body.id, type: body.type as WebhookEvent['type'], providerReference: body.reference,
      ...(typeof body.amountMinor === 'number' ? { amountMinor: body.amountMinor } : {}),
      ...(typeof body.currency === 'string' ? { currency: body.currency } : {}),
      ...(typeof body.refundAmountMinor === 'number' ? { refundAmountMinor: body.refundAmountMinor } : {}),
      ...(typeof body.failureReason === 'string' ? { failureReason: body.failureReason } : {}),
    };
  }

  async verifyPayment(ref: string): Promise<ProviderPaymentStatus> {
    if (this.failNextVerify) { this.failNextVerify = false; throw new ProviderError('mock: verification unavailable'); }
    const e = this.ledger.get(ref);
    if (!e) return { status: 'unknown' };
    return { status: e.status, amountMinor: e.amountMinor, currency: e.currency, ...(e.transactionId ? { providerTransactionId: e.transactionId } : {}) };
  }

  // ---- test/sandbox controls (not part of the PaymentProvider contract) ----
  /** Moves the sandbox ledger to an outcome and returns a correctly signed webhook for it. */
  settle(ref: string, outcome: Outcome, eventId = `evt_${randomBytes(6).toString('hex')}`): { raw: Buffer; headers: Record<string, string> } {
    const e = this.ledger.get(ref);
    if (!e) throw new Error('unknown sandbox payment');
    e.status = outcome;
    if (outcome === 'succeeded') e.transactionId = `MOCKTX${randomBytes(4).toString('hex').toUpperCase()}`;
    return this.signedEvent({ id: eventId, type: `payment.${outcome}`, reference: ref, amountMinor: e.amountMinor, currency: e.currency });
  }
  signedEvent(body: Record<string, unknown>, secretOverride?: string): { raw: Buffer; headers: Record<string, string> } {
    const raw = Buffer.from(JSON.stringify(body));
    const sig = secretOverride ? createHmac('sha256', secretOverride).update(raw).digest('hex') : this.sign(raw);
    return { raw, headers: { 'content-type': 'application/json', 'x-mock-signature': sig } };
  }
}
