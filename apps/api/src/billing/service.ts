import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyBaseLogger } from 'fastify';
import { withTransaction, type Db } from '../db/index.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import type { AuthUser } from '../auth/access.js';
import * as repo from './repo.js';
import type { PaymentRow, PlanRow, SubscriptionRow } from './repo.js';
import { addDays, buildEntitlement, FREE_ENTITLEMENT, subscriptionState, type Entitlement, type SubscriptionState } from './subscriptions.js';
import { EventBus, type PendingEvent } from '../events.js';
import type { ProviderRegistry } from './providers/registry.js';
import {
  InvalidWebhookError, ProviderError,
  type NextAction, type PaymentProvider, type ProviderPaymentStatus, type WebhookEvent,
} from './providers/types.js';
import { isTier } from './tiers.js';

export interface BillingOptions {
  graceDays: number;
  webPublicUrl: string;
  apiPublicUrl: string;
}

export type WebhookOutcome =
  | 'applied' | 'duplicate' | 'ignored' | 'unmatched' | 'rejected_unverified' | 'rejected_mismatch';

/** Outcomes that are NOT final: the same event id may be processed again (e.g. verification was not yet ready). */
const RETRYABLE = new Set(['unmatched', 'rejected_unverified']);
type Tx = Pick<Db, 'query'>;

/** How long after creation a failed/cancelled payment may still be re-verified with the provider. */
const RECOVERY_WINDOW_MS = 7 * 86_400_000;
const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

export class BillingService {
  constructor(
    private readonly db: Db,
    readonly providers: ProviderRegistry,
    private readonly opts: BillingOptions,
    private readonly now: () => Date,
    private readonly log: FastifyBaseLogger,
    /** Announces what happened (after it is committed). Billing neither knows nor cares who listens. */
    private readonly events: EventBus = new EventBus(),
  ) {}

  // ------------------------------------------------------------------ entitlement (used on every authenticated request)
  async entitlementFor(userId: string): Promise<Entitlement> {
    return buildEntitlement(await repo.listSubscriptionsForUser(this.db, userId), this.now(), this.opts.graceDays);
  }

  /** Entitlements for many members at once (e.g. to decide who may see a premium signal), using the same rule as every request. */
  async entitlementsForUsers(userIds: string[]): Promise<Map<string, Entitlement>> {
    const now = this.now();
    const byUser = new Map<string, SubscriptionRow[]>();
    for (const sub of await repo.listPossiblyEntitledSubscriptions(this.db, addDays(now, -this.opts.graceDays))) {
      byUser.set(sub.user_id, [...(byUser.get(sub.user_id) ?? []), sub]);
    }
    return new Map(userIds.map((id) => {
      const subs = byUser.get(id);
      return [id, subs ? buildEntitlement(subs, now, this.opts.graceDays) : FREE_ENTITLEMENT];
    }));
  }

  /** Subscriptions whose period ends in (from, to], each with its current state. Drives expiry/grace/expired notices. */
  async lifecycleSubscriptions(from: Date, to: Date): Promise<{
    subscriptionId: string; userId: string; tier: string; planName: string; end: Date; cancelAtPeriodEnd: boolean; state: SubscriptionState;
  }[]> {
    const now = this.now();
    return (await repo.listSubscriptionsEndingBetween(this.db, from, to)).map((s) => ({
      subscriptionId: s.id, userId: s.user_id, tier: s.tier, planName: s.plan_name, end: s.current_period_end,
      cancelAtPeriodEnd: s.cancel_at_period_end, state: subscriptionState(s, now, this.opts.graceDays),
    }));
  }

  // ------------------------------------------------------------------ checkout
  async checkout(
    user: AuthUser,
    input: { planCode: string; provider: string; phoneNumber?: string; idempotencyKey?: string },
  ): Promise<{ payment: PaymentRow; action: NextAction | null; created: boolean }> {
    // Everything that determines price and access comes from OUR database, never from the request.
    const plan = await repo.getPlanByCode(this.db, input.planCode);
    if (!plan || !plan.is_active || plan.tier === 'free' || plan.price_minor <= 0 || !plan.duration_days || !isTier(plan.tier))
      throw new AppError(400, 'PLAN_UNAVAILABLE', 'This plan is not available for purchase');
    const provider = this.providers.get(input.provider);
    if (!provider) throw new AppError(400, 'PROVIDER_UNAVAILABLE', 'This payment method is not available');
    if (!provider.supportedCurrencies.includes(plan.currency))
      throw new AppError(400, 'CURRENCY_UNSUPPORTED', `${provider.displayName} cannot be used for ${plan.currency} plans`);
    const customer = provider.prepareCustomer({ phoneNumber: input.phoneNumber });
    if (!customer.ok) throw badRequest(customer.message, { phoneNumber: customer.message });

    if (input.idempotencyKey) {
      const existing = await repo.getPaymentByIdempotencyKey(this.db, user.id, input.idempotencyKey);
      if (existing) return this.replay(existing, plan, provider);
    }

    const id = randomUUID();
    let payment: PaymentRow;
    try {
      payment = await repo.insertPayment(this.db, {
        id, userId: user.id, planId: plan.id, amountMinor: plan.price_minor, currency: plan.currency, provider: provider.id,
        payerHint: customer.payerHint ?? null, idempotencyKey: input.idempotencyKey ?? null,
        snapshot: { code: plan.code, name: plan.name, tier: plan.tier, durationDays: plan.duration_days },
      });
    } catch (err) {
      // Two simultaneous submits with the same key: the loser reads the winner's row.
      const existing = input.idempotencyKey ? await repo.getPaymentByIdempotencyKey(this.db, user.id, input.idempotencyKey) : undefined;
      if (existing) return this.replay(existing, plan, provider);
      throw err;
    }
    await repo.audit(this.db, { actorId: user.id, action: 'payment.created', entityType: 'payment', entityId: id, data: { plan: plan.code, provider: provider.id, amountMinor: plan.price_minor, currency: plan.currency } });

    try {
      const result = await provider.initiate({
        paymentId: id, amountMinor: payment.amount_minor, currency: payment.currency,
        description: `4HUB ${plan.name}`,
        customer: { userId: user.id, email: user.email, ...(customer.phoneNumber ? { phoneNumber: customer.phoneNumber } : {}) },
        returnUrl: `${this.opts.webPublicUrl}/billing/payments/${id}`,
        callbackUrl: `${this.opts.apiPublicUrl}/api/webhooks/payments/${provider.id}`,
      });
      await repo.setPaymentReference(this.db, id, result.providerReference);
      this.log.info({ paymentId: id, provider: provider.id }, 'payment initiated');
      return { payment: (await repo.getPayment(this.db, id))!, action: result.action, created: true };
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      await repo.transitionPayment(this.db, id, { from: ['pending'], to: 'failed', failureReason: 'initiation_failed' });
      await repo.audit(this.db, { actorId: user.id, action: 'payment.initiation_failed', entityType: 'payment', entityId: id, data: { provider: provider.id, reason: err.message } });
      this.log.error({ paymentId: id, provider: provider.id, reason: err.message }, 'payment initiation failed');
      throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'We could not start the payment. Please try again.');
    }
  }

  private replay(existing: PaymentRow, plan: PlanRow, provider: PaymentProvider) {
    if (existing.plan_snapshot.code !== plan.code || existing.provider !== provider.id)
      throw conflict('This idempotency key was already used for a different checkout');
    return { payment: existing, action: null, created: false };
  }

  // ------------------------------------------------------------------ webhooks
  /** Entry point for provider callbacks. Throws 401 for unauthentic requests; otherwise reports what happened. */
  async handleWebhook(providerId: string, raw: Buffer, headers: IncomingHttpHeaders, query: Record<string, string | undefined>) {
    const provider = this.providers.get(providerId);
    if (!provider) throw notFound('Unknown payment provider');

    let event: WebhookEvent | null;
    try {
      event = provider.verifyWebhook(raw, headers, query);
    } catch (err) {
      if (!(err instanceof InvalidWebhookError)) throw err;
      await repo.audit(this.db, { action: 'webhook.rejected', entityType: 'provider', entityId: provider.id, data: { reason: err.message } });
      this.log.warn({ provider: provider.id, reason: err.message }, 'webhook rejected');
      throw new AppError(401, 'INVALID_WEBHOOK', 'Webhook could not be authenticated');
    }
    if (event === null) return { outcome: 'ignored' as WebhookOutcome };

    const outcome = await this.processEvent(provider, event);
    this.log.info({ provider: provider.id, eventId: event.eventId, type: event.type, outcome }, 'webhook processed');
    return { outcome };
  }

  /**
   * Shared core for webhooks and for server-initiated status checks. A success is only believed after the provider
   * confirms it over a direct server-to-server call, and amount/currency must match what WE recorded at checkout.
   */
  private async processEvent(provider: PaymentProvider, event: WebhookEvent, observed?: ProviderPaymentStatus): Promise<WebhookOutcome> {
    const payment = await repo.getPaymentByReference(this.db, provider.id, event.providerReference);

    let verified: ProviderPaymentStatus | null = observed ?? null;
    if (payment && event.type === 'payment.succeeded' && !verified) {
      try {
        verified = await provider.verifyPayment(event.providerReference);
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        // Do NOT record the event: the provider will redeliver and we will try again.
        throw new AppError(503, 'VERIFICATION_UNAVAILABLE', 'Payment verification is temporarily unavailable');
      }
    }

    const pending: PendingEvent[] = [];
    const outcome = await withTransaction(this.db, async (tx) => {
      let eventRowId = await repo.insertEvent(tx, {
        provider: provider.id, eventId: event.eventId, type: event.type, reference: event.providerReference,
        paymentId: payment?.id ?? null, outcome: 'received',
      });
      if (!eventRowId) {
        const existing = await repo.getEvent(tx, provider.id, event.eventId);
        if (!existing || !RETRYABLE.has(existing.outcome)) return 'duplicate';
        eventRowId = existing.id;
      }
      const outcome: WebhookOutcome = payment ? await this.applyEvent(tx, provider, payment.id, event, verified, pending) : 'unmatched';
      await repo.setEventOutcome(tx, eventRowId, outcome, payment?.id ?? null);
      return outcome;
    });
    // Only now that the change is committed. A rolled-back transaction announces nothing.
    await this.events.emitAll(pending);
    return outcome;
  }

  private async applyEvent(tx: Tx, provider: PaymentProvider, paymentId: string, event: WebhookEvent, verified: ProviderPaymentStatus | null, pending: PendingEvent[]): Promise<WebhookOutcome> {
    const p = (await repo.getPayment(tx, paymentId))!; // re-read inside the transaction: current state decides
    const at = this.now();

    if (event.type === 'payment.succeeded') {
      if (p.status === 'succeeded' || p.status === 'refunded' || p.status === 'partially_refunded') return 'ignored';
      if (!verified || verified.status !== 'succeeded') {
        await repo.audit(tx, { action: 'payment.verification_failed', entityType: 'payment', entityId: p.id, data: { eventId: event.eventId, observed: verified?.status ?? 'none' } });
        return 'rejected_unverified';
      }
      const same = <T,>(a: T | undefined, b: T) => a === undefined || a === b;
      const consistent = same(event.amountMinor, p.amount_minor) && same(verified.amountMinor, p.amount_minor) &&
        same(event.currency, p.currency) && same(verified.currency, p.currency);
      if (!consistent) {
        await repo.transitionPayment(tx, p.id, { from: ['pending'], to: 'failed', failureReason: 'amount_mismatch' });
        await repo.audit(tx, { action: 'payment.amount_mismatch', entityType: 'payment', entityId: p.id, data: { expected: { amountMinor: p.amount_minor, currency: p.currency }, event: { amountMinor: event.amountMinor, currency: event.currency }, verified: { amountMinor: verified.amountMinor, currency: verified.currency } } });
        pending.push({ type: 'payment.failed', payload: { paymentId: p.id, userId: p.user_id, amountMinor: p.amount_minor, currency: p.currency, planName: p.plan_snapshot.name, reason: 'amount_mismatch' } });
        return 'rejected_mismatch';
      }
      const updated = await repo.transitionPayment(tx, p.id, {
        from: ['pending', 'failed', 'cancelled'], to: 'succeeded', paidAt: at,
        providerTransactionId: event.providerTransactionId ?? verified.providerTransactionId ?? null,
      });
      if (!updated) return 'ignored';
      // Announced in this order so members see "payment received" before "subscription activated".
      pending.push({ type: 'payment.succeeded', payload: { paymentId: p.id, userId: p.user_id, amountMinor: p.amount_minor, currency: p.currency, planName: p.plan_snapshot.name } });
      await this.grantFromPayment(tx, updated, pending);
      await repo.audit(tx, { action: 'payment.succeeded', entityType: 'payment', entityId: p.id, data: { eventId: event.eventId } });
      return 'applied';
    }

    if (event.type === 'payment.failed' || event.type === 'payment.cancelled') {
      if (p.status !== 'pending') return 'ignored'; // a late failure must never undo a success
      const to = event.type === 'payment.failed' ? 'failed' : 'cancelled';
      const updated = await repo.transitionPayment(tx, p.id, { from: ['pending'], to, failureReason: event.failureReason ?? to });
      if (!updated) return 'ignored';
      const sub = await repo.getSubscription(tx, p.user_id, p.plan_snapshot.tier);
      if (sub) await repo.updateSubscription(tx, sub.id, { lastFailedPaymentAt: at });
      await repo.audit(tx, { action: `payment.${to}`, entityType: 'payment', entityId: p.id, data: { eventId: event.eventId, reason: event.failureReason ?? null } });
      if (to === 'failed') pending.push({ type: 'payment.failed', payload: { paymentId: p.id, userId: p.user_id, amountMinor: p.amount_minor, currency: p.currency, planName: p.plan_snapshot.name, reason: event.failureReason ?? null } });
      return 'applied';
    }

    // payment.refunded
    const done = await this.recordRefund(tx, p, event.refundAmountMinor ?? p.amount_minor, { actorId: null, source: 'provider', reason: event.eventId }, pending);
    return done ? 'applied' : 'ignored';
  }

  // ------------------------------------------------------------------ server-side verification (customer-triggered poll)
  /** Re-checks a pending payment directly with the provider. Safe to call repeatedly. */
  async syncPayment(userId: string, paymentId: string): Promise<PaymentRow> {
    const p = await repo.getPayment(this.db, paymentId);
    if (!p || p.user_id !== userId) throw notFound('Payment not found');
    // Pending payments are re-checked. Recently failed/cancelled ones too: if the provider's authoritative answer is
    // "paid" (e.g. a bad callback consumed the event, or a delayed confirmation) the customer must not stay stuck.
    const recoverable = (p.status === 'failed' || p.status === 'cancelled') && this.now().getTime() - p.created_at.getTime() < RECOVERY_WINDOW_MS;
    if ((p.status !== 'pending' && !recoverable) || !p.provider_reference) return p;
    const provider = this.providers.get(p.provider);
    if (!provider) return p;
    let observed: ProviderPaymentStatus;
    try { observed = await provider.verifyPayment(p.provider_reference); }
    catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      throw new AppError(503, 'VERIFICATION_UNAVAILABLE', 'Payment verification is temporarily unavailable');
    }
    const type = observed.status === 'succeeded' ? 'payment.succeeded' : observed.status === 'failed' ? 'payment.failed' : observed.status === 'cancelled' ? 'payment.cancelled' : null;
    if (type) {
      await this.processEvent(provider, {
        eventId: `poll:${p.id}:${observed.status}`, type, providerReference: p.provider_reference,
        ...(observed.amountMinor !== undefined ? { amountMinor: observed.amountMinor } : {}),
        ...(observed.currency ? { currency: observed.currency } : {}),
        ...(observed.failureReason ? { failureReason: observed.failureReason } : {}),
        ...(observed.providerTransactionId ? { providerTransactionId: observed.providerTransactionId } : {}),
      }, observed);
    }
    return (await repo.getPayment(this.db, p.id))!;
  }

  // ------------------------------------------------------------------ granting access
  /** Turns ONE verified payment into subscription time. The unique payment_id on the period ledger makes this once-only. */
  private async grantFromPayment(tx: Tx, payment: PaymentRow, pending: PendingEvent[]): Promise<void> {
    const snap = payment.plan_snapshot;
    const now = this.now();
    const sub = await repo.getSubscription(tx, payment.user_id, snap.tier);
    const state = sub ? subscriptionState(sub, now, this.opts.graceDays) : null;
    const base = state?.status === 'active' && sub ? sub.current_period_end : now; // renewals while active stack onto the end
    const end = addDays(base, snap.durationDays);
    const kind = !sub ? 'initial' : state?.status === 'active' ? (sub.plan_id !== payment.plan_id ? 'upgrade' : 'renewal') : state?.status === 'grace' ? 'renewal' : 'reactivation';

    let subscriptionId: string;
    if (!sub) {
      subscriptionId = (await repo.insertSubscription(tx, { userId: payment.user_id, planId: payment.plan_id, tier: snap.tier, start: base, end, source: 'payment' })).id;
    } else {
      subscriptionId = sub.id;
      await repo.updateSubscription(tx, sub.id, {
        planId: payment.plan_id, periodStart: state?.status === 'active' ? sub.current_period_start : base, periodEnd: end,
        cancelAtPeriodEnd: false, cancelledAt: null, revokedAt: null, lastFailedPaymentAt: null, source: 'payment',
      });
    }
    await repo.insertPeriod(tx, { subscriptionId, paymentId: payment.id, planId: payment.plan_id, kind, start: base, end });
    await repo.insertInvoice(tx, {
      userId: payment.user_id, paymentId: payment.id, amountMinor: payment.amount_minor, currency: payment.currency,
      description: `${snap.name}: ${fmtDate(base)} to ${fmtDate(end)}`, start: base, end, issuedAt: now,
    });
    await repo.audit(tx, { action: `subscription.${kind}`, entityType: 'subscription', entityId: subscriptionId, data: { paymentId: payment.id, tier: snap.tier, from: base.toISOString(), until: end.toISOString() } });
    pending.push({ type: 'subscription.started', payload: { subscriptionId, userId: payment.user_id, tier: snap.tier, planName: snap.name, kind, until: end, paymentId: payment.id } });
  }

  // ------------------------------------------------------------------ refunds
  private async recordRefund(tx: Tx, payment: PaymentRow, amountMinor: number, who: { actorId: string | null; source: string; reason: string }, pending: PendingEvent[]): Promise<boolean> {
    if (payment.status !== 'succeeded' && payment.status !== 'partially_refunded') return false;
    const total = Math.min(payment.amount_minor, payment.refunded_minor + Math.max(0, amountMinor));
    if (total <= payment.refunded_minor) return false;
    const full = total >= payment.amount_minor;
    const at = this.now();
    const updated = await repo.applyRefund(tx, payment.id, total, full ? 'refunded' : 'partially_refunded', at);
    if (!updated) return false;
    await repo.setInvoiceStatus(tx, payment.id, full ? 'refunded' : 'partially_refunded');
    if (full) await this.reversePeriod(tx, updated, at);
    await repo.audit(tx, { actorId: who.actorId, action: 'payment.refunded', entityType: 'payment', entityId: payment.id, data: { amountMinor, totalRefundedMinor: total, full, source: who.source, reason: who.reason } });
    pending.push({ type: 'payment.refunded', payload: { paymentId: payment.id, userId: payment.user_id, amountMinor: total - payment.refunded_minor, totalRefundedMinor: total, currency: payment.currency, planName: payment.plan_snapshot.name, full } });
    return true;
  }

  /** A fully refunded payment gives its time back: the subscription loses exactly the period that payment bought. */
  private async reversePeriod(tx: Tx, payment: PaymentRow, at: Date): Promise<void> {
    const period = await repo.getPeriodByPayment(tx, payment.id);
    const sub = await repo.getSubscription(tx, payment.user_id, payment.plan_snapshot.tier);
    if (!period || !sub) return;
    const newEnd = new Date(sub.current_period_end.getTime() - (period.period_end.getTime() - period.period_start.getTime()));
    await repo.updateSubscription(tx, sub.id, newEnd <= at ? { periodEnd: newEnd, revokedAt: at } : { periodEnd: newEnd });
    await repo.audit(tx, { action: 'subscription.period_reversed', entityType: 'subscription', entityId: sub.id, data: { paymentId: payment.id, newEnd: newEnd.toISOString(), revoked: newEnd <= at } });
  }

  /** Admin records a refund that was issued outside 4HUB (e.g. an M-Pesa reversal). No provider call is made. */
  async recordManualRefund(adminId: string, paymentId: string, amountMinor: number | undefined, reason: string): Promise<PaymentRow> {
    const pending: PendingEvent[] = [];
    const result = await withTransaction(this.db, async (tx) => {
      const p = await repo.getPayment(tx, paymentId);
      if (!p) throw notFound('Payment not found');
      const ok = await this.recordRefund(tx, p, amountMinor ?? p.amount_minor - p.refunded_minor, { actorId: adminId, source: 'admin', reason }, pending);
      if (!ok) throw conflict('This payment cannot be refunded (not paid, or already fully refunded)');
      return (await repo.getPayment(tx, paymentId))!;
    });
    await this.events.emitAll(pending);
    return result;
  }

  // ------------------------------------------------------------------ subscription lifecycle
  async subscriptionsView(userId: string) {
    const subs = await repo.listSubscriptionsForUser(this.db, userId);
    const now = this.now();
    return Promise.all(subs.map(async (s) => {
      const plan = await repo.getPlanById(this.db, s.plan_id);
      return { sub: s, plan, state: subscriptionState(s, now, this.opts.graceDays), now };
    }));
  }

  private async ownSubscription(userId: string, tier: string): Promise<SubscriptionRow> {
    const sub = await repo.getSubscription(this.db, userId, tier);
    if (!sub) throw notFound('No subscription found');
    return sub;
  }

  /** Cancellation never refunds or cuts access short: the member keeps access until the paid period ends. */
  async cancel(userId: string, tier: string): Promise<void> {
    const sub = await this.ownSubscription(userId, tier);
    const st = subscriptionState(sub, this.now(), this.opts.graceDays);
    if (!st.hasAccess) throw conflict('This subscription is not active');
    if (sub.cancel_at_period_end) throw conflict('This subscription is already set to cancel');
    await repo.updateSubscription(this.db, sub.id, { cancelAtPeriodEnd: true, cancelledAt: this.now() });
    await repo.audit(this.db, { actorId: userId, action: 'subscription.cancel_requested', entityType: 'subscription', entityId: sub.id });
  }

  async resume(userId: string, tier: string): Promise<void> {
    const sub = await this.ownSubscription(userId, tier);
    const st = subscriptionState(sub, this.now(), this.opts.graceDays);
    if (st.status !== 'active' || !sub.cancel_at_period_end) throw conflict('This subscription cannot be resumed');
    await repo.updateSubscription(this.db, sub.id, { cancelAtPeriodEnd: false, cancelledAt: null });
    await repo.audit(this.db, { actorId: userId, action: 'subscription.resumed', entityType: 'subscription', entityId: sub.id });
  }

  /** Complimentary access granted by an admin (replaces the old manual "premium" role). */
  async grant(adminId: string, userId: string, planCode: string, days: number | undefined, reason: string): Promise<SubscriptionRow> {
    const plan = await repo.getPlanByCode(this.db, planCode);
    if (!plan || plan.tier === 'free' || !isTier(plan.tier)) throw badRequest('Choose a paid plan to grant');
    const length = days ?? plan.duration_days;
    if (!length) throw badRequest('This plan has no duration; specify days');
    const pending: PendingEvent[] = [];
    const granted = await withTransaction(this.db, async (tx) => {
      const now = this.now();
      const sub = await repo.getSubscription(tx, userId, plan.tier);
      const st = sub ? subscriptionState(sub, now, this.opts.graceDays) : null;
      const base = st?.status === 'active' && sub ? sub.current_period_end : now;
      const end = addDays(base, length);
      let result: SubscriptionRow;
      if (!sub) result = await repo.insertSubscription(tx, { userId, planId: plan.id, tier: plan.tier, start: base, end, source: 'admin_grant' });
      else result = (await repo.updateSubscription(tx, sub.id, {
        planId: plan.id, periodStart: st?.status === 'active' ? sub.current_period_start : base, periodEnd: end,
        cancelAtPeriodEnd: false, cancelledAt: null, revokedAt: null, lastFailedPaymentAt: null,
      }))!;
      await repo.insertPeriod(tx, { subscriptionId: result.id, paymentId: null, planId: plan.id, kind: 'grant', start: base, end });
      await repo.audit(tx, { actorId: adminId, action: 'subscription.granted', entityType: 'subscription', entityId: result.id, data: { userId, plan: plan.code, days: length, reason, until: end.toISOString() } });
      pending.push({ type: 'subscription.started', payload: { subscriptionId: result.id, userId, tier: plan.tier, planName: plan.name, kind: 'grant', until: end, paymentId: null } });
      return result;
    });
    await this.events.emitAll(pending);
    return granted;
  }

  /** Ends access immediately (abuse, chargeback, mistaken grant). */
  async revoke(adminId: string, userId: string, tier: string, reason: string): Promise<void> {
    const sub = await this.ownSubscription(userId, tier);
    const at = this.now();
    await repo.updateSubscription(this.db, sub.id, { revokedAt: at });
    await repo.audit(this.db, { actorId: adminId, action: 'subscription.revoked', entityType: 'subscription', entityId: sub.id, data: { userId, reason } });
    await this.events.emit('subscription.revoked', { subscriptionId: sub.id, userId, tier, at });
  }
}
