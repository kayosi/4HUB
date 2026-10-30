/**
 * Account roles. NOTE: premium is NOT a role. It is derived from an active subscription
 * (see auth/access.ts and billing/subscriptions.ts), so access always follows billing state.
 */
export const ROLES = ['free', 'moderator', 'admin'] as const;
/** "Visitor" is any unauthenticated request; it is not stored in the database. */
export type Role = (typeof ROLES)[number];
export type Actor = Role | 'visitor';

export const STAFF_ROLES: readonly Role[] = ['moderator', 'admin'];
export const isStaff = (role: Role): boolean => STAFF_ROLES.includes(role);
