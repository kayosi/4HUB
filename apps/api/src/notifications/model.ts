export const CATEGORIES = ['signal', 'subscription', 'payment', 'community', 'announcement'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface NotificationRow {
  id: string;
  seq: number;
  user_id: string;
  category: Category;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  dedupe_key: string | null;
  created_at: Date;
  read_at: Date | null;
}

export interface NewNotification {
  userId: string;
  category: Category;
  type: string;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  /** Same event => same key => at most one notification per user. */
  dedupeKey?: string;
}

/** Content shared by everyone in an audience (the recipient is added per row). */
export type NotificationContent = Omit<NewNotification, 'userId' | 'dedupeKey'>;

export interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  important: boolean;
  created_by: string;
  client_id: string | null;
  recipient_count: number;
  created_at: Date;
}

/** The member's choices, from users.notification_prefs. */
export type PrefKey = 'newSignals' | 'signalUpdates' | 'announcements';
