import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { MessageRow } from './model.js';

type Q = Pick<Db, 'query'>;

const SELECT = `select m.id, m.seq, m.room_id, m.author_id, m.client_id, m.body, m.created_at, m.edited_at, m.deleted_at, m.deleted_by, m.hidden_at, m.moderation_reason,
                       u.display_name as author_name, u.role as author_role
                  from room_messages m join users u on u.id = m.author_id`;

// pg returns BIGINT as a string on a real server; normalise so callers always get a number.
const map = (r: MessageRow): MessageRow => ({ ...r, seq: Number(r.seq) });

export async function getMessage(db: Q, id: string): Promise<MessageRow | undefined> {
  const r = (await db.query<MessageRow>(`${SELECT} where m.id = $1`, [id])).rows[0];
  return r && map(r);
}

export async function getMessageByClientId(db: Q, authorId: string, clientId: string): Promise<MessageRow | undefined> {
  const r = (await db.query<MessageRow>(`${SELECT} where m.author_id = $1 and m.client_id = $2`, [authorId, clientId])).rows[0];
  return r && map(r);
}

/** Newest-first page older than `before`, returned in chronological order. `hasMore` says whether older messages exist. */
export async function listMessages(db: Q, roomId: string, f: { before?: number; limit: number }) {
  const params: unknown[] = [roomId];
  let where = 'm.room_id = $1';
  if (f.before !== undefined) {
    params.push(f.before);
    where += ` and m.seq < $${params.length}`;
  }
  params.push(f.limit + 1);
  const rows = (await db.query<MessageRow>(`${SELECT} where ${where} order by m.seq desc limit $${params.length}`, params)).rows.map(map);
  const hasMore = rows.length > f.limit;
  return { messages: rows.slice(0, f.limit).reverse(), hasMore };
}

export async function insertMessage(
  db: Q, i: { roomId: string; authorId: string; clientId: string | null; body: string; now: Date },
): Promise<MessageRow> {
  const id = randomUUID();
  await db.query(
    'insert into room_messages (id, room_id, author_id, client_id, body, created_at) values ($1,$2,$3,$4,$5,$6)',
    [id, i.roomId, i.authorId, i.clientId, i.body, i.now],
  );
  return (await getMessage(db, id))!;
}

/** Only live (not deleted) messages can be edited. Returns undefined if the message was deleted in the meantime. */
export async function updateMessageBody(db: Q, id: string, body: string, now: Date): Promise<MessageRow | undefined> {
  const { rows } = await db.query('update room_messages set body = $2, edited_at = $3 where id = $1 and deleted_at is null returning id', [id, body, now]);
  return rows[0] ? getMessage(db, id) : undefined;
}

/** Wipes the content and marks the row deleted. Returns undefined if it was already deleted. */
export async function tombstoneMessage(db: Q, id: string, actorId: string, now: Date): Promise<MessageRow | undefined> {
  const { rows } = await db.query(
    "update room_messages set body = '', deleted_at = $2, deleted_by = $3 where id = $1 and deleted_at is null returning id", [id, now, actorId],
  );
  return rows[0] ? getMessage(db, id) : undefined;
}
