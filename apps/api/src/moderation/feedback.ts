import { AppError } from '../errors.js';
import type { RestrictionRow } from './model.js';

/** The part of a restriction the affected person is allowed (and needs) to see. Never includes who applied it. */
export const restrictionDetails = (r: RestrictionRow) => ({ type: r.type, reason: r.reason, expiresAt: r.expires_at });

const until = (d: Date | null) => (d ? ` until ${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : '');

/** Plain-language feedback so the person knows what happened, why, and for how long. */
export const suspendedError = (r: RestrictionRow) =>
  new AppError(403, 'ACCOUNT_SUSPENDED', `Your account is suspended${until(r.expires_at)}. Reason: ${r.reason}`, restrictionDetails(r));

export const mutedError = (r: RestrictionRow) =>
  new AppError(403, 'ACCOUNT_RESTRICTED', `You cannot post messages${until(r.expires_at)}. Reason: ${r.reason}`, restrictionDetails(r));

/** For administrators, who need to see and lift restrictions. */
export const restrictionSummary = (r: RestrictionRow) => ({ id: r.id, type: r.type, reason: r.reason, createdAt: r.created_at, expiresAt: r.expires_at });
