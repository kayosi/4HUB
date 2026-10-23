import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../plugins/auth.js';
import { countUsersByRole, listUsers } from '../db/repos.js';
import { publicUser } from './auth.js';
import { hasPremiumAccess } from '../auth/roles.js';
import { parse } from '../lib/validate.js';

/** Member area: any signed-in user. Premium content is gated server-side. */
export const memberRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/overview', async (req) => ({
    greeting: req.user!.display_name,
    role: req.user!.role,
    premium: hasPremiumAccess(req.user!.role),
    // Later modules (signals, courses, community) will populate this list.
    items: [] as unknown[],
  }));

  app.get('/premium', { preHandler: requireRole('premium', 'moderator', 'admin') }, async () => ({ items: [] }));
};

/** Moderation area: moderators and admins. */
export const moderationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireRole('moderator', 'admin'));
  app.get('/overview', async () => ({ queue: [] as unknown[] }));
};

/** Admin area: admins only. */
export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireRole('admin'));

  app.get('/overview', async () => ({ usersByRole: await countUsersByRole(app.db) }));

  app.get('/users', async (req) => {
    const q = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(25),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req.query,
    );
    const rows = await listUsers(app.db, q.limit, q.offset);
    return { users: rows.map(publicUser), limit: q.limit, offset: q.offset };
  });
};
