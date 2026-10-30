import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';
import { AppError, notFound } from '../errors.js';
import { parse } from '../lib/validate.js';
import { idSchema } from '../signals/schemas.js';
import * as repo from '../billing/repo.js';
import { serializePayment } from '../billing/serialize.js';
import type { MockProvider } from '../billing/providers/mock.js';

/**
 * Development/test only (never registered in production): plays the part of the payment provider so the full
 * checkout -> signed webhook -> verification -> activation pipeline can be exercised without real money.
 */
const sandboxRoutes: FastifyPluginAsync = async (app) => {
  app.post('/payments/:id/settle', { preHandler: requireAuth }, async (req) => {
    const mock = app.billing.providers.get('mock') as MockProvider | undefined;
    if (!mock) throw new AppError(404, 'NOT_FOUND', 'Sandbox is not enabled');
    const id = idSchema.safeParse((req.params as { id: string }).id);
    const p = id.success ? await repo.getPayment(app.db, id.data) : undefined;
    if (!p || p.user_id !== req.user!.id || p.provider !== 'mock' || !p.provider_reference) throw notFound('Payment not found');
    const { outcome } = parse(z.object({ outcome: z.enum(['succeeded', 'failed', 'cancelled']) }), req.body);
    const evt = mock.settle(p.provider_reference, outcome);
    await app.billing.handleWebhook('mock', evt.raw, evt.headers, {});
    return { payment: serializePayment((await repo.getPayment(app.db, p.id))!) };
  });
};

export default sandboxRoutes;
