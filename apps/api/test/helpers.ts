import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DataType, newDb } from 'pg-mem';
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
import { createRegistry } from '../src/billing/providers/registry.js';
import type { MockProvider } from '../src/billing/providers/mock.js';
import type { FetchLike } from '../src/billing/providers/types.js';

export const PASSWORD = 'correct-horse-battery';
/** In tests "premium" is a free-role account that holds an active subscription (premium is not a role). */
export type TestRole = Role | 'premium';
export const ROLES: TestRole[] = ['free', 'premium', 'moderator', 'admin'];

/** A clock the tests can move forward to exercise expiry, grace and renewal without waiting. */
export class TestClock {
  constructor(public current = new Date()) {}
  now = () => new Date(this.current);
  advanceDays(days: number) { this.current = new Date(this.current.getTime() + days * 86_400_000); }
  advanceMs(ms: number) { this.current = new Date(this.current.getTime() + ms); }
}

export async function makeApp(env: Record<string, string> = {}) {
  const mem = newDb();
  // Real PostgreSQL (13+) has this built in; pg-mem needs it registered for migration 003's data step.
  mem.public.registerFunction({ name: 'gen_random_uuid', returns: DataType.uuid, implementation: () => randomUUID(), impure: true });
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
    BILLING_RATE_LIMIT_MAX: '1000',
    PAYMENT_PROVIDERS: 'mock',
    MOCK_PROVIDER_SECRET: 'test-sandbox-secret',
    ...env,
  });
  const clock = new TestClock();
  const registry = createRegistry(config, (async () => { throw new Error('no network in tests'); }) as FetchLike, clock.now);
  const app: FastifyInstance = await buildApp({ config, db, mailer, storage: new LocalDiskStorage(uploadDir), clock: clock.now, providers: registry });
  const mock = registry.get('mock') as MockProvider;
  return { app, db, resetTokens, uploadDir, clock, mock, registry, storedFiles: () => { try { return readdirSync(uploadDir); } catch { return []; } } };
}

let cachedHash: Promise<string> | undefined;
export async function seedUser(db: Db, role: TestRole, email = `${role}@example.com`) {
  cachedHash ??= hashPassword(PASSWORD);
  return createUser(db, { email, displayName: `${role} user`, passwordHash: await cachedHash, role: role === 'premium' ? 'free' : role });
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
  const cookies = {} as Record<TestRole, string>;
  const users = {} as Record<TestRole, { id: string; email: string }>;
  for (const role of ROLES) {
    users[role] = await seedUser(ctx.db, role);
    cookies[role] = await loginCookie(ctx.app, `${role}@example.com`);
  }
  await ctx.app.billing.grant(users.admin.id, users.premium.id, 'premium_monthly', 30, 'test fixture');
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

// ---------------------------------------------------------------- payment helpers
export const checkoutReq = (ctx: Ctx, cookie: string | undefined, body: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/api/billing/checkout', headers: cookie ? { cookie } : {}, payload: body });

/** Starts a sandbox checkout and returns the payment id plus the provider-side reference. */
export async function startPayment(ctx: Ctx, cookie: string, planCode = 'premium_monthly', extra: Record<string, unknown> = {}) {
  const res = await checkoutReq(ctx, cookie, { planCode, provider: 'mock', ...extra });
  if (res.statusCode !== 201) throw new Error(`checkout failed: ${res.statusCode} ${res.body}`);
  const id = res.json().payment.id as string;
  const row = await ctx.db.query<{ provider_reference: string }>('select provider_reference from payments where id = $1', [id]);
  return { id, reference: row.rows[0]!.provider_reference, body: res.json() };
}

/** Delivers a (signed) webhook payload to the real HTTP endpoint. */
export const deliver = (ctx: Ctx, evt: { raw: Buffer; headers: Record<string, string> }, provider = 'mock', query = '') =>
  ctx.app.inject({ method: 'POST', url: `/api/webhooks/payments/${provider}${query}`, payload: evt.raw, headers: evt.headers });

/** Full happy path: checkout, provider settles, signed webhook delivered. */
export async function pay(ctx: Ctx, cookie: string, planCode = 'premium_monthly', outcome: 'succeeded' | 'failed' | 'cancelled' = 'succeeded') {
  const p = await startPayment(ctx, cookie, planCode);
  const evt = ctx.mock.settle(p.reference, outcome);
  const res = await deliver(ctx, evt);
  return { ...p, evt, res };
}

export async function row<T = Record<string, unknown>>(ctx: Ctx, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await ctx.db.query(sql, params)).rows as T[];
}
export const countRows = async (ctx: Ctx, table: string, where = 'true', params: unknown[] = []) =>
  Number((await row<{ c: string }>(ctx, `select count(*) as c from ${table} where ${where}`, params))[0]!.c);
export const sigLocked = async (ctx: Ctx, signalId: string, cookie?: string) =>
  (await get(ctx, `/api/signals/${signalId}`, cookie)).json().signal.locked as boolean;
