import fp from 'fastify-plugin';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { findUserBySession } from '../db/repos.js';
import { hashToken } from '../auth/tokens.js';
import { forbidden, unauthenticated } from '../errors.js';
import type { Role } from '../auth/roles.js';

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
      req.user = user;
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
