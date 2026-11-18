/** Account roles. Premium is NOT a role: it comes from the subscription (`user.access.premium`). */
export type Role = 'free' | 'moderator' | 'admin';

/** Moderators and admins manage community rooms. UX only; the API enforces it. */
export const isStaff = (role: Role): boolean => role === 'moderator' || role === 'admin';
