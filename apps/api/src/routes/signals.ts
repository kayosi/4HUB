import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../plugins/auth.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { parse } from '../lib/validate.js';
import { isStaff } from '../auth/roles.js';
import type { AuthUser } from '../auth/access.js';
import {
  addBookmark, addComment, clearReaction, getComment, getSignal, getImage, listAssets, listComments,
  listSignals, loadStats, removeBookmark, setReaction, softDeleteComment,
} from '../signals/repo.js';
import { canViewFull } from '../signals/serialize.js';
import { presentDetail, presentList } from '../signals/present.js';
import { commentSchema, feedQuerySchema, idSchema, pageSchema, reactionSchema } from '../signals/schemas.js';
import type { SignalRow } from '../signals/model.js';

const premiumRequired = () => new AppError(403, 'PREMIUM_REQUIRED', 'This is a premium signal. Upgrade to access it.');
const toId = (v: unknown): string => {
  const r = idSchema.safeParse(v);
  if (!r.success) throw notFound('Signal not found');
  return r.data;
};

const signalRoutes: FastifyPluginAsync = async (app) => {
  const db = app.db;

  async function load(id: unknown): Promise<SignalRow> {
    const s = await getSignal(db, toId(id));
    if (!s) throw notFound('Signal not found');
    return s;
  }
  /** Loads a signal and requires the caller to be allowed to see its full content. */
  async function loadAuthorized(req: { user: AuthUser | null }, id: unknown) {
    const s = await load(id);
    if (!canViewFull(s, req.user)) throw premiumRequired();
    return s;
  }

  // Public: visitors and free members receive teasers for premium signals (see serializeSignal).
  app.get('/', async (req) => {
    const q = parse(feedQuerySchema, req.query);
    const rows = await listSignals(db, q, q.limit + 1, q.offset);
    const hasMore = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    return { signals: await presentList(db, page, req.user), hasMore, limit: q.limit, offset: q.offset };
  });

  app.get('/assets', async () => ({ assets: await listAssets(db) }));

  app.get('/:id', async (req) => presentDetail(db, await load((req.params as { id: string }).id), req.user, { countView: true }));

  // Chart screenshots: authorization is checked on every request. The signal check comes first so a
  // free user learns nothing about whether a premium image id exists.
  app.get('/:id/images/:imageId', async (req, reply) => {
    const { id, imageId } = req.params as { id: string; imageId: string };
    const s = await loadAuthorized(req, id);
    const parsed = idSchema.safeParse(imageId);
    const img = parsed.success ? await getImage(db, s.id, parsed.data) : undefined;
    if (!img) throw notFound('Image not found');
    const data = await app.storage.get(img.storage_key);
    return reply
      .header('Content-Type', img.content_type)
      .header('Content-Disposition', 'inline')
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(data);
  });

  // ---- reactions ----
  app.put('/:id/reaction', { preHandler: requireAuth }, async (req) => {
    const s = await loadAuthorized(req, (req.params as { id: string }).id);
    const { type } = parse(reactionSchema, req.body);
    await setReaction(db, s.id, req.user!.id, type);
    return { reaction: type, stats: (await loadStats(db, [s.id])).get(s.id) };
  });
  app.delete('/:id/reaction', { preHandler: requireAuth }, async (req) => {
    const s = await loadAuthorized(req, (req.params as { id: string }).id);
    await clearReaction(db, s.id, req.user!.id);
    return { reaction: null, stats: (await loadStats(db, [s.id])).get(s.id) };
  });

  // ---- bookmarks ----
  app.put('/:id/bookmark', { preHandler: requireAuth }, async (req) => {
    const s = await loadAuthorized(req, (req.params as { id: string }).id); // can't save what you can't see
    await addBookmark(db, s.id, req.user!.id);
    return { bookmarked: true };
  });
  // Removal is always allowed, e.g. after a premium membership lapses.
  app.delete('/:id/bookmark', { preHandler: requireAuth }, async (req) => {
    const s = await load((req.params as { id: string }).id);
    await removeBookmark(db, s.id, req.user!.id);
    return { bookmarked: false };
  });

  // ---- comments ----
  app.get('/:id/comments', async (req) => {
    const s = await loadAuthorized(req, (req.params as { id: string }).id);
    const q = parse(pageSchema, req.query);
    const rows = await listComments(db, s.id, q.limit, q.offset);
    return {
      comments: rows.map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: c.created_at,
        // Only display name + a staff badge are exposed: no email, no user id.
        author: { displayName: c.display_name, badge: c.role === 'admin' || c.role === 'moderator' ? c.role : null },
        mine: req.user?.id === c.user_id,
      })),
    };
  });

  app.post(
    '/:id/comments',
    { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const s = await loadAuthorized(req, (req.params as { id: string }).id);
      const { body } = parse(commentSchema, req.body);
      const id = await addComment(db, s.id, req.user!.id, body);
      return reply.code(201).send({ id });
    },
  );
};

/** Comment moderation: authors can delete their own; moderators/admins can delete any. Soft delete keeps an audit trail. */
export const commentRoutes: FastifyPluginAsync = async (app) => {
  app.delete('/:commentId', { preHandler: requireAuth }, async (req, reply) => {
    const r = idSchema.safeParse((req.params as { commentId: string }).commentId);
    const c = r.success ? await getComment(app.db, r.data) : undefined;
    if (!c || c.deleted_at) throw notFound('Comment not found');
    if (c.user_id !== req.user!.id && !isStaff(req.user!.role)) throw forbidden();
    await softDeleteComment(app.db, c.id, req.user!.id);
    return reply.code(204).send();
  });
};

export default signalRoutes;
