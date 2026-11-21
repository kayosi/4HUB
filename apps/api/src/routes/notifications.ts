import type { FastifyPluginAsync } from 'fastify';
import { requireAuth, requireRole } from '../plugins/auth.js';
import { notFound } from '../errors.js';
import { parse } from '../lib/validate.js';
import { listAnnouncements, listForUser, markAllRead, markRead, unreadCounts } from '../notifications/repo.js';
import { announcementSchema, idSchema, listQuerySchema, readAllSchema } from '../notifications/schemas.js';
import { serializeAnnouncement, serializeNotification } from '../notifications/serialize.js';

/**
 * A member's own notifications. There is no user id anywhere in these routes: every query is scoped to the signed-in user's id,
 * so one member can never read, count or change another's. (Suspended accounts are already refused by the auth plugin.)
 */
const notificationRoutes: FastifyPluginAsync = async (app) => {
  const db = app.db;
  app.addHook('preHandler', requireAuth);

  // Newest first. Pass `nextBefore` back as ?before= to load the next older page.
  app.get('/', async (req) => {
    const q = parse(listQuerySchema, req.query);
    const page = await listForUser(db, req.user!.id, {
      limit: q.limit,
      ...(q.before !== undefined ? { before: q.before } : {}),
      ...(q.category ? { category: q.category } : {}),
      ...(q.unread === 'true' ? { unreadOnly: true } : {}),
    });
    const items = page.notifications;
    return {
      notifications: items.map(serializeNotification),
      hasMore: page.hasMore,
      nextBefore: page.hasMore ? items[items.length - 1]!.seq : null,
      ...(await unreadCounts(db, req.user!.id)),
    };
  });

  app.get('/unread-count', async (req) => unreadCounts(db, req.user!.id));

  // Registered before '/:id/read' for clarity; the routes cannot clash (different shapes).
  app.post('/read-all', async (req) => {
    const { category } = parse(readAllSchema, req.body ?? {});
    const updated = await markAllRead(db, req.user!.id, app.now(), category);
    return { updated, ...(await unreadCounts(db, req.user!.id)) };
  });

  app.post('/:id/read', async (req) => {
    const id = idSchema.safeParse((req.params as { id: string }).id);
    // Someone else's notification looks exactly like one that does not exist.
    const n = id.success ? await markRead(db, req.user!.id, id.data, app.now()) : undefined;
    if (!n) throw notFound('Notification not found');
    return { notification: serializeNotification(n), ...(await unreadCounts(db, req.user!.id)) };
  });
};
export default notificationRoutes;

/** Administrator tools: announcements, and a manual trigger for the subscription notice sweep. Mounted at /api/admin. */
export const adminNotificationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireRole('admin'));

  app.post('/announcements', async (req, reply) => {
    const input = parse(announcementSchema, req.body);
    const result = await app.notifications.announce(req.user!.id, input);
    return reply.code(result.created ? 201 : 200).send({ announcement: serializeAnnouncement(result.announcement), recipients: result.recipients });
  });

  app.get('/announcements', async () => ({ announcements: (await listAnnouncements(app.db, 50)).map(serializeAnnouncement) }));

  // For operators who run the sweep from an external scheduler instead of (or as well as) the built-in timer. Idempotent.
  app.post('/notifications/sweep', async () => app.notifications.sweepSubscriptions());
};
