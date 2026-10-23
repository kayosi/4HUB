export const ROLES = ['free', 'premium', 'moderator', 'admin'] as const;
/** "Visitor" is any unauthenticated request; it is not stored in the database. */
export type Role = (typeof ROLES)[number];
export type Actor = Role | 'visitor';

export const PREMIUM_ACCESS_ROLES: readonly Role[] = ['premium', 'moderator', 'admin'];
export const STAFF_ROLES: readonly Role[] = ['moderator', 'admin'];

export const hasPremiumAccess = (role: Role): boolean => PREMIUM_ACCESS_ROLES.includes(role);
export const isStaff = (role: Role): boolean => STAFF_ROLES.includes(role);
