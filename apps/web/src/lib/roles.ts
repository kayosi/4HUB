export type Role = 'free' | 'premium' | 'moderator' | 'admin';
/** UX hint only. The API enforces every permission server-side. */
export const hasPremiumAccess = (r: Role) => r === 'premium' || r === 'moderator' || r === 'admin';
