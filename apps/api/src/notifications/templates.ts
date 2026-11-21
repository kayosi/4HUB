import { TIERS, isTier } from '../billing/tiers.js';
import type { NotificationContent } from './model.js';
import type { EventMap, SignalRef } from '../events.js';

/**
 * What each notification says. Pure functions of an event, so wording lives in one place.
 *
 * Safety rule for signals: a notification may only contain what the signal's public (locked) view already shows: asset, direction,
 * timeframe, visibility and the final result. Entry, stops, targets, analysis and update text of PREMIUM signals never appear
 * here, because a notification can outlive the reader's subscription.
 */
export const day = (d: Date) => d.toISOString().slice(0, 10);
const dateTime = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const side = (d: 'buy' | 'sell') => (d === 'buy' ? 'Buy' : 'Sell');
const signalName = (s: SignalRef) => `${s.asset} ${side(s.direction)}`;
const until = (d: Date | null) => (d ? `until ${dateTime(d)}` : 'until an administrator lifts it');

/** Prices are stored as integer minor units with two decimals (see billing/tiers.ts). */
export const money = (minor: number, currency: string) =>
  `${currency} ${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const RESULT_TEXT: Record<string, string> = {
  tp_hit: 'Take profit hit.', sl_hit: 'Stop loss hit.', breakeven: 'Closed at breakeven.', cancelled: 'Cancelled.',
};

export const tierLabel = (tier: string) => (isTier(tier) ? TIERS[tier].label : tier);

// ----------------------------------------------------------------------------------------------------- signals
export const signalPublished = (e: EventMap['signal.published']): NotificationContent => ({
  category: 'signal', type: 'signal.published',
  title: `New signal: ${signalName(e)}`,
  body: `${e.timeframe} · ${e.visibility === 'premium' ? 'Premium signal' : 'Free signal'}`,
  data: { signalId: e.signalId, visibility: e.visibility },
});

export const signalUpdated = (e: EventMap['signal.updated']): NotificationContent => ({
  category: 'signal', type: 'signal.updated',
  title: `Signal updated: ${signalName(e)}`,
  // The update text of a premium signal is premium content: say that something changed, not what.
  body: e.visibility === 'free' ? e.message : 'There is an update on this premium signal. Open it to see the details.',
  data: { signalId: e.signalId, visibility: e.visibility },
});

export const signalClosed = (e: EventMap['signal.closed']): NotificationContent => ({
  category: 'signal', type: 'signal.closed',
  title: `Signal closed: ${signalName(e)}`,
  body: RESULT_TEXT[e.result] ?? 'Closed.',
  data: { signalId: e.signalId, visibility: e.visibility, result: e.result },
});

// --------------------------------------------------------------------------------------------------- payments
export const paymentSucceeded = (e: EventMap['payment.succeeded']): NotificationContent => ({
  category: 'payment', type: 'payment.succeeded',
  title: 'Payment received',
  body: `We received ${money(e.amountMinor, e.currency)} for ${e.planName}. Thank you.`,
  data: { paymentId: e.paymentId },
});

export const paymentFailed = (e: EventMap['payment.failed']): NotificationContent => ({
  category: 'payment', type: 'payment.failed',
  title: 'Payment failed',
  // Provider failure codes are internal and not always meaningful to a customer, so only the amount mismatch gets its own wording.
  body: e.reason === 'amount_mismatch'
    ? `We could not verify the amount of your ${money(e.amountMinor, e.currency)} payment for ${e.planName}, so no access was granted. Contact support if you were charged.`
    : `Your ${money(e.amountMinor, e.currency)} payment for ${e.planName} could not be completed. You can try again from the billing page.`,
  data: { paymentId: e.paymentId },
});

export const paymentRefunded = (e: EventMap['payment.refunded']): NotificationContent => ({
  category: 'payment', type: 'payment.refunded',
  title: e.full ? 'Payment refunded' : 'Partial refund issued',
  body: `${money(e.amountMinor, e.currency)} was refunded for ${e.planName}.${e.full ? ' The access this payment bought has been removed.' : ''}`,
  data: { paymentId: e.paymentId },
});

// --------------------------------------------------------------------------------------------- subscriptions
export const subscriptionStarted = (e: EventMap['subscription.started']): NotificationContent => {
  const data = { subscriptionId: e.subscriptionId, tier: e.tier, ...(e.paymentId ? { paymentId: e.paymentId } : {}) };
  if (e.kind === 'renewal') return { category: 'subscription', type: 'subscription.renewed', title: `${e.planName} renewed`, body: `Your access now runs until ${day(e.until)}.`, data };
  if (e.kind === 'grant') return { category: 'subscription', type: 'subscription.granted', title: `You now have ${e.planName}`, body: `An administrator gave you ${e.planName} access until ${day(e.until)}.`, data };
  return { category: 'subscription', type: 'subscription.activated', title: `${e.planName} activated`, body: `Your access runs until ${day(e.until)}.`, data };
};

export const subscriptionRevoked = (e: EventMap['subscription.revoked']): NotificationContent => ({
  category: 'subscription', type: 'subscription.revoked',
  title: `${tierLabel(e.tier)} access ended`,
  body: 'Your access was ended. If you think this is a mistake, please contact support.',
  data: { subscriptionId: e.subscriptionId, tier: e.tier },
});

interface Lifecycle { subscriptionId: string; tier: string; planName: string; end: Date; graceEndsAt: Date | null; cancelAtPeriodEnd: boolean }
const lifecycleData = (s: Lifecycle) => ({ subscriptionId: s.subscriptionId, tier: s.tier });

export const subscriptionExpiring = (s: Lifecycle): NotificationContent => ({
  category: 'subscription', type: 'subscription.expiring',
  title: `${s.planName} ends soon`,
  body: s.cancelAtPeriodEnd
    ? `Your ${s.planName} ends on ${day(s.end)}, as you chose.`
    : `Your ${s.planName} expires on ${day(s.end)}. Renew to keep your access.`,
  data: lifecycleData(s),
});

export const subscriptionGrace = (s: Lifecycle): NotificationContent => ({
  category: 'subscription', type: 'subscription.grace',
  title: `${s.planName} period ended`,
  body: `Your period ended on ${day(s.end)}. You keep access until ${day(s.graceEndsAt ?? s.end)}. Renew to avoid losing it.`,
  data: lifecycleData(s),
});

export const subscriptionExpired = (s: Lifecycle): NotificationContent => ({
  category: 'subscription', type: 'subscription.expired',
  title: `${s.planName} expired`,
  body: `Your access ended on ${day(s.graceEndsAt ?? s.end)}. You can renew at any time to get it back.`,
  data: lifecycleData(s),
});

// ------------------------------------------------------------------------------------------------- community
export const messageHidden = (e: EventMap['moderation.message_hidden'], room: { name: string; slug: string }): NotificationContent => ({
  category: 'community', type: 'community.message_hidden',
  title: 'A moderator hid your message',
  body: `Your message in ${room.name} was hidden while it is reviewed. Reason: ${e.reason}`,
  data: { roomSlug: room.slug, messageId: e.messageId },
});

export const messageRemoved = (e: EventMap['moderation.message_removed'], room: { name: string; slug: string }): NotificationContent => ({
  category: 'community', type: 'community.message_removed',
  title: 'A moderator removed your message',
  body: `Your message in ${room.name} was removed. Reason: ${e.reason}`,
  data: { roomSlug: room.slug, messageId: e.messageId },
});

export const messageRestored = (e: EventMap['moderation.message_unhidden'], room: { name: string; slug: string }): NotificationContent => ({
  category: 'community', type: 'community.message_restored',
  title: 'Your message was restored',
  body: `A moderator restored your message in ${room.name}.`,
  data: { roomSlug: room.slug, messageId: e.messageId },
});

export const accountRestricted = (e: EventMap['moderation.restricted']): NotificationContent => ({
  category: 'community', type: 'community.restricted',
  title: e.type === 'muted' ? 'You have been muted' : 'Your account has been suspended',
  body: e.type === 'muted'
    ? `You cannot post messages ${until(e.expiresAt)}. Reason: ${e.reason}`
    : `Your account is suspended ${until(e.expiresAt)}. Reason: ${e.reason}`,
  data: { restrictionType: e.type },
});

export const restrictionLifted = (e: EventMap['moderation.restriction_lifted']): NotificationContent => ({
  category: 'community', type: 'community.restriction_lifted',
  title: e.type === 'muted' ? 'Your mute was lifted' : 'Your suspension was lifted',
  body: e.type === 'muted' ? 'You can post messages again.' : 'Your account is active again.',
  data: { restrictionType: e.type },
});

/** Sent to the person who reported. Deliberately says nothing about who or what was decided beyond the outcome. */
export const reportReviewed = (outcome: 'resolved' | 'dismissed'): NotificationContent => ({
  category: 'community', type: 'community.report_reviewed',
  title: 'Your report was reviewed',
  body: outcome === 'resolved' ? 'A moderator reviewed your report and took action. Thank you for helping keep the community safe.' : 'A moderator reviewed your report and decided no action was needed.',
  data: { outcome },
});
