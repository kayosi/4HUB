import type { Role } from '../auth/roles.js';

export const MAX_MESSAGE_CHARS = 2000;

export interface MessageRow {
  id: string;
  seq: number;
  room_id: string;
  author_id: string;
  client_id: string | null;
  body: string;
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
  deleted_by: string | null;
  hidden_at: Date | null;
  moderation_reason: string | null;
  author_name: string;
  author_role: Role;
}
