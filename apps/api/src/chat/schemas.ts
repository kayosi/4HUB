import { z } from 'zod';
import { hasNoControlChars } from '../lib/text.js';
import { MAX_MESSAGE_CHARS } from './model.js';
import { sanitizeMessageBody, withinLimit } from './sanitize.js';

/** Raw cap first, so absurdly large strings are rejected before any processing; the real limit applies after cleaning. */
const body = z
  .string()
  .max(MAX_MESSAGE_CHARS * 4, 'Message is too long')
  .refine((s) => hasNoControlChars(s, true), 'Message contains unsupported characters')
  .transform(sanitizeMessageBody)
  .pipe(z.string().min(1, 'Message cannot be empty').refine(withinLimit, `Message must be at most ${MAX_MESSAGE_CHARS} characters`));

/** Strict: the author is always the signed-in user, so userId/author/seq/createdAt in a payload are rejected, not ignored. */
export const createMessageSchema = z.strictObject({ body, clientId: z.string().uuid().optional() });
export const updateMessageSchema = z.strictObject({ body });
export const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.coerce.number().int().positive().optional(),
});
export const messageIdSchema = z.string().uuid();
