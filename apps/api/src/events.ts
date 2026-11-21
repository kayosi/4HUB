import type { FastifyBaseLogger } from 'fastify';

/**
 * Domain events: the seam between business code and everything that merely REACTS to it (today: notifications).
 * Business code announces what happened, after it has been committed, and knows nothing about who listens. Listeners can
 * therefore be added, changed or removed without touching billing, signal or moderation logic.
 *
 * Payloads carry ids and plain facts only; listeners look up anything else they need.
 */
export interface SignalRef {
  signalId: string;
  asset: string;
  direction: 'buy' | 'sell';
  timeframe: string;
  visibility: 'free' | 'premium';
  actorId: string;
}

export interface EventMap {
  'signal.published': SignalRef;
  'signal.updated': SignalRef & { updateId: string; kind: string; message: string };
  'signal.closed': SignalRef & { result: string };

  'payment.succeeded': { paymentId: string; userId: string; amountMinor: number; currency: string; planName: string };
  'payment.failed': { paymentId: string; userId: string; amountMinor: number; currency: string; planName: string; reason: string | null };
  'payment.refunded': { paymentId: string; userId: string; amountMinor: number; totalRefundedMinor: number; currency: string; planName: string; full: boolean };

  /** Access was started or extended: first purchase, renewal, reactivation, upgrade, or an administrator's grant. */
  'subscription.started': {
    subscriptionId: string; userId: string; tier: string; planName: string;
    kind: 'initial' | 'renewal' | 'reactivation' | 'upgrade' | 'grant'; until: Date; paymentId: string | null;
  };
  'subscription.revoked': { subscriptionId: string; userId: string; tier: string; at: Date };

  'moderation.message_hidden': { messageId: string; authorId: string; roomId: string; reason: string; reportIds: string[]; at: Date };
  'moderation.message_unhidden': { messageId: string; authorId: string; roomId: string; at: Date };
  'moderation.message_removed': { messageId: string; authorId: string; roomId: string; reason: string; reportIds: string[]; at: Date };
  'moderation.report_closed': { reportId: string; outcome: 'resolved' | 'dismissed' };
  'moderation.restricted': { restrictionId: string; userId: string; type: 'muted' | 'suspended'; reason: string; expiresAt: Date | null };
  'moderation.restriction_lifted': { restrictionId: string; userId: string; type: 'muted' | 'suspended' };
}

export type EventType = keyof EventMap;
export type PendingEvent = { [K in EventType]: { type: K; payload: EventMap[K] } }[EventType];
type Handler<K extends EventType> = (payload: EventMap[K]) => Promise<void> | void;

/**
 * In-process publish/subscribe. A failing listener is logged and never breaks the business operation that raised the event or
 * the other listeners: a notification problem must not fail a payment. Because events are announced after commit, a crash in
 * between loses the announcement; every listener is idempotent, so replaying an event is always safe.
 * (If delivery must survive crashes, replace emit() with a persisted outbox; callers do not change.)
 */
export class EventBus {
  private handlers = new Map<EventType, Handler<EventType>[]>();
  constructor(private readonly log?: Pick<FastifyBaseLogger, 'error'>) {}

  on<K extends EventType>(type: K, handler: Handler<K>): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler as Handler<EventType>]);
  }

  async emit<K extends EventType>(type: K, payload: EventMap[K]): Promise<void> {
    for (const h of this.handlers.get(type) ?? []) {
      try { await h(payload); } catch (err) { this.log?.error({ err, event: type }, 'event handler failed'); }
    }
  }

  async emitAll(events: PendingEvent[]): Promise<void> {
    for (const e of events) await this.emit(e.type, e.payload as never);
  }
}
