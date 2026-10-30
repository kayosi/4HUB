import type { FastifyPluginAsync } from 'fastify';

/**
 * Payment provider callbacks. Unauthenticated by session by design: authenticity comes from the provider's
 * signature/secret, checked against the RAW request body (re-serialised JSON would break signatures).
 */
const webhookRoutes: FastifyPluginAsync = async (app) => {
  // Scoped to this plugin only: keep the exact bytes the provider signed.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/:provider', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const { provider } = req.params as { provider: string };
    const result = await app.billing.handleWebhook(provider, raw, req.headers, req.query as Record<string, string | undefined>);
    return reply.code(200).send({ received: true, outcome: result.outcome });
  });
};

export default webhookRoutes;
