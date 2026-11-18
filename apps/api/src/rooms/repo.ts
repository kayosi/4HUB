import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { RoomAccess, RoomCategory, RoomRow } from './model.js';

type Q = Pick<Db, 'query'>;

export interface RoomInsert {
  slug: string;
  name: string;
  description: string;
  guidelines: string;
  category: RoomCategory;
  access: RoomAccess;
  sortOrder: number;
  createdBy: string;
  now: Date;
}

export async function insertRoom(db: Q, i: RoomInsert): Promise<RoomRow> {
  const { rows } = await db.query<RoomRow>(
    `insert into community_rooms (id, slug, name, description, guidelines, category, access, sort_order, created_by, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) returning *`,
    [randomUUID(), i.slug, i.name, i.description, i.guidelines, i.category, i.access, i.sortOrder, i.createdBy, i.now],
  );
  return rows[0]!;
}

export const getRoomById = async (db: Q, id: string) =>
  (await db.query<RoomRow>('select * from community_rooms where id = $1', [id])).rows[0];

export const getRoomBySlug = async (db: Q, slug: string) =>
  (await db.query<RoomRow>('select * from community_rooms where slug = $1', [slug])).rows[0];

export type RoomStatusFilter = 'active' | 'archived' | 'all';

/** Rooms are few and curated by staff; a hard cap keeps the response bounded regardless. */
export async function listRooms(db: Q, f: { status: RoomStatusFilter; category?: RoomCategory }): Promise<RoomRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.status === 'active') where.push('archived_at is null');
  if (f.status === 'archived') where.push('archived_at is not null');
  if (f.category) {
    params.push(f.category);
    where.push(`category = $${params.length}`);
  }
  const sql = `select * from community_rooms ${where.length ? `where ${where.join(' and ')}` : ''} order by sort_order asc, name asc limit 200`;
  return (await db.query<RoomRow>(sql, params)).rows;
}

export interface RoomPatch {
  name?: string;
  description?: string;
  guidelines?: string;
  category?: RoomCategory;
  access?: RoomAccess;
  sortOrder?: number;
}

// Column names come from this fixed map, never from request input.
const COLUMNS: Record<keyof RoomPatch, string> = {
  name: 'name', description: 'description', guidelines: 'guidelines', category: 'category', access: 'access', sortOrder: 'sort_order',
};

export async function updateRoom(db: Q, id: string, patch: RoomPatch, actorId: string, now: Date): Promise<RoomRow | undefined> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const key of Object.keys(COLUMNS) as (keyof RoomPatch)[]) {
    if (patch[key] === undefined) continue;
    params.push(patch[key]);
    sets.push(`${COLUMNS[key]} = $${params.length}`);
  }
  params.push(actorId, now);
  sets.push(`updated_by = $${params.length - 1}`, `updated_at = $${params.length}`);
  return (await db.query<RoomRow>(`update community_rooms set ${sets.join(', ')} where id = $1 returning *`, params)).rows[0];
}

export async function setRoomArchived(db: Q, id: string, archived: boolean, actorId: string, now: Date): Promise<RoomRow | undefined> {
  const { rows } = await db.query<RoomRow>(
    `update community_rooms set archived_at = $2, archived_by = $3, updated_by = $4, updated_at = $5 where id = $1 returning *`,
    [id, archived ? now : null, archived ? actorId : null, actorId, now],
  );
  return rows[0];
}
