import type { FastifyBaseLogger } from 'fastify';
import { withTransaction, type Db } from '../db/index.js';
import { can } from '../auth/access.js';
import type { Role } from '../auth/roles.js';
import { audit } from '../billing/repo.js';
import type { BillingService } from '../billing/service.js';
import { addDays } from '../billing/subscriptions.js';
import {
  countByDedupeKey, getAnnouncementByClientId, insertAnnouncement, insertForUsers, insertNotification, setAnnouncementRecipients,
} from './repo.js';
import type { AnnouncementRow, NewNotification, NotificationContent, NotificationRow, PrefKey } from './model.js';
import { subscriptionExpired, subscriptionExpiring, subscriptionGrace } from './templates.js';

export interface NotificationOptions {
  graceDays: number;
  /** How many days before a period ends the "ends soon" reminder is sent. */
  expiryNoticeDays: number;
}

/** Subscriptions that ended longer ago than this are not announced (so switching this feature on does not message ancient history). */
const EXPIRED_NOTICE_WINDOW_DAYS = 7;
const pgCode = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

export interface Recipient { id: string; role: Role }

/**
 * Creates notifications. This class only knows how to store them and who should get them; it knows nothing about how payments,
 * signals or moderation work. Those modules announce domain events and handlers.ts turns them into calls here.
 */
export class NotificationService {
  constructor(
    private readonly db: Db,
    private readonly billing: BillingService,
    private readonly now: () => Date,
    private readonly opts: NotificationOptions,
    private readonly log: Pick<FastifyBaseLogger, 'info' | 'warn'>,
  ) {}

  /** One notification for one user. Returns null if this exact event was already notified to them. */
  create(n: NewNotification): Promise<NotificationRow | null> {
    return insertNotification(this.db, n, this.now());
  }

  /** The same notification for many users; safe to run again, it only fills in whoever is missing. */
  async notifyMany(userIds: string[], content: NotificationContent, dedupeKey: string): Promise<void> {
    if (userIds.length > 0) await insertForUsers(this.db, userIds, content, dedupeKey, this.now());
  }

  // ------------------------------------------------------------------------------------------------ audiences
  /** Members who want this kind of notification, minus anyone in `exclude` (typically the person who caused the event). */
  async usersWanting(pref: PrefKey, exclude: string[] = []): Promise<Recipient[]> {
    const { rows } = await this.db.query<{ id: string; role: Role; notification_prefs: Partial<Record<PrefKey, boolean>> | string }>(
      'select id, role, notification_prefs from users');
    const skip = new Set(exclude);
    return rows
      .filter((u) => !skip.has(u.id))
      .filter((u) => {
        const prefs = typeof u.notification_prefs === 'string' ? (JSON.parse(u.notification_prefs) as Partial<Record<PrefKey, boolean>>) : u.notification_prefs;
        return prefs?.[pref] === true;
      })
      .map((u) => ({ id: u.id, role: u.role }));
  }

  /** Of these members, the ones who can view premium signals right now (the one rule: can() over the real entitlement). */
  async premiumViewers(users: Recipient[]): Promise<string[]> {
    const ent = await this.billing.entitlementsForUsers(users.map((u) => u.id));
    return users.filter((u) => can({ role: u.role, entitlement: ent.get(u.id)! }, 'premium_signals')).map((u) => u.id);
  }

  // --------------------------------------------------------------------------------------------- announcements
  /**
   * Publishes an administrator announcement to members. Normal announcements respect each member's "announcements" preference
   * (off by default); an `important` one reaches everybody. Everything happens in one transaction, and a client-supplied
   * idempotency key makes a double submit return the original instead of announcing twice.
   */
  async announce(adminId: string, input: { title: string; body: string; important: boolean; clientId?: string | undefined }): Promise<{ announcement: AnnouncementRow; recipients: number; created: boolean }> {
    if (input.clientId) {
      const prior = await getAnnouncementByClientId(this.db, adminId, input.clientId);
      if (prior) return { announcement: prior, recipients: prior.recipient_count, created: false };
    }
    const now = this.now();
    try {
      return await withTransaction(this.db, async (tx) => {
        const a = await insertAnnouncement(tx, { title: input.title, body: input.body, important: input.important, createdBy: adminId, clientId: input.clientId ?? null, now });
        const ids = input.important
          ? (await tx.query<{ id: string }>('select id from users')).rows.map((r) => r.id)
          : (await this.usersWanting('announcements')).map((u) => u.id);
        const key = `announcement:${a.id}`;
        await insertForUsers(tx, ids, {
          category: 'announcement', type: 'announcement.published', title: input.title, body: input.body, data: { announcementId: a.id, important: input.important },
        }, key, now);
        const recipients = await countByDedupeKey(tx, key);
        await setAnnouncementRecipients(tx, a.id, recipients);
        await audit(tx, { actorId: adminId, action: 'announcement.published', entityType: 'announcement', entityId: a.id, data: { title: input.title, important: input.important, recipients } });
        return { announcement: { ...a, recipient_count: recipients }, recipients, created: true };
      });
    } catch (e) {
      // Two simultaneous submits with the same key: the loser returns the winner's announcement.
      const prior = pgCode(e) === '23505' && input.clientId ? await getAnnouncementByClientId(this.db, adminId, input.clientId) : undefined;
      if (prior) return { announcement: prior, recipients: prior.recipient_count, created: false };
      throw e;
    }
  }

  // ------------------------------------------------------------------------------------- subscription lifecycle
  /**
   * Sends "ends soon", "period ended (grace)" and "expired" notices.
   *
   * Access is derived from dates and never stored, so nothing happens in the system at the moment a subscription lapses; there is
   * no request to hang a notification on. This pass finds subscriptions near those boundaries instead. Each notice has a key built
   * from the subscription and its period end, so running it any number of times, from any number of instances, sends each notice once.
   */
  async sweepSubscriptions(): Promise<{ expiring: number; grace: number; expired: number }> {
    const now = this.now();
    const from = addDays(now, -(this.opts.graceDays + EXPIRED_NOTICE_WINDOW_DAYS));
    const to = addDays(now, this.opts.expiryNoticeDays);
    const counts = { expiring: 0, grace: 0, expired: 0 };
    for (const s of await this.billing.lifecycleSubscriptions(from, to)) {
      const life = { subscriptionId: s.subscriptionId, tier: s.tier, planName: s.planName, end: s.end, graceEndsAt: s.state.graceEndsAt, cancelAtPeriodEnd: s.cancelAtPeriodEnd };
      const periodKey = `${s.subscriptionId}:${s.end.toISOString()}`;
      let kind: keyof typeof counts | null = null;
      let content: NotificationContent | null = null;
      if (s.state.status === 'active') { kind = 'expiring'; content = subscriptionExpiring(life); }
      else if (s.state.status === 'grace') { kind = 'grace'; content = subscriptionGrace(life); }
      else if (s.state.status === 'expired' && (s.state.graceEndsAt ?? s.end).getTime() > addDays(now, -EXPIRED_NOTICE_WINDOW_DAYS).getTime()) { kind = 'expired'; content = subscriptionExpired(life); }
      if (!kind || !content) continue;
      if (await this.create({ userId: s.userId, ...content, dedupeKey: `subscription:${periodKey}:${kind}` })) counts[kind] += 1;
    }
    this.log.info(counts, 'subscription notice sweep finished');
    return counts;
  }
}
