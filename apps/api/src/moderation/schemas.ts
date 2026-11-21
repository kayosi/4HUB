import { z } from 'zod';
import { hasNoControlChars } from '../lib/text.js';
import { sanitizeMessageBody } from '../chat/sanitize.js';
import { REPORT_REASONS, RESTRICTION_TYPES } from './model.js';

/** Trimmed, control-character-free, invisible-character-stripped text within [min, max] characters (code points). */
export const text = (min: number, max: number, multiline = false) =>
  z
    .string()
    .max(max * 4, 'Too long')
    .refine((s) => hasNoControlChars(s, multiline), 'Contains unsupported characters')
    .transform(sanitizeMessageBody)
    .pipe(z.string().refine((s) => Array.from(s).length >= min, min === 1 ? 'Required' : `At least ${min} characters`).refine((s) => Array.from(s).length <= max, `At most ${max} characters`));

/** Strict everywhere: status, reporter, resolver and similar fields can never be supplied by a client. */
export const reportSchema = z
  .strictObject({ reason: z.enum(REPORT_REASONS), details: text(0, 500, true).optional() })
  .transform((v) => ({ reason: v.reason, details: v.details ?? '' }))
  .refine((v) => v.reason !== 'other' || v.details.length >= 5, { path: ['details'], message: 'Please describe the problem (at least 5 characters)' });

/** Shown to the author of the message, so it must be a real explanation. */
export const moderateSchema = z.strictObject({ reason: text(3, 200) });
export const closeReportSchema = z.strictObject({ note: text(0, 500, true).optional() });
export const restrictSchema = z.strictObject({
  type: z.enum(RESTRICTION_TYPES),
  reason: text(3, 300),
  /** Omit for "until an administrator lifts it". */
  durationHours: z.number().int().min(1).max(8760).optional(),
});
export const liftSchema = z.strictObject({ note: text(0, 300).optional() });
export const queueQuerySchema = z.object({
  status: z.enum(['open', 'resolved', 'dismissed', 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export const uuidSchema = z.string().uuid();
