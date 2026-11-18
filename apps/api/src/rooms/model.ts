export const ROOM_CATEGORIES = ['general_discussion', 'trading_discussion', 'market_analysis', 'premium_community'] as const;
export type RoomCategory = (typeof ROOM_CATEGORIES)[number];

/** `premium` rooms require the premium_community capability (auth/access.ts `can`). */
export const ROOM_ACCESS = ['public', 'premium'] as const;
export type RoomAccess = (typeof ROOM_ACCESS)[number];

export interface RoomRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  guidelines: string;
  category: RoomCategory;
  access: RoomAccess;
  sort_order: number;
  created_by: string;
  updated_by: string | null;
  archived_by: string | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}
