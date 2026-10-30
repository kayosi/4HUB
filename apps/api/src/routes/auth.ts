import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { hashPassword, verifyPassword, dummyHash } from '../auth/password.js';
import { hashToken, newToken } from '../auth/tokens.js';
import { SESSION_COOKIE, requireAuth } from '../plugins/auth.js';
import {
  consumeResetToken,
  createResetToken,
  createSession,
  createUser,
  deleteSession,
  deleteUserSessions,
  findUserByEmail,
  updatePassword,
  type UserRow,
} from '../db/repos.js';
import { withTransaction } from '../db/index.js';
import { AppError, conflict } from '../errors.js';
import { can } from '../auth/access.js';
import type { Entitlement } from '../billing/subscriptions.js';
import { parse } from '../lib/validate.js';

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(10, 'Password must be at least 10 characters').max(128);

const registerSchema = z.object({ email, password, displayName: z.string().trim().min(2).max(60) });
const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
const resetRequestSchema = z.object({ email });
const resetConfirmSchema = z.object({ token: z.string().min(20).max(200), password });

/** What a member may see about THEMSELVES. */
export const publicUser = (u: UserRow, entitlement: Entitlement) => ({
  id: u.id,
  email: u.email,
  displayName: u.display_name,
  role: u.role,
  createdAt: u.created_at,
  country: u.country,
  tradingExperience: u.trading_experience,
  preferredAssets: u.preferred_assets,
  notificationPrefs: u.notification_prefs,
  access: { tier: entitlement.tier, premium: can({ role: u.role, entitlement }, 'premium_signals') },
});

/** Minimal view for the admin user list: no profile details beyond what administration needs. */
export const adminUserView = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  displayName: u.display_name,
  role: u.role,
  createdAt: u.created_at,
});

const authRoutes: FastifyPluginAsync = async (app) => {
  const limit = { config: { rateLimit: { max: app.config.AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' } } };
  const ttlMs = app.config.SESSION_TTL_DAYS * 86_400_000;

  async function startSession(reply: FastifyReply, userId: string) {
    const token = newToken();
    await createSession(app.db, hashToken(token), userId, new Date(Date.now() + ttlMs));
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: app.config.NODE_ENV === 'production',
      path: '/',
      maxAge: ttlMs / 1000,
    });
  }
  const clearCookie = (reply: FastifyReply) => reply.clearCookie(SESSION_COOKIE, { path: '/' });

  app.post('/register', limit, async (req, reply) => {
    const body = parse(registerSchema, req.body);
    if (await findUserByEmail(app.db, body.email)) throw conflict('An account with this email already exists');
    // New accounts are always "free"; role changes are an admin-only operation.
    const user = await createUser(app.db, {
      email: body.email,
      displayName: body.displayName,
      passwordHash: await hashPassword(body.password),
    });
    await startSession(reply, user.id);
    return reply.code(201).send({ user: publicUser(user, await app.billing.entitlementFor(user.id)) });
  });

  app.post('/login', limit, async (req, reply) => {
    const body = parse(loginSchema, req.body);
    const found = await findUserByEmail(app.db, body.email);
    const ok = await verifyPassword(found?.password_hash ?? (await dummyHash()), body.password);
    if (!found || !ok) throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    await startSession(reply, found.id);
    return { user: publicUser(found, await app.billing.entitlementFor(found.id)) };
  });

  app.post('/logout', { preHandler: requireAuth }, async (req, reply) => {
    if (req.sessionTokenHash) await deleteSession(app.db, req.sessionTokenHash);
    clearCookie(reply);
    return reply.code(204).send();
  });

  // Always responds 202 so the endpoint cannot be used to discover registered emails.
  app.post('/password-reset/request', limit, async (req, reply) => {
    const body = parse(resetRequestSchema, req.body);
    const user = await findUserByEmail(app.db, body.email);
    if (user) {
      const token = newToken();
      const expires = new Date(Date.now() + app.config.PASSWORD_RESET_TTL_MINUTES * 60_000);
      await createResetToken(app.db, hashToken(token), user.id, expires);
      await app.mailer.sendPasswordReset(user.email, token);
    }
    return reply.code(202).send({ ok: true });
  });

  app.post('/password-reset/confirm', limit, async (req, reply) => {
    const body = parse(resetConfirmSchema, req.body);
    const passwordHash = await hashPassword(body.password);
    await withTransaction(app.db, async (client) => {
      const userId = await consumeResetToken(client, hashToken(body.token));
      if (!userId) throw new AppError(400, 'INVALID_TOKEN', 'This reset link is invalid or has expired');
      await updatePassword(client, userId, passwordHash);
      await deleteUserSessions(client, userId); // sign out everywhere
    });
    clearCookie(reply);
    return { ok: true };
  });
};

export default authRoutes;
