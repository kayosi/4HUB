import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../plugins/auth.js';
import { countUsersByRole, findUserById, listUsers, updateRole } from '../db/repos.js';
import { adminUserView } from './auth.js';
import { ROLES } from '../auth/roles.js';
import { badRequest, notFound } from '../errors.js';
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
    return { users: rows.map(adminUserView), limit: q.limit, offset: q.offset };
  });

  // Until payments exist this is how a member is promoted to premium (or staff). Roles are re-read
  // from the database on every request, so a change takes effect immediately.
  app.patch('/users/:id/role', async (req) => {
    const id = z.string().uuid().safeParse((req.params as { id: string }).id);
    if (!id.success) throw notFound('User not found');
    const { role } = parse(z.object({ role: z.enum(ROLES) }), req.body);
    if (id.data === req.user!.id) throw badRequest('You cannot change your own role');
    if (!(await findUserById(app.db, id.data))) throw notFound('User not found');
    return { user: adminUserView((await updateRole(app.db, id.data, role))!) };
  });
};
