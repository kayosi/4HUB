import type { Db } from '../db/index.js';
import type { EventBus, SignalRef } from '../events.js';
import { getRoomById } from '../rooms/repo.js';
import { reporterIdsFor } from '../moderation/repo.js';
import type { NotificationService } from './service.js';
import type { PrefKey } from './model.js';
import * as t from './templates.js';

/**
 * The only place that knows which events become which notifications. Business modules just announce events (events.ts);
 * adding, changing or silencing a notification means editing this file and nothing else.
 *
 * Every handler is idempotent through its dedupe key: the same real-world event can be announced twice (a retried webhook, a
 * replay) and still notifies each person once.
 */
export function registerNotificationHandlers(bus: EventBus, n: NotificationService, db: Db): void {
  // ------------------------------------------------------------------------------------------------ signals
  /** Members who opted in, excluding the author; for updates to premium signals, only those who can actually see them. */
  async function signalAudience(e: SignalRef, pref: PrefKey, premiumViewersOnly: boolean): Promise<string[]> {
    const wanting = await n.usersWanting(pref, [e.actorId]);
    return premiumViewersOnly ? n.premiumViewers(wanting) : wanting.map((u) => u.id);
  }
  // A new premium signal is announced to everyone (it appears locked in the feed anyway); its later updates are not.
  bus.on('signal.published', async (e) => n.notifyMany(await signalAudience(e, 'newSignals', false), t.signalPublished(e), `signal:${e.signalId}:published`));
  bus.on('signal.updated', async (e) => n.notifyMany(await signalAudience(e, 'signalUpdates', e.visibility === 'premium'), t.signalUpdated(e), `signal:${e.signalId}:update:${e.updateId}`));
  bus.on('signal.closed', async (e) => n.notifyMany(await signalAudience(e, 'signalUpdates', e.visibility === 'premium'), t.signalClosed(e), `signal:${e.signalId}:closed`));

  // ---------------------------------------------------------------------------------------- payments (always sent)
  bus.on('payment.succeeded', async (e) => void (await n.create({ userId: e.userId, ...t.paymentSucceeded(e), dedupeKey: `payment:${e.paymentId}:succeeded` })));
  bus.on('payment.failed', async (e) => void (await n.create({ userId: e.userId, ...t.paymentFailed(e), dedupeKey: `payment:${e.paymentId}:failed` })));
  bus.on('payment.refunded', async (e) => void (await n.create({ userId: e.userId, ...t.paymentRefunded(e), dedupeKey: `payment:${e.paymentId}:refund:${e.totalRefundedMinor}` })));

  // ------------------------------------------------------------------------------------ subscriptions (always sent)
  bus.on('subscription.started', async (e) => void (await n.create({
    userId: e.userId, ...t.subscriptionStarted(e),
    // One per payment (a payment grants access at most once); an admin grant has no payment, so key it by the period it created.
    dedupeKey: e.paymentId ? `payment:${e.paymentId}:subscription` : `subscription:${e.subscriptionId}:grant:${e.until.toISOString()}`,
  })));
  bus.on('subscription.revoked', async (e) => void (await n.create({ userId: e.userId, ...t.subscriptionRevoked(e), dedupeKey: `subscription:${e.subscriptionId}:revoked:${e.at.toISOString()}` })));

  // ----------------------------------------------------------------------------------- community (moderation outcomes)
  const roomOf = async (roomId: string) => {
    const r = await getRoomById(db, roomId);
    return { name: r?.name ?? 'a community room', slug: r?.slug ?? '' };
  };
  /** Tells the people who filed these reports that they were reviewed. Says only the outcome, never who was involved. */
  const tellReporters = async (reportIds: string[], outcome: 'resolved' | 'dismissed') => {
    for (const r of await reporterIdsFor(db, reportIds)) {
      await n.create({ userId: r.reporter_id, ...t.reportReviewed(outcome), dedupeKey: `report:${r.id}:closed` });
    }
  };
  bus.on('moderation.message_hidden', async (e) => {
    await n.create({ userId: e.authorId, ...t.messageHidden(e, await roomOf(e.roomId)), dedupeKey: `message:${e.messageId}:hidden:${e.at.toISOString()}` });
    await tellReporters(e.reportIds, 'resolved');
  });
  bus.on('moderation.message_removed', async (e) => {
    await n.create({ userId: e.authorId, ...t.messageRemoved(e, await roomOf(e.roomId)), dedupeKey: `message:${e.messageId}:removed` });
    await tellReporters(e.reportIds, 'resolved');
  });
  bus.on('moderation.message_unhidden', async (e) =>
    void (await n.create({ userId: e.authorId, ...t.messageRestored(e, await roomOf(e.roomId)), dedupeKey: `message:${e.messageId}:unhidden:${e.at.toISOString()}` })));
  bus.on('moderation.report_closed', (e) => tellReporters([e.reportId], e.outcome));
  bus.on('moderation.restricted', async (e) => void (await n.create({ userId: e.userId, ...t.accountRestricted(e), dedupeKey: `restriction:${e.restrictionId}:created` })));
  bus.on('moderation.restriction_lifted', async (e) => void (await n.create({ userId: e.userId, ...t.restrictionLifted(e), dedupeKey: `restriction:${e.restrictionId}:lifted` })));
}
