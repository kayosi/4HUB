import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';
import { deleteOtherSessions, findUserById, updatePassword, updateProfile, type ProfilePatch } from '../db/repos.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { publicUser } from './auth.js';
import { parse } from '../lib/validate.js';
import { AppError, notFound } from '../errors.js';
import { assetSchema, pageSchema } from '../signals/schemas.js';
import { listBookmarkedSignals } from '../signals/repo.js';
import { presentList } from '../signals/present.js';


const emptyToNull = (v: string) => (v === '' ? null : v);

const profileSchema = z
  .object({
    displayName: z.string().trim().min(2).max(60),
    country: z.union([z.null(), z.string().trim().max(60).transform(emptyToNull)]),
    tradingExperience: z.enum(['beginner', 'intermediate', 'advanced', 'professional']).nullable(),
    preferredAssets: z.array(assetSchema).max(10).transform((a) => [...new Set(a)]),
    notificationPrefs: z.object({ newSignals: z.boolean(), signalUpdates: z.boolean(), announcements: z.boolean() }),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(10, 'Password must be at least 10 characters').max(128),
});

const meRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (req) => ({ user: publicUser(req.user!, req.user!.entitlement) }));

  // Only the fields below can be changed here: role and email are not accepted (unknown keys are dropped).
  app.patch('/', async (req) => {
    const body = parse(profileSchema, req.body) as ProfilePatch;
    const updated = await updateProfile(app.db, req.user!.id, body);
    if (!updated) throw notFound('User not found');
    return { user: publicUser(updated, req.user!.entitlement) };
  });

  app.post('/password', { config: { rateLimit: { max: app.config.AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(passwordSchema, req.body);
    const full = await findUserById(app.db, req.user!.id);
    // 400 rather than 401 so the web app does not mistake a typo for an expired session.
    if (!full || !(await verifyPassword(full.password_hash, body.currentPassword)))
      throw new AppError(400, 'INVALID_PASSWORD', 'Your current password is incorrect');
    await updatePassword(app.db, full.id, await hashPassword(body.newPassword));
    await deleteOtherSessions(app.db, full.id, req.sessionTokenHash); // sign out other devices
    return reply.code(200).send({ ok: true });
  });

  app.get('/bookmarks', async (req) => {
    const q = parse(pageSchema, req.query);
    const rows = await listBookmarkedSignals(app.db, req.user!.id, q.limit, q.offset);
    return { signals: await presentList(app.db, rows, req.user) };
  });
};

export default meRoutes;
