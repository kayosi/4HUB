import { ApiError } from './api';

export type RoomCategory = 'general_discussion' | 'trading_discussion' | 'market_analysis' | 'premium_community';
export type RoomAccess = 'public' | 'premium';

export interface RoomSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: RoomCategory;
  access: RoomAccess;
  /** Visible in the lobby but the viewer may not enter (premium room without access). */
  locked: boolean;
}
export interface RoomDetail extends RoomSummary { guidelines: string; archived: boolean; createdAt: string; updatedAt: string }
export interface StaffRoom extends RoomDetail { sortOrder: number; archivedAt: string | null }

export const CATEGORIES: { id: RoomCategory; label: string; blurb: string }[] = [
  { id: 'general_discussion', label: 'General discussion', blurb: 'Introductions, questions and everything trading-adjacent.' },
  { id: 'trading_discussion', label: 'Trading discussion', blurb: 'Strategies, psychology and trade management.' },
  { id: 'market_analysis', label: 'Market analysis', blurb: 'Charts, levels and market views.' },
  { id: 'premium_community', label: 'Premium community', blurb: 'Members-only rooms for premium subscribers.' },
];
export const categoryLabel = (c: RoomCategory) => CATEGORIES.find((x) => x.id === c)?.label ?? c;

/** The server attaches the (public-only) room summary to 401/403 responses so the UI can name what is locked. */
export function lockedRoomFrom(e: unknown): RoomSummary | null {
  if (!(e instanceof ApiError)) return null;
  const room = (e.details as unknown as { room?: RoomSummary } | undefined)?.room;
  return room && typeof room.name === 'string' ? room : null;
}
