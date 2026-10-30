import fp from 'fastify-plugin';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { findUserBySession } from '../db/repos.js';
import { hashToken } from '../auth/tokens.js';
import { AppError, forbidden, unauthenticated } from '../errors.js';
import type { Role } from '../auth/roles.js';
import { can } from '../auth/access.js';
import type { Capability } from '../billing/tiers.js';

export const SESSION_COOKIE = '4hub_session';

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
      req.user = { ...user, entitlement: await app.billing.entitlementFor(user.id) };
      req.sessionTokenHash = tokenHash;
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
