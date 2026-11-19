import fp from 'fastify-plugin';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { findUserBySession } from '../db/repos.js';
import { hashToken } from '../auth/tokens.js';
import { AppError, forbidden, unauthenticated } from '../errors.js';
import type { Role } from '../auth/roles.js';
import { can } from '../auth/access.js';
import type { Capability } from '../billing/tiers.js';
import { getActiveRestrictions } from '../moderation/repo.js';
import { suspendedError } from '../moderation/feedback.js';

export const SESSION_COOKIE = '4hub_session';

/** A suspended account may still sign out (and sign in as someone else); everything else is refused with the reason. */
const SUSPENDED_ALLOWED = new Set(['/api/auth/logout', '/api/auth/login']);

export default fp(async (app) => {
  app.decorateRequest('user', null);
  app.decorateRequest('sessionTokenHash', null);

  // Resolve the session (if any) for every request; routes decide whether it is required.
  app.addHook('onRequest', async (req) => {
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return;
    const tokenHash = hashToken(raw);
    const user = await findUserBySession(app.db, tokenHash);
    if (user) {
      // Premium is resolved from the subscription state on EVERY request, so access follows billing immediately.
      const restrictions = await getActiveRestrictions(app.db, user.id, app.now());
      req.user = { ...user, entitlement: await app.billing.entitlementFor(user.id), restrictions };
      req.sessionTokenHash = tokenHash;
      // Enforced here, once, for every route, so no endpoint (including ones that merely read req.user) can forget it.
      // Restrictions are checked per request, so lifting or expiry takes effect immediately.
      if (restrictions.suspended && !SUSPENDED_ALLOWED.has(req.url.split('?')[0]!)) throw suspendedError(restrictions.suspended);
    }
  });
});

export const requireAuth: preHandlerAsyncHookHandler = async (req: FastifyRequest) => {
  if (!req.user) throw unauthenticated();
};

/** Server-side authorization: allow only the listed roles. */
export const requireRole =
  (...roles: Role[]): preHandlerAsyncHookHandler =>
  async (req) => {
    if (!req.user) throw unauthenticated();
    if (!roles.includes(req.user.role)) throw forbidden();
  };

/** Route guard for paid features. Uses the same `can()` as signal serialization: one rule, one place. */
export const requireCapability =
  (capability: Capability): preHandlerAsyncHookHandler =>
  async (req) => {
    if (!req.user) throw unauthenticated();
    if (!can(req.user, capability)) throw new AppError(403, 'PREMIUM_REQUIRED', 'This requires an active premium subscription.');
  };
