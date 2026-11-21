import { z } from 'zod';
import { text } from '../moderation/schemas.js';
import { CATEGORIES } from './model.js';

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.coerce.number().int().positive().optional(),
  category: z.enum(CATEGORIES).optional(),
  unread: z.enum(['true', 'false']).optional(),
});
export const readAllSchema = z.strictObject({ category: z.enum(CATEGORIES).optional() });
export const idSchema = z.string().uuid();

/** Strict: the author, recipients and counts are never taken from the client. */
export const announcementSchema = z.strictObject({
  title: text(3, 120),
  body: text(1, 1000, true),
  important: z.boolean().default(false),
  /** Optional idempotency key so a double click does not announce twice. */
  clientId: z.string().uuid().optional(),
});
