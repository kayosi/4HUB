import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { AppError, forbidden } from './errors.js';
import { createLogMailer, type Mailer } from './lib/mailer.js';
import authPlugin from './plugins/auth.js';
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import { adminRoutes, memberRoutes, moderationRoutes } from './routes/areas.js';
import multipart from '@fastify/multipart';
import { LocalDiskStorage, type FileStorage } from './storage/index.js';
import signalRoutes, { commentRoutes } from './routes/signals.js';
import adminSignalRoutes from './routes/adminSignals.js';
import { BillingService } from './billing/service.js';
import { createRegistry, type ProviderRegistry } from './billing/providers/registry.js';
import type { FetchLike } from './billing/providers/types.js';
import billingRoutes from './routes/billing.js';
import webhookRoutes from './routes/webhooks.js';
import sandboxRoutes from './routes/sandbox.js';
import adminBillingRoutes from './routes/adminBilling.js';
import roomRoutes, { staffRoomRoutes } from './routes/rooms.js';
import messageRoutes from './routes/messages.js';
import { adminRestrictionRoutes, moderationQueueRoutes } from './routes/moderation.js';
import { ChatHub } from './chat/hub.js';
import { WriteLimiter } from './chat/limiter.js';
import './types.js';

export interface AppDeps {
  config: Config;
  db: Db;
  mailer?: Mailer;
  storage?: FileStorage;
  clock?: () => Date;
  /** Override for tests; defaults to the providers named in PAYMENT_PROVIDERS. */
  providers?: ProviderRegistry;
  http?: FetchLike;
}

export async function buildApp({ config, db, mailer, storage, clock, providers, http }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-paystack-signature"]', 'req.headers["x-mock-signature"]', 'res.headers["set-cookie"]', '*.password', '*.phoneNumber', 'req.query.token'],
    },
    trustProxy: config.NODE_ENV === 'production',
    bodyLimit: 100_000,
  });

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('mailer', mailer ?? createLogMailer(app.log, config.NODE_ENV === 'production'));

  const now = clock ?? (() => new Date());
  app.decorate('now', now);
  const registry = providers ?? createRegistry(config, (http ?? (fetch as unknown as FetchLike)), now);
  app.decorate('billing', new BillingService(db, registry, {
    graceDays: config.SUBSCRIPTION_GRACE_DAYS, webPublicUrl: config.WEB_PUBLIC_URL, apiPublicUrl: config.API_PUBLIC_URL,
  }, now, app.log));
  app.decorate('storage', storage ?? new LocalDiskStorage(config.UPLOAD_DIR));
  app.decorate('chatHub', new ChatHub());
  app.decorate('chatLimiter', new WriteLimiter(config.CHAT_WRITES_PER_MINUTE, 60_000, now));
  // Open live streams would otherwise keep the HTTP server from closing.
  app.addHook('preClose', async () => app.chatHub.closeAll());

  await app.register(helmet);
  await app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 5, fields: 5, parts: 12 } });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  // CSRF defence in depth (alongside SameSite=Lax): browsers always send Origin on
  // cross-site state-changing requests, so reject any that is not our web origin.
  app.addHook('onRequest', async (req) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== config.WEB_ORIGIN) throw forbidden('Cross-origin request rejected');
    }
  });

  await app.register(authPlugin);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'Validation failed' } });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, 'Unhandled error');
      return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
    }
    const code = status === 429 ? 'RATE_LIMITED' : status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST';
    return reply.code(status).send({ error: { code, message: (err as Error).message } });
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }),
  );

  await app.register(
    async (api) => {
      api.get('/health', async () => ({ status: 'ok' }));
      await api.register(authRoutes, { prefix: '/auth' });
      await api.register(meRoutes, { prefix: '/me' });
      await api.register(memberRoutes, { prefix: '/member' });
      await api.register(moderationRoutes, { prefix: '/moderation' });
      await api.register(signalRoutes, { prefix: '/signals' });
      await api.register(commentRoutes, { prefix: '/comments' });
      await api.register(billingRoutes, { prefix: '/billing' });
      await api.register(webhookRoutes, { prefix: '/webhooks/payments' });
      // The sandbox "provider" exists only outside production and only when explicitly enabled.
      if (config.NODE_ENV !== 'production' && registry.get('mock')) await api.register(sandboxRoutes, { prefix: '/billing/sandbox' });
      await api.register(adminRoutes, { prefix: '/admin' });
      await api.register(adminBillingRoutes, { prefix: '/admin' });
      await api.register(adminSignalRoutes, { prefix: '/admin/signals' });
      await api.register(roomRoutes, { prefix: '/rooms' });
      await api.register(messageRoutes, { prefix: '/rooms' });
      await api.register(staffRoomRoutes, { prefix: '/staff/rooms' });
      await api.register(moderationQueueRoutes, { prefix: '/moderation' });
      await api.register(adminRestrictionRoutes, { prefix: '/admin' });
      // Future modules (bots, copy-trading, chat) register here as new route plugins.
    },
    { prefix: '/api' },
  );

  return app;
}
