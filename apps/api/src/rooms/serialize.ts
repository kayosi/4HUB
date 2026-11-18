import { can, type AuthUser } from '../auth/access.js';
import type { RoomAccess, RoomCategory, RoomRow } from './model.js';

type Viewer = Pick<AuthUser, 'role' | 'entitlement'> | null;

/** The one place that decides whether a viewer may enter a room; premium rooms defer to the central can(). */
export const canEnterRoom = (room: Pick<RoomRow, 'access'>, viewer: Viewer): boolean =>
  room.access === 'public' || can(viewer, 'premium_community');

export interface RoomSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: RoomCategory;
  access: RoomAccess;
  /** True when the viewer may see this room in the list but not enter it. */
  locked: boolean;
}

/**
 * Whitelist of what is public about a room. Used for listings and for access-denied details, so a viewer who cannot
 * enter a premium room learns only what the listing already shows (never guidelines or other member-only content).
 */
export const serializeRoomSummary = (r: RoomRow, viewer: Viewer): RoomSummary => ({
  id: r.id, slug: r.slug, name: r.name, description: r.description, category: r.category, access: r.access, locked: !canEnterRoom(r, viewer),
});

/** Full room content. Callers must have verified canEnterRoom() first. */
export const serializeRoomDetail = (r: RoomRow, viewer: Viewer) => ({
  ...serializeRoomSummary(r, viewer),
  guidelines: r.guidelines,
  /** Only staff can ever load an archived room, so this reveals nothing to members; it lets the chat show a read-only notice. */
  archived: r.archived_at !== null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Management view for staff: detail plus lifecycle fields. */
export const serializeRoomStaff = (r: RoomRow, viewer: Viewer) => ({
  ...serializeRoomDetail(r, viewer),
  sortOrder: r.sort_order,
  archivedAt: r.archived_at,
});
