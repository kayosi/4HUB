import { randomUUID } from 'node:crypto';
import type { Db } from './index.js';
import type { Role } from '../auth/roles.js';

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  created_at: Date;
}
export interface UserWithHash extends UserRow {
  password_hash: string;
}

const cols = 'id, email, display_name, role, created_at';
type Q = Pick<Db, 'query'>;

export async function createUser(
  db: Q,
  input: { email: string; passwordHash: string; displayName: string; role?: Role },
): Promise<UserRow> {
  const { rows } = await db.query<UserRow>(
    `insert into users (id, email, password_hash, display_name, role) values ($1,$2,$3,$4,$5) returning ${cols}`,
    [randomUUID(), input.email, input.passwordHash, input.displayName, input.role ?? 'free'],
  );
  return rows[0]!;
}

export async function findUserByEmail(db: Q, email: string): Promise<UserWithHash | undefined> {
  const { rows } = await db.query<UserWithHash>(`select ${cols}, password_hash from users where email = $1`, [email]);
  return rows[0];
}

export async function updateDisplayName(db: Q, id: string, displayName: string): Promise<UserRow | undefined> {
  const { rows } = await db.query<UserRow>(
    `update users set display_name = $2, updated_at = now() where id = $1 returning ${cols}`,
    [id, displayName],
  );
  return rows[0];
}

export async function updatePassword(db: Q, id: string, passwordHash: string): Promise<void> {
  await db.query('update users set password_hash = $2, updated_at = now() where id = $1', [id, passwordHash]);
}

export async function listUsers(db: Q, limit: number, offset: number): Promise<UserRow[]> {
  const { rows } = await db.query<UserRow>(`select ${cols} from users order by created_at desc limit $1 offset $2`, [
    limit,
    offset,
  ]);
  return rows;
}

export async function countUsersByRole(db: Q): Promise<Record<string, number>> {
  const { rows } = await db.query<{ role: string; n: string | number }>(
    'select role, count(*) as n from users group by role',
  );
  return Object.fromEntries(rows.map((r) => [r.role, Number(r.n)]));
}

export async function createSession(db: Q, tokenHash: string, userId: string, expiresAt: Date): Promise<void> {
  await db.query('insert into sessions (token_hash, user_id, expires_at) values ($1,$2,$3)', [
    tokenHash,
    userId,
    expiresAt,
  ]);
}

export async function findUserBySession(db: Q, tokenHash: string): Promise<UserRow | undefined> {
  const { rows } = await db.query<UserRow>(
    `select u.id, u.email, u.display_name, u.role, u.created_at
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()`,
    [tokenHash],
  );
  return rows[0];
}

export async function deleteSession(db: Q, tokenHash: string): Promise<void> {
  await db.query('delete from sessions where token_hash = $1', [tokenHash]);
}

export async function deleteUserSessions(db: Q, userId: string): Promise<void> {
  await db.query('delete from sessions where user_id = $1', [userId]);
}

export async function createResetToken(db: Q, tokenHash: string, userId: string, expiresAt: Date): Promise<void> {
  await db.query('insert into password_reset_tokens (token_hash, user_id, expires_at) values ($1,$2,$3)', [
    tokenHash,
    userId,
    expiresAt,
  ]);
}

/** Atomically claims an unused, unexpired token. Returns the user id or undefined. */
export async function consumeResetToken(db: Q, tokenHash: string): Promise<string | undefined> {
  const { rows } = await db.query<{ user_id: string }>(
    `update password_reset_tokens set used_at = now()
      where token_hash = $1 and used_at is null and expires_at > now() returning user_id`,
    [tokenHash],
  );
  return rows[0]?.user_id;
}
