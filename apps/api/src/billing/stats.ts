import type { Db } from '../db/index.js';
import { addDays } from './subscriptions.js';
import { listPaymentsAdmin } from './repo.js';

const n = (v: unknown) => Number(v ?? 0);

/**
 * Admin dashboard numbers. Subscriber counts use the same date rules as subscriptionState() (see
 * subscriptions.ts); a test asserts the two stay in agreement.
 */
export async function billingSummary(db: Db, now: Date, graceDays: number, range: { from?: Date; to?: Date }) {
  const cutoff = addDays(now, -graceDays);

  const pv: unknown[] = [];
  const clauses = ['paid_at is not null'];
  if (range.from) { pv.push(range.from); clauses.push(`paid_at >= $${pv.length}`); }
  if (range.to) { pv.push(range.to); clauses.push(`paid_at < $${pv.length}`); }
  const revenueRows = (await db.query<{ currency: string; gross: string; refunded: string; n: string }>(
    `select currency, sum(amount_minor) as gross, sum(refunded_minor) as refunded, count(*) as n
       from payments where ${clauses.join(' and ')} group by currency order by currency`, pv)).rows;
  const revenue = revenueRows.map((r) => ({
    currency: r.currency, grossMinor: n(r.gross), refundedMinor: n(r.refunded), netMinor: n(r.gross) - n(r.refunded), payments: n(r.n),
  }));

  const cv: unknown[] = [];
  const created: string[] = [];
  if (range.from) { cv.push(range.from); created.push(`created_at >= $${cv.length}`); }
  if (range.to) { cv.push(range.to); created.push(`created_at < $${cv.length}`); }
  const where = created.length ? `where ${created.join(' and ')}` : '';
  const byStatus = (await db.query<{ status: string; c: string }>(`select status, count(*) as c from payments ${where} group by status`, cv)).rows;
  const status = Object.fromEntries(byStatus.map((r) => [r.status, n(r.c)])) as Record<string, number>;
  const refundRow = (await db.query<{ c: string }>(`select count(*) as c from payments where refunded_minor > 0`)).rows[0];

  const one = async (sql: string, params: unknown[]) => n((await db.query<{ c: string }>(sql, params)).rows[0]?.c);
  const total = await one('select count(*) as c from subscriptions', []);
  const active = await one('select count(*) as c from subscriptions where revoked_at is null and current_period_end > $1', [now]);
  const grace = await one(
    'select count(*) as c from subscriptions where revoked_at is null and cancel_at_period_end = false and current_period_end <= $1 and current_period_end > $2', [now, cutoff]);
  const cancelled = await one('select count(*) as c from subscriptions where revoked_at is not null', []);
  const expired = total - active - grace - cancelled;

  const breakdown = (await db.query<{ code: string; name: string; tier: string; c: string }>(
    `select p.code, p.name, p.tier, count(*) as c from subscriptions s join plans p on p.id = s.plan_id
      where s.revoked_at is null and (s.current_period_end > $1 or (s.cancel_at_period_end = false and s.current_period_end > $2))
      group by p.code, p.name, p.tier order by p.code`, [now, cutoff])).rows
    .map((r) => ({ planCode: r.code, planName: r.name, tier: r.tier, subscribers: n(r.c) }));

  return {
    revenue,
    subscribers: { active, grace, expired, cancelled, withAccess: active + grace },
    payments: { succeeded: n(status.succeeded) + n(status.partially_refunded) + n(status.refunded), failed: n(status.failed), cancelled: n(status.cancelled), pending: n(status.pending) },
    refunds: { count: n(refundRow?.c), amountByCurrency: revenue.map((r) => ({ currency: r.currency, refundedMinor: r.refundedMinor })) },
    breakdown,
    recent: await listPaymentsAdmin(db, undefined, 10, 0),
  };
}
