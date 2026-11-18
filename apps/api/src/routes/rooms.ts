import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { requireRole } from '../plugins/auth.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { parse } from '../lib/validate.js';
import { isStaff } from '../auth/roles.js';
import { withTransaction } from '../db/index.js';
import { audit } from '../billing/repo.js';
import { getRoomById, getRoomBySlug, insertRoom, listRooms, setRoomArchived, updateRoom, type RoomPatch } from '../rooms/repo.js';
import type { RoomRow } from '../rooms/model.js';
import {
  assertRoomInvariant, createRoomSchema, idSchema, publicListQuerySchema, slugSchema, slugify, staffListQuerySchema, updateRoomSchema,
} from '../rooms/schemas.js';
import { canEnterRoom, serializeRoomDetail, serializeRoomStaff, serializeRoomSummary } from '../rooms/serialize.js';

const pgCode = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;
const slugTaken = () => conflict('A room with this URL name already exists');

/** Member-facing rooms: browse the lobby, open a room. Premium rooms are enforced here, on the server. */
const roomRoutes: FastifyPluginAsync = async (app) => {
  const db = app.db;

  // Public lobby. Visitors and free members see premium rooms as locked entries (public metadata only).
  app.get('/', async (req) => {
    const q = parse(publicListQuerySchema, req.query);
    const rows = await listRooms(db, { status: 'active', ...(q.category ? { category: q.category } : {}) });
    return { rooms: rows.map((r) => serializeRoomSummary(r, req.user)) };
  });

  app.get('/:slug', async (req) => {
    const parsed = slugSchema.safeParse((req.params as { slug: string }).slug);
    const room = parsed.success ? await getRoomBySlug(db, parsed.data) : undefined;
    // Archived rooms do not exist for anyone but staff.
    if (!room || (room.archived_at !== null && !(req.user && isStaff(req.user.role)))) throw notFound('Room not found');

    if (!canEnterRoom(room, req.user)) {
      const details = { room: serializeRoomSummary(room, req.user) };
      if (!req.user) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to access this room.', details);
      throw new AppError(403, 'PREMIUM_REQUIRED', 'This is a premium room. Upgrade to join.', details);
    }
    return { room: serializeRoomDetail(room, req.user) };
  });
};
export default roomRoutes;

/** Staff management (moderators and admins): create, edit, archive and restore rooms. */
export const staffRoomRoutes: FastifyPluginAsync = async (app) => {
  const db = app.db;
  app.addHook('preHandler', requireRole('moderator', 'admin'));

  const toId = (v: unknown): string => {
    const r = idSchema.safeParse(v);
    if (!r.success) throw notFound('Room not found');
    return r.data;
  };
  const load = async (v: unknown): Promise<RoomRow> => {
    const room = await getRoomById(db, toId(v));
    if (!room) throw notFound('Room not found');
    return room;
  };
  const view = (req: FastifyRequest, r: RoomRow) => serializeRoomStaff(r, req.user);
  /** The DB constraints are the backstop for concurrent writes; surface them as client errors, not 500s. */
  const mapDbError = (e: unknown): never => {
    if (pgCode(e) === '23505') throw slugTaken();
    if (pgCode(e) === '23514') throw badRequest('Validation failed', { access: 'Premium community rooms must use premium access' });
    throw e;
  };

  app.get('/', async (req) => {
    const q = parse(staffListQuerySchema, req.query);
    return { rooms: (await listRooms(db, { status: q.status })).map((r) => view(req, r)) };
  });

  app.get('/:id', async (req) => ({ room: view(req, await load((req.params as { id: string }).id)) }));

  app.post('/', async (req, reply) => {
    const body = parse(createRoomSchema, req.body);
    const access = body.access ?? (body.category === 'premium_community' ? 'premium' : 'public');
    assertRoomInvariant(body.category, access);
    const slug = body.slug ?? slugify(body.name);
    if (slug.length < 3) throw badRequest('Validation failed', { slug: 'Could not derive a URL name from the room name; enter one' });
    if (await getRoomBySlug(db, slug)) throw slugTaken();

    const actor = req.user!;
    try {
      const room = await withTransaction(db, async (tx) => {
        const created = await insertRoom(tx, { ...body, slug, access, createdBy: actor.id, now: app.now() });
        await audit(tx, { actorId: actor.id, action: 'room.created', entityType: 'community_room', entityId: created.id, data: { slug, category: body.category, access } });
        return created;
      });
      return reply.code(201).send({ room: view(req, room) });
    } catch (e) {
      return mapDbError(e);
    }
  });

  app.patch('/:id', async (req) => {
    const current = await load((req.params as { id: string }).id);
    const patch: RoomPatch = parse(updateRoomSchema, req.body);

    // Only real changes are written and audited.
    const changed = (Object.keys(patch) as (keyof RoomPatch)[]).filter((k) => {
      const column = k === 'sortOrder' ? 'sort_order' : k;
      return patch[k] !== current[column];
    });
    if (changed.length === 0) return { room: view(req, current) };

    assertRoomInvariant(patch.category ?? current.category, patch.access ?? current.access);
    const actor = req.user!;
    try {
      const room = await withTransaction(db, async (tx) => {
        const updated = await updateRoom(tx, current.id, patch, actor.id, app.now());
        if (!updated) throw notFound('Room not found');
        await audit(tx, {
          actorId: actor.id, action: 'room.updated', entityType: 'community_room', entityId: current.id,
          data: { changed, from: { category: current.category, access: current.access }, to: { category: updated.category, access: updated.access } },
        });
        return updated;
      });
      return { room: view(req, room) };
    } catch (e) {
      return mapDbError(e);
    }
  });

  // Archiving hides a room from members without deleting it; both directions are idempotent.
  const setArchived = (archived: boolean) => async (req: FastifyRequest) => {
    const current = await load((req.params as { id: string }).id);
    if ((current.archived_at !== null) === archived) return { room: view(req, current) };
    const actor = req.user!;
    const room = await withTransaction(db, async (tx) => {
      const updated = await setRoomArchived(tx, current.id, archived, actor.id, app.now());
      if (!updated) throw notFound('Room not found');
      await audit(tx, { actorId: actor.id, action: archived ? 'room.archived' : 'room.restored', entityType: 'community_room', entityId: current.id, data: { slug: current.slug } });
      return updated;
    });
    return { room: view(req, room) };
  };
  app.post('/:id/archive', setArchived(true));
  app.post('/:id/restore', setArchived(false));
};
