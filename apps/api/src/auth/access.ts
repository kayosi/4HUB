import type { UserRow } from '../db/repos.js';
import type { Capability } from '../billing/tiers.js';
import type { Entitlement } from '../billing/subscriptions.js';
import { isStaff } from './roles.js';

/** A signed-in user plus what their subscription currently entitles them to (resolved per request). */
export type AuthUser = UserRow & { entitlement: Entitlement };

/** Staff may moderate/manage content, so they can see all premium content. They do not get product tiers. */
const STAFF_CAPABILITIES: readonly Capability[] = ['premium_signals', 'premium_community'];

/**
 * The single authorization check for paid content. Signals, comments, images, bookmarks and route guards all
 * call this, so there is exactly one definition of "who may see premium material".
 */
export function can(user: Pick<AuthUser, 'role' | 'entitlement'> | null, capability: Capability): boolean {
  if (user === null) return false;
  if (isStaff(user.role) && STAFF_CAPABILITIES.includes(capability)) return true;
  return user.entitlement.capabilities.includes(capability);
}
