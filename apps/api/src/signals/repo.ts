import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import type {
  ImageRow,
  ReactionType,
  SignalRow,
  UpdateKind,
  UpdateRow,
} from './model.js';

type Q = Pick<Db, 'query'>;

const NUMERIC = ['entry', 'stop_loss', 'take_profit_1', 'take_profit_2', 'take_profit_3', 'pips'] as const;

// pg returns NUMERIC as strings on a real server; normalise so callers always get numbers.
function mapSignal(r: SignalRow): SignalRow {
  const out = { ...r } as Record<string, unknown>;
  for (const k of NUMERIC) if (out[k] !== null && out[k] !== undefined) out[k] = Number(out[k]);
  return out as unknown as SignalRow;
}

const placeholders = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `$${from + i}`).join(', ');

export interface SignalInsert {
  asset: string;
  direction: string;
  timeframe: string;
  entry: number;
  stopLoss: number;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
  riskLevel: string;
  analysis: string;
  teaser: string;
  visibility: string;
  createdBy: string;
}

export async function insertSignal(db: Q, i: SignalInsert): Promise<SignalRow> {
  const { rows } = await db.query<SignalRow>(
    `insert into signals (id, asset, direction, timeframe, entry, stop_loss, take_profit_1, take_profit_2, take_profit_3,
        risk_level, analysis, teaser, visibility, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
    [randomUUID(), i.asset, i.direction, i.timeframe, i.entry, i.stopLoss, i.takeProfit1, i.takeProfit2, i.takeProfit3,
      i.riskLevel, i.analysis, i.teaser, i.visibility, i.createdBy],
  );
  return mapSignal(rows[0]!);
}

export async function getSignal(db: Q, id: string): Promise<SignalRow | undefined> {
  const { rows } = await db.query<SignalRow>('select * from signals where id = $1', [id]);
  return rows[0] && mapSignal(rows[0]);
}

export interface SignalFilters {
  asset?: string;
  visibility?: string;
  status?: string;
  from?: Date;
  to?: Date;
}

export async function listSignals(db: Q, f: SignalFilters, limit: number, offset: number): Promise<SignalRow[]> {
  const where: string[] = [];
  const vals: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    vals.push(v);
    where.push(sql.replace('?', `$${vals.length}`));
  };
  if (f.asset) add('asset = ?', f.asset);
  if (f.visibility) add('visibility = ?', f.visibility);
  if (f.status) add('status = ?', f.status);
  if (f.from) add('created_at >= ?', f.from);
  if (f.to) add('created_at < ?', f.to);
  vals.push(limit, offset);
  const { rows } = await db.query<SignalRow>(
    `select * from signals ${where.length ? 'where ' + where.join(' and ') : ''}
      order by created_at desc, id desc limit $${vals.length - 1} offset $${vals.length}`,
    vals,
  );
  return rows.map(mapSignal);
}

export async function listAssets(db: Q): Promise<string[]> {
  const { rows } = await db.query<{ asset: string }>('select distinct asset from signals order by asset');
  return rows.map((r) => r.asset);
}

/** Column names come from this fixed map, never from request keys. */
const COLUMN: Record<string, string> = {
  asset: 'asset', direction: 'direction', timeframe: 'timeframe', entry: 'entry', stopLoss: 'stop_loss',
  takeProfit1: 'take_profit_1', takeProfit2: 'take_profit_2', takeProfit3: 'take_profit_3',
  riskLevel: 'risk_level', analysis: 'analysis', teaser: 'teaser', visibility: 'visibility',
  status: 'status', result: 'result', tpLevel: 'tp_level', pips: 'pips', closedAt: 'closed_at',
};

export async function updateSignal(db: Q, id: string, patch: Record<string, unknown>): Promise<SignalRow | undefined> {
  const sets: string[] = [];
  const vals: unknown[] = [id];
  for (const [k, v] of Object.entries(patch)) {
    const col = COLUMN[k];
    if (!col) throw new Error(`Unknown signal field: ${k}`);
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  }
  const { rows } = await db.query<SignalRow>(
    `update signals set ${sets.join(', ')}${sets.length ? ',' : ''} updated_at = now() where id = $1 returning *`,
    vals,
  );
  return rows[0] && mapSignal(rows[0]);
}

// ---- history ----
export async function addUpdate(
  db: Q,
  u: { signalId: string; authorId: string; kind: UpdateKind; message: string; changes?: object },
): Promise<string> {
  const id = randomUUID();
  await db.query(
    'insert into signal_updates (id, signal_id, author_id, kind, message, changes) values ($1,$2,$3,$4,$5,$6)',
    [id, u.signalId, u.authorId, u.kind, u.message, JSON.stringify(u.changes ?? {})],
  );
  return id;
}

export async function listUpdates(db: Q, signalId: string): Promise<UpdateRow[]> {
  const { rows } = await db.query<UpdateRow>(
    'select id, signal_id, kind, message, changes, created_at from signal_updates where signal_id = $1 order by created_at asc, id asc',
    [signalId],
  );
  return rows;
}

// ---- images ----
export async function addImage(
  db: Q,
  i: { signalId: string; storageKey: string; contentType: string; size: number; position: number },
): Promise<ImageRow> {
  const { rows } = await db.query<ImageRow>(
    `insert into signal_images (id, signal_id, storage_key, content_type, size_bytes, position)
     values ($1,$2,$3,$4,$5,$6) returning *`,
    [randomUUID(), i.signalId, i.storageKey, i.contentType, i.size, i.position],
  );
  return rows[0]!;
}

export async function listImages(db: Q, signalId: string): Promise<ImageRow[]> {
  const { rows } = await db.query<ImageRow>(
    'select * from signal_images where signal_id = $1 order by position asc, created_at asc',
    [signalId],
  );
  return rows;
}

export async function getImage(db: Q, signalId: string, imageId: string): Promise<ImageRow | undefined> {
  const { rows } = await db.query<ImageRow>('select * from signal_images where id = $1 and signal_id = $2', [imageId, signalId]);
  return rows[0];
}

export async function deleteImage(db: Q, imageId: string): Promise<void> {
  await db.query('delete from signal_images where id = $1', [imageId]);
}

// ---- engagement ----
export interface Stats {
  reactions: Record<ReactionType, number>;
  comments: number;
  views: number;
}
export interface Viewer {
  reaction: ReactionType | null;
  bookmarked: boolean;
}

/** Batched aggregates for a page of signals (3 queries total, not 3 per signal). */
export async function loadStats(db: Q, ids: string[]): Promise<Map<string, Stats>> {
  const map = new Map<string, Stats>(
    ids.map((id) => [id, { reactions: { like: 0, fire: 0, target: 0 }, comments: 0, views: 0 }]),
  );
  if (ids.length === 0) return map;
  const ph = placeholders(ids.length);
  const reactions = await db.query<{ signal_id: string; type: ReactionType; n: string | number }>(
    `select signal_id, type, count(*) as n from signal_reactions where signal_id in (${ph}) group by signal_id, type`, ids);
  for (const r of reactions.rows) map.get(r.signal_id)!.reactions[r.type] = Number(r.n);
  const comments = await db.query<{ signal_id: string; n: string | number }>(
    `select signal_id, count(*) as n from signal_comments where signal_id in (${ph}) and deleted_at is null group by signal_id`, ids);
  for (const r of comments.rows) map.get(r.signal_id)!.comments = Number(r.n);
  const views = await db.query<{ signal_id: string; n: string | number }>(
    `select signal_id, count(*) as n from signal_views where signal_id in (${ph}) group by signal_id`, ids);
  for (const r of views.rows) map.get(r.signal_id)!.views = Number(r.n);
  return map;
}

export async function loadViewer(db: Q, userId: string, ids: string[]): Promise<Map<string, Viewer>> {
  const map = new Map<string, Viewer>(ids.map((id) => [id, { reaction: null, bookmarked: false }]));
  if (ids.length === 0) return map;
  const ph = placeholders(ids.length, 2);
  const rx = await db.query<{ signal_id: string; type: ReactionType }>(
    `select signal_id, type from signal_reactions where user_id = $1 and signal_id in (${ph})`, [userId, ...ids]);
  for (const r of rx.rows) map.get(r.signal_id)!.reaction = r.type;
  const bm = await db.query<{ signal_id: string }>(
    `select signal_id from signal_bookmarks where user_id = $1 and signal_id in (${ph})`, [userId, ...ids]);
  for (const r of bm.rows) map.get(r.signal_id)!.bookmarked = true;
  return map;
}

export async function recordView(db: Q, signalId: string, userId: string): Promise<void> {
  await db.query('insert into signal_views (signal_id, user_id) values ($1,$2) on conflict do nothing', [signalId, userId]);
}

export async function setReaction(db: Q, signalId: string, userId: string, type: ReactionType): Promise<void> {
  await db.query('delete from signal_reactions where signal_id = $1 and user_id = $2', [signalId, userId]);
  await db.query('insert into signal_reactions (signal_id, user_id, type) values ($1,$2,$3)', [signalId, userId, type]);
}

export async function clearReaction(db: Q, signalId: string, userId: string): Promise<void> {
  await db.query('delete from signal_reactions where signal_id = $1 and user_id = $2', [signalId, userId]);
}

export async function addBookmark(db: Q, signalId: string, userId: string): Promise<void> {
  await db.query('insert into signal_bookmarks (user_id, signal_id) values ($1,$2) on conflict do nothing', [userId, signalId]);
}

export async function removeBookmark(db: Q, signalId: string, userId: string): Promise<void> {
  await db.query('delete from signal_bookmarks where user_id = $1 and signal_id = $2', [userId, signalId]);
}

export async function listBookmarkedSignals(db: Q, userId: string, limit: number, offset: number): Promise<SignalRow[]> {
  const { rows } = await db.query<SignalRow>(
    `select s.* from signal_bookmarks b join signals s on s.id = b.signal_id
      where b.user_id = $1 order by b.created_at desc, s.id desc limit $2 offset $3`,
    [userId, limit, offset],
  );
  return rows.map(mapSignal);
}

// ---- comments ----
export interface CommentRow {
  id: string;
  body: string;
  created_at: Date;
  user_id: string;
  display_name: string;
  role: string;
}

export async function addComment(db: Q, signalId: string, userId: string, body: string): Promise<string> {
  const id = randomUUID();
  await db.query('insert into signal_comments (id, signal_id, user_id, body) values ($1,$2,$3,$4)', [id, signalId, userId, body]);
  return id;
}

export async function listComments(db: Q, signalId: string, limit: number, offset: number): Promise<CommentRow[]> {
  const { rows } = await db.query<CommentRow>(
    `select c.id, c.body, c.created_at, c.user_id, u.display_name, u.role
       from signal_comments c join users u on u.id = c.user_id
      where c.signal_id = $1 and c.deleted_at is null
      order by c.created_at asc, c.id asc limit $2 offset $3`,
    [signalId, limit, offset],
  );
  return rows;
}

export async function getComment(db: Q, id: string) {
  const { rows } = await db.query<{ id: string; user_id: string; signal_id: string; deleted_at: Date | null }>(
    'select id, user_id, signal_id, deleted_at from signal_comments where id = $1',
    [id],
  );
  return rows[0];
}

export async function softDeleteComment(db: Q, id: string, byUserId: string): Promise<void> {
  await db.query('update signal_comments set deleted_at = now(), deleted_by = $2 where id = $1', [id, byUserId]);
}

export async function listImagesForSignals(db: Q, ids: string[]): Promise<Map<string, ImageRow[]>> {
  const map = new Map<string, ImageRow[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return map;
  const { rows } = await db.query<ImageRow>(
    `select * from signal_images where signal_id in (${placeholders(ids.length)}) order by position asc, created_at asc`,
    ids,
  );
  for (const r of rows) map.get(r.signal_id)!.push(r);
  return map;
}
