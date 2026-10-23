import { newDb } from 'pg-mem';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import type { Db } from '../src/db/index.js';
import type { Mailer } from '../src/lib/mailer.js';
import { createUser } from '../src/db/repos.js';
import { hashPassword } from '../src/auth/password.js';
import type { Role } from '../src/auth/roles.js';

export const PASSWORD = 'correct-horse-battery';

export async function makeApp() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const db = new Pool() as unknown as Db;
  await migrate(db);
  const resetTokens: Record<string, string> = {};
  const mailer: Mailer = { sendPasswordReset: async (to, token) => void (resetTokens[to] = token) };
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'memory',
    LOG_LEVEL: 'silent',
    AUTH_RATE_LIMIT_MAX: '1000',
  });
  const app: FastifyInstance = await buildApp({ config, db, mailer });
  return { app, db, resetTokens };
}

export async function seedUser(db: Db, role: Role, email = `${role}@example.com`) {
  return createUser(db, { email, displayName: `${role} user`, passwordHash: await hashPassword(PASSWORD), role });
}

/** Logs in and returns the Cookie header value for subsequent requests. */
export async function loginCookie(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  const c = res.cookies[0]!;
  return `${c.name}=${c.value}`;
}
