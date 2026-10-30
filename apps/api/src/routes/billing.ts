import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';
import { notFound } from '../errors.js';
import { parse } from '../lib/validate.js';
import { pageSchema, idSchema } from '../signals/schemas.js';
import * as repo from '../billing/repo.js';
import { serializeInvoice, serializePayment, serializePlan, serializeProvider, serializeSubscription, invoiceNumber } from '../billing/serialize.js';
import { TIER_IDS } from '../billing/tiers.js';

const checkoutSchema = z
  .object({
    planCode: z.string().trim().min(1).max(60),
    provider: z.string().trim().min(1).max(30),
    phoneNumber: z.string().trim().min(5).max(20).optional(),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, 'Invalid idempotency key').optional(),
  })
  // .strict(): a request that tries to supply price, amount, currency or status is rejected, not silently trimmed.
  .strict();

const tierBody = z.object({ tier: z.enum(TIER_IDS as [string, ...string[]]).default('premium') });

const toId = (v: unknown) => {
  const r = idSchema.safeParse(v);
  if (!r.success) throw notFound('Not found');
  return r.data;
};

const billingRoutes: FastifyPluginAsync = async (app) => {
  const db = app.db;
  const svc = app.billing;

  // Public: lets visitors see pricing.
  app.get('/plans', async () => ({
    plans: (await repo.listPlans(db, { activeOnly: true })).map(serializePlan),
    providers: svc.providers.list().map(serializeProvider),
  }));

  app.post('/checkout', { preHandler: requireAuth, config: { rateLimit: { max: app.config.BILLING_RATE_LIMIT_MAX, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(checkoutSchema, req.body);
    const r = await svc.checkout(req.user!, body);
    return reply.code(r.created ? 201 : 200).send({ payment: serializePayment(r.payment), action: r.action });
  });

  app.get('/payments', { preHandler: requireAuth }, async (req) => {
    const q = parse(pageSchema, req.query);
    return { payments: (await repo.listPaymentsForUser(db, req.user!.id, q.limit, q.offset)).map(serializePayment) };
  });

  app.get('/payments/:id', { preHandler: requireAuth }, async (req) => {
    const p = await repo.getPayment(db, toId((req.params as { id: string }).id));
    if (!p || p.user_id !== req.user!.id) throw notFound('Payment not found'); // other members' payments look nonexistent
    return { payment: serializePayment(p) };
  });

  // Customer-triggered re-check with the provider. The result comes from the provider, not from the browser.
  app.post('/payments/:id/verify', { preHandler: requireAuth, config: { rateLimit: { max: app.config.BILLING_RATE_LIMIT_MAX * 2, timeWindow: '1 minute' } } }, async (req) => {
    const p = await svc.syncPayment(req.user!.id, toId((req.params as { id: string }).id));
    return { payment: serializePayment(p) };
  });

  app.get('/subscription', { preHandler: requireAuth }, async (req) => {
    const views = await svc.subscriptionsView(req.user!.id);
    return {
      subscriptions: views.map((v) => serializeSubscription(v.sub, v.plan, v.state, v.now)),
      entitlement: req.user!.entitlement,
    };
  });

  app.post('/subscription/cancel', { preHandler: requireAuth }, async (req, reply) => {
    await svc.cancel(req.user!.id, parse(tierBody, req.body ?? {}).tier);
    return reply.code(204).send();
  });
  app.post('/subscription/resume', { preHandler: requireAuth }, async (req, reply) => {
    await svc.resume(req.user!.id, parse(tierBody, req.body ?? {}).tier);
    return reply.code(204).send();
  });

  app.get('/invoices', { preHandler: requireAuth }, async (req) => {
    const q = parse(pageSchema, req.query);
    return { invoices: (await repo.listInvoicesForUser(db, req.user!.id, q.limit, q.offset)).map(serializeInvoice) };
  });

  // Receipt: invoice + the payment details a customer needs, for their own records.
  app.get('/invoices/:id', { preHandler: requireAuth }, async (req) => {
    const inv = await repo.getInvoiceForUser(db, toId((req.params as { id: string }).id), req.user!.id);
    if (!inv) throw notFound('Invoice not found');
    const pay = await repo.getPaymentForInvoice(db, inv.payment_id);
    return {
      invoice: serializeInvoice(inv),
      receipt: {
        number: invoiceNumber(inv), customer: { name: req.user!.display_name, email: req.user!.email },
        provider: pay?.provider ?? null, payerHint: pay?.payer_hint ?? null, transactionId: pay?.provider_transaction_id ?? null,
        paidAt: pay?.paid_at ?? null, refundedMinor: pay?.refunded_minor ?? 0,
      },
    };
  });
};

export default billingRoutes;
