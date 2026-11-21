import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import {
  NO_RESTRICTIONS, type ActiveRestrictions, type ReportReason, type ReportResolution, type ReportRow, type ReportStatus, type ReportView,
  type RestrictionRow, type RestrictionType,
} from './model.js';

type Q = Pick<Db, 'query'>;

// ------------------------------------------------------------------------------------------------------------- reports
export async function insertReport(
  db: Q, i: { messageId: string; roomId: string; reporterId: string; reportedUserId: string; reason: ReportReason; details: string; reportedBody: string; now: Date },
): Promise<ReportRow> {
  return (await db.query<ReportRow>(
    `insert into message_reports (id, message_id, room_id, reporter_id, reported_user_id, reason, details, reported_body, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [randomUUID(), i.messageId, i.roomId, i.reporterId, i.reportedUserId, i.reason, i.details, i.reportedBody, i.now],
  )).rows[0]!;
}

export const getReportByReporter = async (db: Q, messageId: string, reporterId: string) =>
  (await db.query<ReportRow>('select * from message_reports where message_id = $1 and reporter_id = $2', [messageId, reporterId])).rows[0];

/** Timestamps of the reporter's most recent reports since `since`, newest first (used for rate limiting). */
export async function recentReportTimes(db: Q, reporterId: string, since: Date, limit: number): Promise<Date[]> {
  return (await db.query<{ created_at: Date }>(
    'select created_at from message_reports where reporter_id = $1 and created_at > $2 order by created_at desc limit $3', [reporterId, since, limit],
  )).rows.map((r) => r.created_at);
}

const VIEW = `select r.id, r.message_id, r.room_id, r.reporter_id, r.reported_user_id, r.reason, r.details, r.reported_body, r.created_at,
       r.status, r.resolved_by, r.resolved_at, r.resolution, r.resolution_note,
       rep.display_name as reporter_name, au.display_name as reported_name, au.role as reported_role,
       rm.name as room_name, rm.slug as room_slug,
       m.body as current_body, m.hidden_at, m.deleted_at, m.moderation_reason,
       rs.display_name as resolver_name
  from message_reports r
  join users rep on rep.id = r.reporter_id
  join users au on au.id = r.reported_user_id
  join community_rooms rm on rm.id = r.room_id
  join room_messages m on m.id = r.message_id
  left join users rs on rs.id = r.resolved_by`;

export const getReportView = async (db: Q, id: string) =>
  (await db.query<ReportView>(`${VIEW} where r.id = $1`, [id])).rows[0];

/** Open reports are worked oldest-first; closed ones are listed by most recently closed. */
export async function listReportViews(db: Q, f: { status: ReportStatus | 'all'; limit: number; offset: number }): Promise<ReportView[]> {
  const params: unknown[] = [];
  let where = '';
  if (f.status !== 'all') { params.push(f.status); where = `where r.status = $1`; }
  const order = f.status === 'open' ? 'r.created_at asc' : f.status === 'all' ? 'r.created_at desc' : 'r.resolved_at desc';
  params.push(f.limit, f.offset);
  return (await db.query<ReportView>(`${VIEW} ${where} order by ${order}, r.id asc limit $${params.length - 1} offset $${params.length}`, params)).rows;
}

export async function countReportsByStatus(db: Q): Promise<Record<ReportStatus, number>> {
  const out: Record<ReportStatus, number> = { open: 0, resolved: 0, dismissed: 0 };
  for (const r of (await db.query<{ status: ReportStatus; n: string | number }>('select status, count(*) as n from message_reports group by status')).rows) out[r.status] = Number(r.n);
  return out;
}

export async function countReportsForMessages(db: Q, messageIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (messageIds.length === 0) return out;
  const { rows } = await db.query<{ message_id: string; n: string | number }>(
    `select message_id, count(*) as n from message_reports where message_id in (${messageIds.map((_, i) => `$${i + 1}`).join(', ')}) group by message_id`, messageIds);
  for (const r of rows) out.set(r.message_id, Number(r.n));
  return out;
}

/** Closes an open report. Returns undefined if it was not open (already closed by someone else). */
export async function closeReport(
  db: Q, id: string, c: { status: 'resolved' | 'dismissed'; resolution: ReportResolution | null; note: string | null; actorId: string; now: Date },
): Promise<ReportRow | undefined> {
  return (await db.query<ReportRow>(
    `update message_reports set status = $2, resolution = $3, resolution_note = $4, resolved_by = $5, resolved_at = $6
      where id = $1 and status = 'open' returning *`,
    [id, c.status, c.resolution, c.note, c.actorId, c.now],
  )).rows[0];
}

/** Acting on a message settles every open report about it. Returns the ids that were closed. */
export async function resolveOpenReportsForMessage(
  db: Q, messageId: string, c: { resolution: 'hidden' | 'removed'; note: string; actorId: string; now: Date },
): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `update message_reports set status = 'resolved', resolution = $2, resolution_note = $3, resolved_by = $4, resolved_at = $5
      where message_id = $1 and status = 'open' returning id`,
    [messageId, c.resolution, c.note, c.actorId, c.now],
  );
  return rows.map((r) => r.id);
}

// ------------------------------------------------------------------------------------------------------- message actions
/** Hides a visible message. Returns false if it was already hidden or removed. */
export async function hideMessage(db: Q, id: string, actorId: string, reason: string, now: Date): Promise<boolean> {
  return (await db.query(
    `update room_messages set hidden_at = $2, hidden_by = $3, moderation_reason = $4 where id = $1 and deleted_at is null and hidden_at is null returning id`,
    [id, now, actorId, reason],
  )).rows.length === 1;
}

export async function unhideMessage(db: Q, id: string): Promise<boolean> {
  return (await db.query(
    `update room_messages set hidden_at = null, hidden_by = null, moderation_reason = null where id = $1 and deleted_at is null and hidden_at is not null returning id`, [id],
  )).rows.length === 1;
}

/** Permanently removes a message: the content is wiped, the row stays as a tombstone. Returns false if already removed. */
export async function removeMessage(db: Q, id: string, actorId: string, reason: string, now: Date): Promise<boolean> {
  return (await db.query(
    `update room_messages set body = '', deleted_at = $2, deleted_by = $3, moderation_reason = $4, hidden_at = null, hidden_by = null
      where id = $1 and deleted_at is null returning id`,
    [id, now, actorId, reason],
  )).rows.length === 1;
}

// ------------------------------------------------------------------------------------------------------- restrictions
export async function insertRestriction(
  db: Q, i: { userId: string; type: RestrictionType; reason: string; createdBy: string; expiresAt: Date | null; now: Date },
): Promise<RestrictionRow> {
  return (await db.query<RestrictionRow>(
    `insert into user_restrictions (id, user_id, type, reason, created_by, created_at, expires_at) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [randomUUID(), i.userId, i.type, i.reason, i.createdBy, i.now, i.expiresAt],
  )).rows[0]!;
}

export const getRestriction = async (db: Q, id: string) =>
  (await db.query<RestrictionRow>('select * from user_restrictions where id = $1', [id])).rows[0];

export const listRestrictionsForUser = async (db: Q, userId: string) =>
  (await db.query<RestrictionRow>('select * from user_restrictions where user_id = $1 order by created_at desc, id asc limit 200', [userId])).rows;

/** A restriction is in force until it is lifted or its end time passes. */
export const isActive = (r: RestrictionRow, now: Date): boolean => r.lifted_at === null && (r.expires_at === null || r.expires_at.getTime() > now.getTime());

function fold(rows: RestrictionRow[], now: Date): ActiveRestrictions {
  const out: ActiveRestrictions = { ...NO_RESTRICTIONS };
  for (const r of rows) if (isActive(r, now) && !out[r.type]) out[r.type] = r; // rows are newest first
  return out;
}

export async function getActiveRestrictions(db: Q, userId: string, now: Date): Promise<ActiveRestrictions> {
  const { rows } = await db.query<RestrictionRow>(
    'select * from user_restrictions where user_id = $1 and lifted_at is null and (expires_at is null or expires_at > $2) order by created_at desc', [userId, now]);
  return fold(rows, now);
}

export async function listActiveRestrictionsForUsers(db: Q, userIds: string[], now: Date): Promise<Map<string, ActiveRestrictions>> {
  const out = new Map<string, ActiveRestrictions>();
  if (userIds.length === 0) return out;
  const { rows } = await db.query<RestrictionRow>(
    `select * from user_restrictions where user_id in (${userIds.map((_, i) => `$${i + 1}`).join(', ')}) and lifted_at is null and (expires_at is null or expires_at > $${userIds.length + 1}) order by created_at desc`,
    [...userIds, now]);
  for (const id of userIds) out.set(id, fold(rows.filter((r) => r.user_id === id), now));
  return out;
}

/** Lifts a restriction that is still in force. Returns undefined if it was already lifted or has expired. */
export async function liftRestriction(db: Q, id: string, actorId: string, note: string | null, now: Date): Promise<RestrictionRow | undefined> {
  return (await db.query<RestrictionRow>(
    `update user_restrictions set lifted_at = $2, lifted_by = $3, lift_note = $4
      where id = $1 and lifted_at is null and (expires_at is null or expires_at > $2) returning *`,
    [id, now, actorId, note],
  )).rows[0];
}

/** Who filed each of these reports (used to tell reporters their report was reviewed). */
export async function reporterIdsFor(db: Q, reportIds: string[]): Promise<{ id: string; reporter_id: string }[]> {
  if (reportIds.length === 0) return [];
  return (await db.query<{ id: string; reporter_id: string }>(
    `select id, reporter_id from message_reports where id in (${reportIds.map((_, i) => `$${i + 1}`).join(', ')})`, reportIds)).rows;
}
