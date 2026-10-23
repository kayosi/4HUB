import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';
import { updateDisplayName } from '../db/repos.js';
import { publicUser } from './auth.js';
import { parse } from '../lib/validate.js';
import { notFound } from '../errors.js';

const patchSchema = z.object({ displayName: z.string().trim().min(2).max(60) });

const meRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (req) => ({ user: publicUser(req.user!) }));

  app.patch('/', async (req) => {
    const body = parse(patchSchema, req.body);
    const updated = await updateDisplayName(app.db, req.user!.id, body.displayName);
    if (!updated) throw notFound('User not found');
    return { user: publicUser(updated) };
  });
};

export default meRoutes;
