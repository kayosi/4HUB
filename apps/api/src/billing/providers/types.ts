import type { IncomingHttpHeaders } from 'node:http';

/**
 * Payment provider contract. Business logic (checkout, webhooks, subscriptions) depends ONLY on this interface;
 * adding a provider means writing one adapter and registering it, with no changes to billing logic.
 */
export type PaymentMethod = 'mobile_money' | 'card' | 'sandbox';

export interface InitiateInput {
  paymentId: string;
  amountMinor: number;
  currency: string;
  description: string;
  customer: { userId: string; email: string; phoneNumber?: string };
  /** Where a hosted checkout should send the customer back to. */
  returnUrl: string;
  /** Public URL the provider should call with webhooks. */
  callbackUrl: string;
}

export type NextAction = { type: 'prompt'; message: string } | { type: 'redirect'; url: string };
export interface InitiateResult {
  providerReference: string;
  action: NextAction;
}

export type ObservedStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
/** What the provider itself tells us about a payment when we ask (never what the browser claims). */
export interface ProviderPaymentStatus {
  status: ObservedStatus;
  amountMinor?: number;
  currency?: string;
  failureReason?: string;
  providerTransactionId?: string;
}

export type WebhookEventType = 'payment.succeeded' | 'payment.failed' | 'payment.cancelled' | 'payment.refunded';
export interface WebhookEvent {
  /** Stable per logical event: redelivery must produce the same id. */
  eventId: string;
  type: WebhookEventType;
  providerReference: string;
  amountMinor?: number;
  currency?: string;
  refundAmountMinor?: number;
  failureReason?: string;
  providerTransactionId?: string;
}

export interface PaymentProvider {
  readonly id: string;
  readonly displayName: string;
  readonly method: PaymentMethod;
  readonly supportedCurrencies: readonly string[];
  /** Validates/normalises customer input (e.g. phone). Returns an error message or the cleaned value. */
  prepareCustomer(input: { phoneNumber?: string }): { ok: true; phoneNumber?: string; payerHint?: string } | { ok: false; message: string };
  initiate(input: InitiateInput): Promise<InitiateResult>;
  /**
   * Authenticates and parses an incoming webhook from its RAW body.
   * Throws InvalidWebhookError if authenticity cannot be established; returns null for valid-but-irrelevant events.
   */
  verifyWebhook(raw: Buffer, headers: IncomingHttpHeaders, query: Record<string, string | undefined>): WebhookEvent | null;
  /** Asks the provider (server to server) for the authoritative status of a payment. */
  verifyPayment(providerReference: string): Promise<ProviderPaymentStatus>;
}

export class InvalidWebhookError extends Error {}
/** A provider call failed. `message` is safe to log; it is never shown to customers verbatim. */
export class ProviderError extends Error {}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean; status: number; json(): Promise<unknown>;
}>;
