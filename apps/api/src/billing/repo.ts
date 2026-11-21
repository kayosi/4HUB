import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { SubscriptionFields } from './subscriptions.js';

type Q = Pick<Db, 'query'>;

// ------------------------------------------------------------------ plans
export interface PlanRow {
  id: string;
  code: string;
  name: string;
  description: string;
  tier: string;
  price_minor: number;
  currency: string;
  duration_days: number | null;
  features: string[];
  is_active: boolean;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

export async function listPlans(db: Q, opts: { activeOnly: boolean }): Promise<PlanRow[]> {
  const { rows } = await db.query<PlanRow>(
    `select * from plans ${opts.activeOnly ? 'where is_active = true' : ''} order by sort_order asc, created_at asc`,
  );
  return rows;
}
export async function getPlanByCode(db: Q, code: string): Promise<PlanRow | undefined> {
  return (await db.query<PlanRow>('select * from plans where code = $1', [code])).rows[0];
}
export async function getPlanById(db: Q, id: string): Promise<PlanRow | undefined> {
  return (await db.query<PlanRow>('select * from plans where id = $1', [id])).rows[0];
}
export interface PlanInsert {
  code: string; name: string; description: string; tier: string; priceMinor: number; currency: string;
  durationDays: number | null; features: string[]; isActive: boolean; sortOrder: number;
}
export async function insertPlan(db: Q, p: PlanInsert): Promise<PlanRow> {
  const { rows } = await db.query<PlanRow>(
    `insert into plans (id, code, name, description, tier, price_minor, currency, duration_days, features, is_active, sort_order)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [randomUUID(), p.code, p.name, p.description, p.tier, p.priceMinor, p.currency, p.durationDays, JSON.stringify(p.features), p.isActive, p.sortOrder],
  );
  return rows[0]!;
}
const PLAN_COLUMN: Record<string, string> = {
  name: 'name', description: 'description', priceMinor: 'price_minor', currency: 'currency',
  durationDays: 'duration_days', features: 'features', isActive: 'is_active', sortOrder: 'sort_order',
};
export async function updatePlan(db: Q, id: string, patch: Record<string, unknown>): Promise<PlanRow | undefined> {
  const sets: string[] = [];
  const vals: unknown[] = [id];
  for (const [k, v] of Object.entries(patch)) {
    const col = PLAN_COLUMN[k];
    if (!col) throw new Error(`Unknown plan field: ${k}`);
    vals.push(k === 'features' ? JSON.stringify(v) : v);
    sets.push(`${col} = $${vals.length}`);
  }
  const { rows } = await db.query<PlanRow>(
    `update plans set ${sets.join(', ')}${sets.length ? ',' : ''} updated_at = now() where id = $1 returning *`, vals);
  return rows[0];
}

// ------------------------------------------------------------------ payments
export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'refunded' | 'partially_refunded';
export interface PlanSnapshot { code: string; name: string; tier: string; durationDays: number }
export interface PaymentRow {
  id: string;
  user_id: string;
  plan_id: string;
  plan_snapshot: PlanSnapshot;
  amount_minor: number;
  currency: string;
  provider: string;
  provider_reference: string | null;
  provider_transaction_id: string | null;
  status: PaymentStatus;
  failure_reason: string | null;
  payer_hint: string | null;
  idempotency_key: string | null;
  refunded_minor: number;
  created_at: Date;
  updated_at: Date;
  paid_at: Date | null;
  refunded_at: Date | null;
}

export async function insertPayment(
  db: Q,
  p: { userId: string; planId: string; snapshot: PlanSnapshot; amountMinor: number; currency: string; provider: string; payerHint: string | null; idempotencyKey: string | null; id?: string },
): Promise<PaymentRow> {
  const { rows } = await db.query<PaymentRow>(
    `insert into payments (id, user_id, plan_id, plan_snapshot, amount_minor, currency, provider, payer_hint, idempotency_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [p.id ?? randomUUID(), p.userId, p.planId, JSON.stringify(p.snapshot), p.amountMinor, p.currency, p.provider, p.payerHint, p.idempotencyKey],
  );
  return rows[0]!;
}
export const getPayment = async (db: Q, id: string) =>
  (await db.query<PaymentRow>('select * from payments where id = $1', [id])).rows[0];
export const getPaymentByIdempotencyKey = async (db: Q, userId: string, key: string) =>
  (await db.query<PaymentRow>('select * from payments where user_id = $1 and idempotency_key = $2', [userId, key])).rows[0];
export const getPaymentByReference = async (db: Q, provider: string, ref: string) =>
  (await db.query<PaymentRow>('select * from payments where provider = $1 and provider_reference = $2', [provider, ref])).rows[0];

export async function setPaymentReference(db: Q, id: string, ref: string): Promise<void> {
  await db.query('update payments set provider_reference = $2, updated_at = now() where id = $1', [id, ref]);
}

/** Guarded state change: only applies when the payment is currently in one of `from`. Returns the row or undefined. */
export async function transitionPayment(
  db: Q, id: string,
  t: { from: PaymentStatus[]; to: PaymentStatus; failureReason?: string | null; paidAt?: Date; providerTransactionId?: string | null },
): Promise<PaymentRow | undefined> {
  const ph = t.from.map((_, i) => `$${i + 6}`).join(', ');
  const { rows } = await db.query<PaymentRow>(
    `update payments set status = $2, failure_reason = $3, paid_at = coalesce($4, paid_at),
            provider_transaction_id = coalesce($5, provider_transaction_id), updated_at = now()
      where id = $1 and status in (${ph}) returning *`,
    [id, t.to, t.failureReason ?? null, t.paidAt ?? null, t.providerTransactionId ?? null, ...t.from],
  );
  return rows[0];
}

export async function applyRefund(db: Q, id: string, refundedMinor: number, status: 'refunded' | 'partially_refunded', at: Date) {
  const { rows } = await db.query<PaymentRow>(
    `update payments set refunded_minor = $2, status = $3, refunded_at = $4, updated_at = now()
      where id = $1 and status in ('succeeded', 'partially_refunded') returning *`,
    [id, refundedMinor, status, at],
  );
  return rows[0];
}

export async function listPaymentsForUser(db: Q, userId: string, limit: number, offset: number): Promise<PaymentRow[]> {
  return (await db.query<PaymentRow>(
    'select * from payments where user_id = $1 order by created_at desc, id desc limit $2 offset $3', [userId, limit, offset])).rows;
}

export interface AdminPaymentRow extends PaymentRow { user_email: string; user_name: string }
export async function listPaymentsAdmin(db: Q, status: string | undefined, limit: number, offset: number): Promise<AdminPaymentRow[]> {
  const vals: unknown[] = [];
  let where = '';
  if (status) { vals.push(status); where = 'where p.status = $1'; }
  vals.push(limit, offset);
  return (await db.query<AdminPaymentRow>(
    `select p.*, u.email as user_email, u.display_name as user_name
       from payments p join users u on u.id = p.user_id ${where}
      order by p.created_at desc, p.id desc limit $${vals.length - 1} offset $${vals.length}`, vals)).rows;
}

// ------------------------------------------------------------------ webhook inbox
export interface EventRow { id: string; provider: string; event_id: string; outcome: string }
/**
 * Records a webhook event. Returns the new row id, or undefined if (provider, event_id) was already recorded.
 * Deliberately does not rely on RETURNING-after-conflict behaviour (it differs between engines): we choose the row
 * id ourselves and then check whether THAT row exists, which is only true if our insert won.
 */
export async function insertEvent(
  db: Q, e: { provider: string; eventId: string; type: string; reference: string | null; paymentId: string | null; outcome: string },
): Promise<string | undefined> {
  const id = randomUUID();
  await db.query(
    `insert into payment_events (id, provider, event_id, event_type, provider_reference, payment_id, outcome)
     values ($1,$2,$3,$4,$5,$6,$7) on conflict (provider, event_id) do nothing`,
    [id, e.provider, e.eventId, e.type, e.reference, e.paymentId, e.outcome],
  );
  const { rows } = await db.query<{ id: string }>('select id from payment_events where id = $1', [id]);
  return rows[0]?.id;
}
export const getEvent = async (db: Q, provider: string, eventId: string) =>
  (await db.query<EventRow>('select id, provider, event_id, outcome from payment_events where provider = $1 and event_id = $2', [provider, eventId])).rows[0];
export async function setEventOutcome(db: Q, id: string, outcome: string, paymentId: string | null): Promise<void> {
  await db.query('update payment_events set outcome = $2, payment_id = $3 where id = $1', [id, outcome, paymentId]);
}

// ------------------------------------------------------------------ subscriptions
export interface SubscriptionRow extends SubscriptionFields {
  id: string;
  user_id: string;
  plan_id: string;
  current_period_start: Date;
  cancelled_at: Date | null;
  source: 'payment' | 'admin_grant';
  created_at: Date;
  updated_at: Date;
}
export const getSubscription = async (db: Q, userId: string, tier: string) =>
  (await db.query<SubscriptionRow>('select * from subscriptions where user_id = $1 and tier = $2', [userId, tier])).rows[0];
export const listSubscriptionsForUser = async (db: Q, userId: string) =>
  (await db.query<SubscriptionRow>('select * from subscriptions where user_id = $1', [userId])).rows;

export async function insertSubscription(
  db: Q, s: { userId: string; planId: string; tier: string; start: Date; end: Date; source: 'payment' | 'admin_grant' },
): Promise<SubscriptionRow> {
  return (await db.query<SubscriptionRow>(
    `insert into subscriptions (id, user_id, plan_id, tier, current_period_start, current_period_end, source)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [randomUUID(), s.userId, s.planId, s.tier, s.start, s.end, s.source])).rows[0]!;
}
const SUB_COLUMN: Record<string, string> = {
  planId: 'plan_id', periodStart: 'current_period_start', periodEnd: 'current_period_end',
  cancelAtPeriodEnd: 'cancel_at_period_end', cancelledAt: 'cancelled_at', revokedAt: 'revoked_at',
  source: 'source', lastFailedPaymentAt: 'last_failed_payment_at',
};
export async function updateSubscription(db: Q, id: string, patch: Record<string, unknown>): Promise<SubscriptionRow | undefined> {
  const sets: string[] = [];
  const vals: unknown[] = [id];
  for (const [k, v] of Object.entries(patch)) {
    const col = SUB_COLUMN[k];
    if (!col) throw new Error(`Unknown subscription field: ${k}`);
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  }
  return (await db.query<SubscriptionRow>(
    `update subscriptions set ${sets.join(', ')}, updated_at = now() where id = $1 returning *`, vals)).rows[0];
}

export interface PeriodRow { id: string; subscription_id: string; payment_id: string | null; plan_id: string; kind: string; period_start: Date; period_end: Date }
export async function insertPeriod(
  db: Q, p: { subscriptionId: string; paymentId: string | null; planId: string; kind: string; start: Date; end: Date },
): Promise<void> {
  await db.query(
    `insert into subscription_periods (id, subscription_id, payment_id, plan_id, kind, period_start, period_end)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(), p.subscriptionId, p.paymentId, p.planId, p.kind, p.start, p.end]);
}
export const getPeriodByPayment = async (db: Q, paymentId: string) =>
  (await db.query<PeriodRow>('select * from subscription_periods where payment_id = $1', [paymentId])).rows[0];
export const listPeriods = async (db: Q, subscriptionId: string) =>
  (await db.query<PeriodRow>('select * from subscription_periods where subscription_id = $1 order by period_start asc', [subscriptionId])).rows;

// ------------------------------------------------------------------ invoices
export interface InvoiceRow {
  id: string; seq: number; user_id: string; payment_id: string; description: string; amount_minor: number;
  currency: string; status: 'paid' | 'refunded' | 'partially_refunded'; period_start: Date | null; period_end: Date | null; issued_at: Date;
}
export async function insertInvoice(
  db: Q, i: { userId: string; paymentId: string; description: string; amountMinor: number; currency: string; start: Date; end: Date; issuedAt: Date },
): Promise<void> {
  await db.query(
    `insert into invoices (id, user_id, payment_id, description, amount_minor, currency, period_start, period_end, issued_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [randomUUID(), i.userId, i.paymentId, i.description, i.amountMinor, i.currency, i.start, i.end, i.issuedAt]);
}
export const listInvoicesForUser = async (db: Q, userId: string, limit: number, offset: number) =>
  (await db.query<InvoiceRow>('select * from invoices where user_id = $1 order by issued_at desc, seq desc limit $2 offset $3', [userId, limit, offset])).rows;
export const getInvoiceForUser = async (db: Q, id: string, userId: string) =>
  (await db.query<InvoiceRow>('select * from invoices where id = $1 and user_id = $2', [id, userId])).rows[0];
export async function setInvoiceStatus(db: Q, paymentId: string, status: InvoiceRow['status']): Promise<void> {
  await db.query('update invoices set status = $2 where payment_id = $1', [paymentId, status]);
}

// ------------------------------------------------------------------ audit
export async function audit(
  db: Q, a: { actorId?: string | null; action: string; entityType: string; entityId?: string | null; data?: object },
): Promise<void> {
  await db.query('insert into audit_log (id, actor_id, action, entity_type, entity_id, data) values ($1,$2,$3,$4,$5,$6)',
    [randomUUID(), a.actorId ?? null, a.action, a.entityType, a.entityId ?? null, JSON.stringify(a.data ?? {})]);
}

export const listSubscriptionsForUsers = async (db: Q, userIds: string[]) => {
  if (userIds.length === 0) return [];
  return (await db.query<SubscriptionRow>(
    `select * from subscriptions where user_id in (${userIds.map((_, i) => `$${i + 1}`).join(', ')})`, userIds)).rows;
};
export const getPaymentForInvoice = async (db: Q, paymentId: string) =>
  (await db.query<PaymentRow>('select * from payments where id = $1', [paymentId])).rows[0];

/** Subscriptions that could still grant access at or after `since` (a superset: callers apply the real rule). */
export const listPossiblyEntitledSubscriptions = async (db: Q, since: Date) =>
  (await db.query<SubscriptionRow>('select * from subscriptions where revoked_at is null and current_period_end > $1', [since])).rows;

/** Subscriptions whose paid period ends within (from, to], with their plan name. Used for expiry reminders. */
export const listSubscriptionsEndingBetween = async (db: Q, from: Date, to: Date) =>
  (await db.query<SubscriptionRow & { plan_name: string }>(
    `select s.*, p.name as plan_name from subscriptions s join plans p on p.id = s.plan_id
      where s.revoked_at is null and s.current_period_end > $1 and s.current_period_end <= $2`, [from, to])).rows;
