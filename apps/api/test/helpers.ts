import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { LocalDiskStorage } from '../src/storage/index.js';

export const PASSWORD = 'correct-horse-battery';
export const ROLES: Role[] = ['free', 'premium', 'moderator', 'admin'];

export async function makeApp(env: Record<string, string> = {}) {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const db = new Pool() as unknown as Db;
  await migrate(db);
  const resetTokens: Record<string, string> = {};
  const mailer: Mailer = { sendPasswordReset: async (to, token) => void (resetTokens[to] = token) };
  const uploadDir = mkdtempSync(join(tmpdir(), '4hub-uploads-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'memory',
    LOG_LEVEL: 'silent',
    AUTH_RATE_LIMIT_MAX: '1000',
    ...env,
  });
  const app: FastifyInstance = await buildApp({ config, db, mailer, storage: new LocalDiskStorage(uploadDir) });
  return { app, db, resetTokens, uploadDir, storedFiles: () => { try { return readdirSync(uploadDir); } catch { return []; } } };
}

let cachedHash: Promise<string> | undefined;
export async function seedUser(db: Db, role: Role, email = `${role}@example.com`) {
  cachedHash ??= hashPassword(PASSWORD);
  return createUser(db, { email, displayName: `${role} user`, passwordHash: await cachedHash, role });
}

/** Logs in and returns the Cookie header value for subsequent requests. */
export async function loginCookie(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  const c = res.cookies[0]!;
  return `${c.name}=${c.value}`;
}

/** App + one seeded, logged-in user per role. `visitor` is simply no cookie. */
export async function setup(env: Record<string, string> = {}) {
  const ctx = await makeApp(env);
  const cookies = {} as Record<Role, string>;
  const users = {} as Record<Role, { id: string; email: string }>;
  for (const role of ROLES) {
    users[role] = await seedUser(ctx.db, role);
    cookies[role] = await loginCookie(ctx.app, `${role}@example.com`);
  }
  return { ...ctx, cookies, users };
}
export type Ctx = Awaited<ReturnType<typeof setup>>;

// Distinctive decimals so leak assertions cannot collide with uuids or timestamps.
export const SECRET = { entry: 2350.55, stopLoss: 2339.45, tp1: 2361.25, tp2: 2372.75, tp3: 2384.35, analysis: 'SECRET-ANALYSIS gold bounce off support', teaser: 'Gold setup brewing' };

export const signalPayload = (over: Record<string, unknown> = {}) => ({
  asset: 'xauusd', direction: 'buy', timeframe: 'H1', entry: SECRET.entry, stopLoss: SECRET.stopLoss,
  takeProfit1: SECRET.tp1, takeProfit2: SECRET.tp2, takeProfit3: SECRET.tp3, riskLevel: 'medium',
  analysis: SECRET.analysis, teaser: SECRET.teaser, visibility: 'premium', ...over,
});

export async function createSignal(ctx: Ctx, over: Record<string, unknown> = {}) {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/admin/signals', headers: { cookie: ctx.cookies.admin }, payload: signalPayload(over) });
  if (res.statusCode !== 201) throw new Error(`create failed: ${res.body}`);
  return res.json().signal as { id: string; [k: string]: unknown };
}

export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);

export function multipart(files: { data: Buffer; name?: string; type?: string }[]) {
  const boundary = '----4hubtestboundary';
  const chunks: Buffer[] = [];
  for (const f of files) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name ?? 'chart.png'}"\r\nContent-Type: ${f.type ?? 'image/png'}\r\n\r\n`),
      f.data,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

export async function uploadImages(ctx: Ctx, signalId: string, files: { data: Buffer; name?: string; type?: string }[]) {
  const m = multipart(files);
  return ctx.app.inject({ method: 'POST', url: `/api/admin/signals/${signalId}/images`, payload: m.payload, headers: { ...m.headers, cookie: ctx.cookies.admin } });
}

export const get = (ctx: Ctx, url: string, cookie?: string) => ctx.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
export const send = (ctx: Ctx, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, cookie?: string, payload?: unknown) =>
  ctx.app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload !== undefined ? { payload: payload as object } : {}) });
