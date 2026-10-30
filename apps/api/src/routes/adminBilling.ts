import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../plugins/auth.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { parse } from '../lib/validate.js';
import { idSchema } from '../signals/schemas.js';
import * as repo from '../billing/repo.js';
import { billingSummary } from '../billing/stats.js';
import { serializeAdminPayment, serializePlan, serializeSubscription } from '../billing/serialize.js';
import { SUPPORTED_CURRENCIES, TIER_IDS } from '../billing/tiers.js';
import { withTransaction } from '../db/index.js';
import { findUserById } from '../db/repos.js';

const features = z.array(z.string().trim().min(1).max(120)).max(20);
const money = z.number().int().min(0).max(100_000_000);
const currency = z.enum(SUPPORTED_CURRENCIES);

const createPlanSchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_]{2,39}$/, 'Use lowercase letters, numbers and underscores (3-40 chars)'),
    name: z.string().trim().min(2).max(60),
    description: z.string().trim().max(300).default(''),
    tier: z.enum(TIER_IDS as [string, ...string[]]),
    priceMinor: money,
    currency,
    durationDays: z.number().int().min(1).max(3660).nullable(),
    features: features.default([]),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(1000).default(0),
  })
  .strict();

// code and tier are immutable: history, payments and entitlements refer to them.
const updatePlanSchema = z
  .object({
    name: z.string().trim().min(2).max(60), description: z.string().trim().max(300), priceMinor: money, currency,
    durationDays: z.number().int().min(1).max(3660).nullable(), features, isActive: z.boolean(), sortOrder: z.number().int().min(0).max(1000),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

function checkPlanShape(tier: string, priceMinor: number, durationDays: number | null) {
  if (tier === 'free') {
    if (priceMinor !== 0 || durationDays !== null) throw badRequest('The free tier must have price 0 and no duration');
  } else if (priceMinor <= 0 || durationDays === null) {
    throw badRequest('Paid plans need a price above 0 and a duration in days');
  }
}

const reason = z.string().trim().min(3, 'Give a short reason').max(200);
const rangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform((s) => new Date(`${s}T00:00:00.000Z`)).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform((s) => new Date(`${s}T00:00:00.000Z`)).optional(),
});
const toId = (v: unknown) => {
  const r = idSchema.safeParse(v);
  if (!r.success) throw notFound('Not found');
  return r.data;
};

const adminBillingRoutes: FastifyPluginAsync = async (app) => {
  const db = app.db;
  app.addHook('preHandler', requireRole('admin'));

  // ---- plans ----
  app.get('/plans', async () => ({ plans: (await repo.listPlans(db, { activeOnly: false })).map(serializePlan) }));

  app.post('/plans', async (req, reply) => {
    const b = parse(createPlanSchema, req.body);
    checkPlanShape(b.tier, b.priceMinor, b.durationDays);
    if (await repo.getPlanByCode(db, b.code)) throw conflict('A plan with this code already exists');
    const plan = await withTransaction(db, async (tx) => {
      const p = await repo.insertPlan(tx, b);
      await repo.audit(tx, { actorId: req.user!.id, action: 'plan.created', entityType: 'plan', entityId: p.id, data: { code: p.code, priceMinor: p.price_minor, currency: p.currency, durationDays: p.duration_days } });
      return p;
    });
    return reply.code(201).send({ plan: serializePlan(plan) });
  });

  app.patch('/plans/:id', async (req) => {
    const before = await repo.getPlanById(db, toId((req.params as { id: string }).id));
    if (!before) throw notFound('Plan not found');
    const patch = parse(updatePlanSchema, req.body);
    checkPlanShape(before.tier, patch.priceMinor ?? before.price_minor, patch.durationDays === undefined ? before.duration_days : patch.durationDays);
    if (before.code === 'free' && patch.isActive === false) throw badRequest('The free plan cannot be deactivated');
    // Existing payments and subscriptions keep the price/duration they were sold at (snapshot taken at checkout).
    const plan = await withTransaction(db, async (tx) => {
      const p = (await repo.updatePlan(tx, before.id, patch))!;
      await repo.audit(tx, { actorId: req.user!.id, action: 'plan.updated', entityType: 'plan', entityId: p.id, data: { changed: Object.keys(patch), before: { priceMinor: before.price_minor, currency: before.currency, durationDays: before.duration_days, isActive: before.is_active } } });
      return p;
    });
    return { plan: serializePlan(plan) };
  });

  // ---- reporting ----
  app.get('/billing/summary', async (req) => {
    const range = parse(rangeSchema, req.query);
    const s = await billingSummary(db, app.now(), app.config.SUBSCRIPTION_GRACE_DAYS, range);
    return { ...s, recent: s.recent.map(serializeAdminPayment) };
  });

  app.get('/billing/transactions', async (req) => {
    const q = parse(z.object({
      status: z.enum(['pending', 'succeeded', 'failed', 'cancelled', 'refunded', 'partially_refunded']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).default(0),
    }), req.query);
    return { transactions: (await repo.listPaymentsAdmin(db, q.status, q.limit, q.offset)).map(serializeAdminPayment) };
  });

  // ---- refunds recorded after the fact ----
  app.post('/payments/:id/refund', async (req) => {
    const b = parse(z.object({ amountMinor: z.number().int().positive().optional(), reason }).strict(), req.body);
    const p = await app.billing.recordManualRefund(req.user!.id, toId((req.params as { id: string }).id), b.amountMinor, b.reason);
    return { payment: serializeAdminPayment({ ...p, user_email: '', user_name: '' }) };
  });

  // ---- complimentary access / revocation ----
  app.get('/users/:id/subscription', async (req) => {
    const views = await app.billing.subscriptionsView(toId((req.params as { id: string }).id));
    return { subscriptions: views.map((v) => serializeSubscription(v.sub, v.plan, v.state, v.now)) };
  });

  app.post('/users/:id/subscription/grant', async (req, reply) => {
    const b = parse(z.object({ planCode: z.string().min(1).max(60), days: z.number().int().min(1).max(3660).optional(), reason }).strict(), req.body);
    const userId = toId((req.params as { id: string }).id);
    if (!(await findUserById(db, userId))) throw notFound('User not found');
    await app.billing.grant(req.user!.id, userId, b.planCode, b.days, b.reason);
    return reply.code(204).send();
  });

  app.post('/users/:id/subscription/revoke', async (req, reply) => {
    const b = parse(z.object({ tier: z.enum(TIER_IDS as [string, ...string[]]).default('premium'), reason }).strict(), req.body);
    await app.billing.revoke(req.user!.id, toId((req.params as { id: string }).id), b.tier, b.reason);
    return reply.code(204).send();
  });
};

export default adminBillingRoutes;
