import type { ZodType, z } from 'zod';
import { badRequest } from '../errors.js';

export function parse<T extends ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const fields = Object.fromEntries(result.error.issues.map((i) => [i.path.join('.') || '_', i.message]));
    throw badRequest('Validation failed', fields);
  }
  return result.data;
}
