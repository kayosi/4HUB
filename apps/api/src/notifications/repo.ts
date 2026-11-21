import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { AnnouncementRow, Category, NewNotification, NotificationContent, NotificationRow } from './model.js';
import { CATEGORIES } from './model.js';

type Q = Pick<Db, 'query'>;
const pgCode = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;
// pg returns BIGINT as a string on a real server; normalise so callers always get a number.
const map = (r: NotificationRow): NotificationRow => ({ ...r, seq: Number(r.seq) });
const COLS = 'id, seq, user_id, category, type, title, body, data, dedupe_key, created_at, read_at';

/**
 * Creates one notification. Returns null when the same event was already notified to this user.
 * (A pre-check keeps the common case cheap; the unique (user_id, dedupe_key) constraint is what actually guarantees it,
 * so two simultaneous attempts still produce exactly one row.)
 */
export async function insertNotification(db: Q, n: NewNotification, now: Date): Promise<NotificationRow | null> {
  if (n.dedupeKey) {
    const dupe = await db.query('select id from notifications where user_id = $1 and dedupe_key = $2', [n.userId, n.dedupeKey]);
    if (dupe.rows.length > 0) return null;
  }
  const id = randomUUID();
  try {
    await db.query(
      'insert into notifications (id, user_id, category, type, title, body, data, dedupe_key, created_at) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)',
      [id, n.userId, n.category, n.type, n.title, n.body ?? '', JSON.stringify(n.data ?? {}), n.dedupeKey ?? null, now],
    );
  } catch (e) {
    if (pgCode(e) === '23505') return null; // lost a race to an identical event
    throw e;
  }
  return map((await db.query<NotificationRow>(`select ${COLS} from notifications where id = $1`, [id])).rows[0]!);
}

const CHUNK = 500;

/**
 * Fan-out: the same notification for many users in a few statements. `dedupeKey` is required so re-running a fan-out
 * (for example after a crash half-way) fills in only the missing recipients and never duplicates anyone.
 */
export async function insertForUsers(db: Q, userIds: string[], content: NotificationContent, dedupeKey: string, now: Date): Promise<void> {
  const data = JSON.stringify(content.data ?? {});
  for (let i = 0; i < userIds.length; i += CHUNK) {
    const batch = userIds.slice(i, i + CHUNK);
    const params: unknown[] = [content.category, content.type, content.title, content.body ?? '', data, dedupeKey, now];
    const rows = batch.map((userId, j) => {
      params.push(randomUUID(), userId);
      return `($${8 + j * 2}, $${9 + j * 2}, $1, $2, $3, $4, $5::jsonb, $6, $7)`;
    });
    await db.query(
      `insert into notifications (id, user_id, category, type, title, body, data, dedupe_key, created_at) values ${rows.join(', ')}
       on conflict (user_id, dedupe_key) do nothing`,
      params,
    );
  }
}

export async function countByDedupeKey(db: Q, key: string): Promise<number> {
  return Number((await db.query<{ n: string | number }>('select count(*) as n from notifications where dedupe_key = $1', [key])).rows[0]!.n);
}

export interface ListFilter { before?: number; limit: number; category?: Category; unreadOnly?: boolean }

/** A user's notifications, newest first. `hasMore` says whether older ones exist. Always scoped to `userId`. */
export async function listForUser(db: Q, userId: string, f: ListFilter) {
  const params: unknown[] = [userId];
  let where = 'user_id = $1';
  if (f.before !== undefined) { params.push(f.before); where += ` and seq < $${params.length}`; }
  if (f.category) { params.push(f.category); where += ` and category = $${params.length}`; }
  if (f.unreadOnly) where += ' and read_at is null';
  params.push(f.limit + 1);
  const rows = (await db.query<NotificationRow>(`select ${COLS} from notifications where ${where} order by seq desc limit $${params.length}`, params)).rows.map(map);
  return { notifications: rows.slice(0, f.limit), hasMore: rows.length > f.limit };
}

export async function unreadCounts(db: Q, userId: string): Promise<{ unread: number; byCategory: Record<Category, number> }> {
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  const { rows } = await db.query<{ category: Category; n: string | number }>(
    'select category, count(*) as n from notifications where user_id = $1 and read_at is null group by category', [userId]);
  let unread = 0;
  for (const r of rows) { byCategory[r.category] = Number(r.n); unread += Number(r.n); }
  return { unread, byCategory };
}

/** Marks one of the user's own notifications read (first read time is kept). Returns undefined if it is not theirs / does not exist. */
export async function markRead(db: Q, userId: string, id: string, now: Date): Promise<NotificationRow | undefined> {
  await db.query('update notifications set read_at = $3 where id = $1 and user_id = $2 and read_at is null', [id, userId, now]);
  const r = (await db.query<NotificationRow>(`select ${COLS} from notifications where id = $1 and user_id = $2`, [id, userId])).rows[0];
  return r && map(r);
}

export async function markAllRead(db: Q, userId: string, now: Date, category?: Category): Promise<number> {
  const params: unknown[] = [userId, now];
  let where = 'user_id = $1 and read_at is null';
  if (category) { params.push(category); where += ' and category = $3'; }
  return (await db.query(`update notifications set read_at = $2 where ${where} returning id`, params)).rows.length;
}

// ------------------------------------------------------------------------------------------------ announcements
export async function getAnnouncementByClientId(db: Q, createdBy: string, clientId: string) {
  return (await db.query<AnnouncementRow>('select * from announcements where created_by = $1 and client_id = $2', [createdBy, clientId])).rows[0];
}
export async function insertAnnouncement(
  db: Q, a: { title: string; body: string; important: boolean; createdBy: string; clientId: string | null; now: Date },
): Promise<AnnouncementRow> {
  const id = randomUUID();
  await db.query('insert into announcements (id, title, body, important, created_by, client_id, created_at) values ($1,$2,$3,$4,$5,$6,$7)',
    [id, a.title, a.body, a.important, a.createdBy, a.clientId, a.now]);
  return (await db.query<AnnouncementRow>('select * from announcements where id = $1', [id])).rows[0]!;
}
export const setAnnouncementRecipients = (db: Q, id: string, n: number) =>
  db.query('update announcements set recipient_count = $2 where id = $1', [id, n]);
export const listAnnouncements = async (db: Q, limit: number) =>
  (await db.query<AnnouncementRow>('select * from announcements order by created_at desc, id asc limit $1', [limit])).rows;
