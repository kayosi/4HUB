import { isStaff, type Role } from '../auth/roles.js';
import type { MessageRow } from './model.js';

export interface ChatMessage {
  id: string;
  seq: number;
  roomId: string;
  author: { id: string; displayName: string; isStaff: boolean };
  /** null when the message is deleted, hidden or removed: that content is never sent to the chat. */
  body: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deleted: boolean;
  /**
   * Set when a moderator hid (reversible) or removed (permanent) the message. `reason` is only filled in for the message's
   * author and for staff; live events are sent to everyone, so they never carry it.
   */
  moderation: { state: 'hidden' | 'removed'; reason: string | null } | null;
}

export type Viewer = { id: string; role: Role } | null | undefined;

/** Whitelist: no email, client id or moderator identity ever leaves the server. */
export function serializeMessage(m: MessageRow, viewer?: Viewer): ChatMessage {
  // A deletion by someone other than the author is a moderator removal (the author deleting their own message is not).
  const removed = m.deleted_at !== null && m.deleted_by !== null && m.deleted_by !== m.author_id;
  const state = removed ? 'removed' : m.deleted_at === null && m.hidden_at !== null ? 'hidden' : null;
  const mayRead = !!viewer && (viewer.id === m.author_id || isStaff(viewer.role));
  return {
    id: m.id,
    seq: m.seq,
    roomId: m.room_id,
    author: { id: m.author_id, displayName: m.author_name, isStaff: isStaff(m.author_role) },
    body: m.deleted_at || m.hidden_at ? null : m.body,
    createdAt: m.created_at,
    editedAt: m.edited_at,
    deleted: m.deleted_at !== null,
    moderation: state ? { state, reason: mayRead ? m.moderation_reason : null } : null,
  };
}
