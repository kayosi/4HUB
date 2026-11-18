import { isStaff } from '../auth/roles.js';
import type { MessageRow } from './model.js';

export interface ChatMessage {
  id: string;
  seq: number;
  roomId: string;
  author: { id: string; displayName: string; isStaff: boolean };
  /** null for deleted messages: the content is gone, not merely hidden. */
  body: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deleted: boolean;
}

/** Whitelist: no email, client id or deleter identity ever leaves the server. */
export const serializeMessage = (m: MessageRow): ChatMessage => ({
  id: m.id,
  seq: m.seq,
  roomId: m.room_id,
  author: { id: m.author_id, displayName: m.author_name, isStaff: isStaff(m.author_role) },
  body: m.deleted_at ? null : m.body,
  createdAt: m.created_at,
  editedAt: m.edited_at,
  deleted: m.deleted_at !== null,
});
