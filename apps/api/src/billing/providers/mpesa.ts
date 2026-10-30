import { createHash, timingSafeEqual } from 'node:crypto';
import {
  InvalidWebhookError, ProviderError,
  type FetchLike, type InitiateInput, type InitiateResult, type PaymentProvider, type ProviderPaymentStatus, type WebhookEvent,
} from './types.js';

export interface MpesaConfig {
  env: 'sandbox' | 'production';
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  /** Secret embedded in our callback URL. Daraja callbacks are unsigned, so this plus server-side verification is the defence. */
  callbackToken: string;
}

const HOSTS = { sandbox: 'https://sandbox.safaricom.co.ke', production: 'https://api.safaricom.co.ke' } as const;

/** Normalises Kenyan numbers (07.., 01.., +254.., 254..) to 2547XXXXXXXX / 2541XXXXXXXX. */
export function normalizeKenyanMsisdn(input: string): string | null {
  const digits = input.replace(/[\s()-]/g, '').replace(/^\+/, '');
  const m = /^(?:254|0)?([71]\d{8})$/.exec(digits);
  return m ? `254${m[1]}` : null;
}
const mask = (msisdn: string) => `${msisdn.slice(0, 4)}*****${msisdn.slice(-3)}`;

const stamp = (d: Date) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14);

/** Safaricom Daraja "Lipa na M-Pesa Online" (STK push) adapter. */
export class MpesaProvider implements PaymentProvider {
  readonly id = 'mpesa';
  readonly displayName = 'M-Pesa';
  readonly method = 'mobile_money' as const;
  readonly supportedCurrencies = ['KES'] as const;
  private token: { value: string; expires: number } | null = null;

  constructor(private readonly cfg: MpesaConfig, private readonly http: FetchLike, private readonly now: () => Date = () => new Date()) {}

  prepareCustomer(input: { phoneNumber?: string }) {
    if (!input.phoneNumber) return { ok: false as const, message: 'Enter your M-Pesa phone number' };
    const msisdn = normalizeKenyanMsisdn(input.phoneNumber);
    if (!msisdn) return { ok: false as const, message: 'Enter a valid Safaricom number, e.g. 0712345678' };
    return { ok: true as const, phoneNumber: msisdn, payerHint: mask(msisdn) };
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 30_000) return this.token.value;
    const basic = Buffer.from(`${this.cfg.consumerKey}:${this.cfg.consumerSecret}`).toString('base64');
    const res = await this.http(`${HOSTS[this.cfg.env]}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${basic}` } }).catch(() => null);
    const body = res && res.ok ? ((await res.json()) as { access_token?: string; expires_in?: string }) : null;
    if (!body?.access_token) throw new ProviderError('mpesa: could not obtain access token');
    this.token = { value: body.access_token, expires: Date.now() + Number(body.expires_in ?? 3000) * 1000 };
    return this.token.value;
  }

  private password(ts: string) {
    return Buffer.from(`${this.cfg.shortcode}${this.cfg.passkey}${ts}`).toString('base64');
  }

  private async call(path: string, payload: object): Promise<Record<string, unknown>> {
    const token = await this.accessToken();
    const res = await this.http(`${HOSTS[this.cfg.env]}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }).catch(() => null);
    if (!res) throw new ProviderError('mpesa: network error');
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok && body.ResultCode === undefined) throw new ProviderError(`mpesa: HTTP ${res.status}`);
    return body;
  }

  async initiate(input: InitiateInput): Promise<InitiateResult> {
    if (input.amountMinor % 100 !== 0) throw new ProviderError('mpesa: amount must be whole shillings');
    const ts = stamp(this.now());
    const phone = input.customer.phoneNumber;
    if (!phone) throw new ProviderError('mpesa: phone number required');
    const body = await this.call('/mpesa/stkpush/v1/processrequest', {
      BusinessShortCode: this.cfg.shortcode, Password: this.password(ts), Timestamp: ts,
      TransactionType: 'CustomerPayBillOnline', Amount: input.amountMinor / 100, PartyA: phone, PartyB: this.cfg.shortcode,
      PhoneNumber: phone, CallBackURL: `${input.callbackUrl}?token=${encodeURIComponent(this.cfg.callbackToken)}`, AccountReference: '4HUB', TransactionDesc: input.description.slice(0, 20),
    });
    if (String(body.ResponseCode) !== '0' || typeof body.CheckoutRequestID !== 'string') throw new ProviderError(`mpesa: STK push rejected (${String(body.ResponseCode)})`);
    return { providerReference: body.CheckoutRequestID, action: { type: 'prompt', message: 'Check your phone and enter your M-Pesa PIN to approve the payment.' } };
  }

  verifyWebhook(raw: Buffer, _headers: unknown, query: Record<string, string | undefined>): WebhookEvent | null {
    // Daraja does not sign callbacks. We require our secret token in the URL (constant-time compare) and, before any
    // access is granted, the service independently confirms the result with verifyPayment().
    const given = Buffer.from(createHash('sha256').update(query.token ?? '').digest());
    const want = Buffer.from(createHash('sha256').update(this.cfg.callbackToken).digest());
    if (!timingSafeEqual(given, want)) throw new InvalidWebhookError('bad callback token');
    let cb: Record<string, unknown> | undefined;
    try { cb = ((JSON.parse(raw.toString('utf8')) as { Body?: { stkCallback?: Record<string, unknown> } }).Body?.stkCallback); } catch { throw new InvalidWebhookError('malformed body'); }
    if (!cb || typeof cb.CheckoutRequestID !== 'string' || cb.ResultCode === undefined) throw new InvalidWebhookError('malformed callback');
    const code = Number(cb.ResultCode);
    const items = ((cb.CallbackMetadata as { Item?: { Name: string; Value?: unknown }[] } | undefined)?.Item) ?? [];
    const item = (n: string) => items.find((i) => i.Name === n)?.Value;
    const eventId = `${cb.CheckoutRequestID}:${code}`;
    if (code === 0) {
      const amount = Number(item('Amount'));
      return {
        eventId, type: 'payment.succeeded', providerReference: cb.CheckoutRequestID, currency: 'KES',
        ...(Number.isFinite(amount) ? { amountMinor: Math.round(amount * 100) } : {}),
        ...(typeof item('MpesaReceiptNumber') === 'string' ? { providerTransactionId: item('MpesaReceiptNumber') as string } : {}),
      };
    }
    // 1032 = cancelled by the customer; everything else (insufficient funds, timeout, wrong PIN...) is a failure.
    return { eventId, type: code === 1032 ? 'payment.cancelled' : 'payment.failed', providerReference: cb.CheckoutRequestID, failureReason: `mpesa_${code}` };
  }

  async verifyPayment(ref: string): Promise<ProviderPaymentStatus> {
    const ts = stamp(this.now());
    const body = await this.call('/mpesa/stkpushquery/v1/query', {
      BusinessShortCode: this.cfg.shortcode, Password: this.password(ts), Timestamp: ts, CheckoutRequestID: ref,
    });
    // Daraja answers 500.001.1001 "still being processed" while the customer has not acted yet.
    if (body.ResultCode === undefined) return { status: 'pending' };
    const code = Number(body.ResultCode);
    if (code === 0) return { status: 'succeeded', currency: 'KES' }; // the query API does not return the amount
    return { status: code === 1032 ? 'cancelled' : 'failed', failureReason: `mpesa_${code}` };
  }
}
