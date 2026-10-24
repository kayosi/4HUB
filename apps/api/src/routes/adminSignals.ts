import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../plugins/auth.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { parse } from '../lib/validate.js';
import { withTransaction } from '../db/index.js';
import { sniffImage } from '../storage/index.js';
import { MAX_IMAGES_PER_SIGNAL, type SignalRow } from '../signals/model.js';
import { addImage, addUpdate, deleteImage, getImage, getSignal, insertSignal, listImages, updateSignal } from '../signals/repo.js';
import { closeSchema, createSignalSchema, idSchema, noteSchema, updateSignalSchema } from '../signals/schemas.js';
import { applyPatch, describe, describeClose, diff, levelProblem } from '../signals/history.js';
import { presentDetail } from '../signals/present.js';

const UPLOAD_BODY_LIMIT = 40 * 1024 * 1024;

const adminSignalRoutes: FastifyPluginAsync = async (app) => {
  const db = app.db;
  app.addHook('preHandler', requireRole('admin'));

  async function load(id: unknown): Promise<SignalRow> {
    const r = idSchema.safeParse(id);
    const s = r.success ? await getSignal(db, r.data) : undefined;
    if (!s) throw notFound('Signal not found');
    return s;
  }
  const ensureActive = (s: SignalRow) => {
    if (s.status === 'closed') throw conflict('This signal is closed and can no longer be changed');
  };
  const problem = (msg: string | null) => {
    if (msg) throw new AppError(400, 'BAD_REQUEST', msg, { levels: msg });
  };

  // Publish: one request creates the signal and its first history entry atomically.
  app.post('/', async (req, reply) => {
    const b = parse(createSignalSchema, req.body);
    problem(levelProblem({ direction: b.direction, entry: b.entry, stopLoss: b.stopLoss, tps: [b.takeProfit1, b.takeProfit2, b.takeProfit3] }, true));
    const row = await withTransaction(db, async (tx) => {
      const s = await insertSignal(tx, {
        ...b, takeProfit2: b.takeProfit2 ?? null, takeProfit3: b.takeProfit3 ?? null, createdBy: req.user!.id,
      });
      await addUpdate(tx, { signalId: s.id, authorId: req.user!.id, kind: 'created', message: `${s.asset} ${s.direction === 'buy' ? 'Buy' : 'Sell'} published` });
      return s;
    });
    return reply.code(201).send(await presentDetail(db, row, req.user, { countView: false }));
  });

  // Edit / move SL / adjust targets. Every real change is written to the audit history.
  app.patch('/:id', async (req) => {
    const before = await load((req.params as { id: string }).id);
    ensureActive(before);
    const { note, ...patch } = parse(updateSignalSchema, req.body);
    const { changes, columns } = diff(before, patch);
    const merged = applyPatch(before, columns);
    problem(levelProblem({ direction: merged.direction, entry: merged.entry, stopLoss: merged.stop_loss, tps: [merged.take_profit_1, merged.take_profit_2, merged.take_profit_3] }, false));
    if (Object.keys(columns).length === 0 && !note) throw badRequest('Nothing changed');

    const row = await withTransaction(db, async (tx) => {
      const updated = Object.keys(columns).length ? (await updateSignal(tx, before.id, columns))! : before;
      const auto = Object.keys(changes).length ? describe(changes, updated.entry) : { kind: 'note' as const, message: '' };
      await addUpdate(tx, {
        signalId: before.id, authorId: req.user!.id, kind: auto.kind,
        message: note || auto.message, changes,
      });
      return updated;
    });
    return presentDetail(db, row, req.user, { countView: false });
  });

  // Free-text update with no field changes, e.g. "Price approaching TP1".
  app.post('/:id/updates', async (req, reply) => {
    const s = await load((req.params as { id: string }).id);
    ensureActive(s);
    const { message } = parse(noteSchema, req.body);
    await withTransaction(db, async (tx) => {
      await addUpdate(tx, { signalId: s.id, authorId: req.user!.id, kind: 'note', message });
      await updateSignal(tx, s.id, {});
    });
    return reply.code(201).send(await presentDetail(db, (await load(s.id)), req.user, { countView: false }));
  });

  app.post('/:id/close', async (req) => {
    const s = await load((req.params as { id: string }).id);
    ensureActive(s);
    const b = parse(closeSchema, req.body);
    if (b.result === 'tp_hit') {
      const tp = [s.take_profit_1, s.take_profit_2, s.take_profit_3][(b.tpLevel ?? 1) - 1];
      if (tp === null || tp === undefined) throw badRequest(`This signal has no take profit ${b.tpLevel}`);
    }
    const row = await withTransaction(db, async (tx) => {
      const closed = (await updateSignal(tx, s.id, {
        status: 'closed', result: b.result, tpLevel: b.tpLevel ?? null, pips: b.pips ?? null, closedAt: new Date(),
      }))!;
      await addUpdate(tx, {
        signalId: s.id, authorId: req.user!.id, kind: 'closed',
        message: b.note ? `${describeClose(b.result, b.tpLevel, b.pips)}. ${b.note}` : describeClose(b.result, b.tpLevel, b.pips),
        changes: { result: { from: null, to: b.result } },
      });
      return closed;
    });
    return presentDetail(db, row, req.user, { countView: false });
  });

  // Upload one or more chart screenshots (multipart). Type is verified from file contents.
  app.post('/:id/images', { bodyLimit: UPLOAD_BODY_LIMIT }, async (req, reply) => {
    const s = await load((req.params as { id: string }).id);
    if (!req.isMultipart()) throw badRequest('Send images as multipart/form-data');
    const existing = (await listImages(db, s.id)).length;
    const saved: { key: string; imageId: string }[] = [];
    let position = existing;
    try {
      for await (const part of req.files()) {
        if (existing + saved.length >= MAX_IMAGES_PER_SIGNAL) throw badRequest(`A signal can have at most ${MAX_IMAGES_PER_SIGNAL} images`);
        const buf = await part.toBuffer(); // throws 413 when over the size limit
        const type = sniffImage(buf);
        if (!type) throw badRequest('Only PNG, JPEG or WebP images are allowed');
        const key = await app.storage.put(buf);
        const row = await addImage(db, { signalId: s.id, storageKey: key, contentType: type, size: buf.length, position: position++ }).catch(async (e) => {
          await app.storage.remove(key);
          throw e;
        });
        saved.push({ key, imageId: row.id });
      }
    } catch (err) {
      // A failed batch is all-or-nothing: remove files and rows already written for it.
      for (const { key, imageId } of saved) {
        await app.storage.remove(key);
        await deleteImage(db, imageId);
      }
      throw err;
    }
    if (saved.length === 0) throw badRequest('No image received');
    await updateSignal(db, s.id, {});
    return reply.code(201).send(await presentDetail(db, await load(s.id), req.user, { countView: false }));
  });

  app.delete('/:id/images/:imageId', async (req, reply) => {
    const s = await load((req.params as { id: string }).id);
    const iid = idSchema.safeParse((req.params as { imageId: string }).imageId);
    const img = iid.success ? await getImage(db, s.id, iid.data) : undefined;
    if (!img) throw notFound('Image not found');
    await deleteImage(db, img.id);
    await app.storage.remove(img.storage_key);
    return reply.code(204).send();
  });
};

export default adminSignalRoutes;
