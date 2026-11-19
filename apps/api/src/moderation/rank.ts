import type { Role } from '../auth/roles.js';
import { isStaff } from '../auth/roles.js';

/**
 * Who may act on whom. Staff never moderate peers or superiors, and nobody moderates themselves, so a single compromised or
 * rogue moderator cannot silence the people who oversee them.
 *   - moderators act on ordinary members only
 *   - administrators act on moderators and members, never on other administrators
 */
export const canModerateContentOf = (actor: Role, author: Role): boolean =>
  actor === 'admin' ? author !== 'admin' : actor === 'moderator' ? !isStaff(author) : false;

/** Closing a report is a record-keeping decision, so an administrator may also close reports about another administrator. */
export const canCloseReportAbout = (actor: Role, subject: Role): boolean =>
  actor === 'admin' || (actor === 'moderator' && !isStaff(subject));

/** Restrictions are an administrator power, and administrators are never restricted. */
export const canRestrict = (actor: Role, target: Role): boolean => actor === 'admin' && target !== 'admin';
