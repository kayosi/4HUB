import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, notFound, unauthenticated } from '../errors.js';
import { isStaff } from '../auth/roles.js';
import { getRoomBySlug } from '../rooms/repo.js';
import type { RoomRow } from '../rooms/model.js';
import { slugSchema } from '../rooms/schemas.js';
import { canEnterRoom } from '../rooms/serialize.js';
import { mutedError } from '../moderation/feedback.js';

/**
 * 'read'   - history, live stream, reporting
 * 'write'  - sending and editing: also refused for muted accounts
 * 'delete' - deleting: like write, but a muted member may still remove their own words
 */
export type RoomMode = 'read' | 'write' | 'delete';

/**
 * The ONE access check for everything that touches a room's messages. Reuses the room rules from Prompt 4A (canEnterRoom, which
 * defers to the central can()), so a lapsed subscription closes chat exactly like it closes the room page.
 * Messaging requires a signed-in user even in public rooms. (Suspended accounts never get this far: the auth plugin refuses them.)
 */
export async function authorizeRoom(app: FastifyInstance, req: FastifyRequest, slugParam: unknown, mode: RoomMode): Promise<RoomRow> {
  if (!req.user) throw unauthenticated();
  const slug = slugSchema.safeParse(slugParam);
  const room = slug.success ? await getRoomBySlug(app.db, slug.data) : undefined;
  if (!room || (room.archived_at !== null && !isStaff(req.user.role))) throw notFound('Room not found');
  if (!canEnterRoom(room, req.user)) throw new AppError(403, 'PREMIUM_REQUIRED', 'This is a premium room. Upgrade to join.');
  if (mode !== 'read' && room.archived_at !== null) throw new AppError(409, 'ROOM_ARCHIVED', 'This room is archived and read-only.');
  if (mode === 'write' && req.user.restrictions.muted) throw mutedError(req.user.restrictions.muted);
  return room;
}
