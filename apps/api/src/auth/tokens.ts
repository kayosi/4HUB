import { createHash, randomBytes } from 'node:crypto';

export const newToken = (): string => randomBytes(32).toString('base64url');
/** Only the hash is stored, so a database leak does not expose usable tokens. */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
