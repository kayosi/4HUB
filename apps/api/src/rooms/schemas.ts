import { z } from 'zod';
import { badRequest } from '../errors.js';
import { ROOM_ACCESS, ROOM_CATEGORIES, type RoomAccess, type RoomCategory } from './model.js';

/** True if the text has no control characters. `allowLayout` permits tab and line breaks (multi-line text). */
const clean = (allowLayout: boolean) => (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const layout = c === 9 || c === 10 || c === 13;
    if ((c < 32 && !(allowLayout && layout)) || c === 127) return false;
  }
  return true;
};
const CONTROL_MSG = 'Must not contain control characters';

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens');

const fields = {
  name: z.string().trim().min(3, 'At least 3 characters').max(80).refine(clean(false), CONTROL_MSG),
  description: z.string().trim().min(1, 'Required').max(300).refine(clean(false), CONTROL_MSG),
  guidelines: z.string().trim().max(2000).refine(clean(true), CONTROL_MSG),
  category: z.enum(ROOM_CATEGORIES),
  access: z.enum(ROOM_ACCESS),
  sortOrder: z.number().int().min(0).max(1000),
};

/** Strict: unknown keys (archivedAt, createdBy, id, ...) are rejected rather than silently ignored. */
export const createRoomSchema = z.strictObject({
  name: fields.name,
  slug: slugSchema.optional(),
  description: fields.description,
  guidelines: fields.guidelines.default(''),
  category: fields.category,
  access: fields.access.optional(),
  sortOrder: fields.sortOrder.default(0),
});

/** The slug is deliberately not editable: changing it would break links. */
export const updateRoomSchema = z
  .strictObject({
    name: fields.name,
    description: fields.description,
    guidelines: fields.guidelines,
    category: fields.category,
    access: fields.access,
    sortOrder: fields.sortOrder,
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, { message: 'Provide at least one field to change' });

export const staffListQuerySchema = z.object({ status: z.enum(['active', 'archived', 'all']).default('all') });
export const publicListQuerySchema = z.object({ category: z.enum(ROOM_CATEGORIES).optional() });
export const idSchema = z.string().uuid();

/** A "Premium community" room is always premium. Checked on the final (merged) values for both create and edit. */
export function assertRoomInvariant(category: RoomCategory, access: RoomAccess): void {
  if (category === 'premium_community' && access !== 'premium') {
    throw badRequest('Validation failed', { access: 'Premium community rooms must use premium access' });
  }
}

/** Derives a URL name from the room name (ASCII only). Returns '' if nothing usable remains. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}
