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
import './types.js';

export interface AppDeps {
  config: Config;
  db: Db;
  mailer?: Mailer;
}

export async function buildApp({ config, db, mailer }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]', '*.password'],
    },
    trustProxy: config.NODE_ENV === 'production',
    bodyLimit: 100_000,
  });

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('mailer', mailer ?? createLogMailer(app.log, config.NODE_ENV === 'production'));

  await app.register(helmet);
  await app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  await app.register(cookie);
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
    const code = status === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST';
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
      await api.register(adminRoutes, { prefix: '/admin' });
      // Future modules (payments, bots, copy-trading, community) register here as new route plugins.
    },
    { prefix: '/api' },
  );

  return app;
}
