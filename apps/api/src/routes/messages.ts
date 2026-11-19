import { PassThrough } from 'node:stream';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError, conflict, forbidden, notFound } from '../errors.js';
import { parse } from '../lib/validate.js';
import { isStaff, type Role } from '../auth/roles.js';
import { findUserBySession } from '../db/repos.js';
import { withTransaction } from '../db/index.js';
import { audit } from '../billing/repo.js';
import { getRoomById } from '../rooms/repo.js';
import type { RoomRow } from '../rooms/model.js';
import { canEnterRoom } from '../rooms/serialize.js';
import { authorizeRoom, type RoomMode } from '../chat/access.js';
import { getActiveRestrictions, getReportByReporter, insertReport, recentReportTimes } from '../moderation/repo.js';
import { reportSchema } from '../moderation/schemas.js';
import {
  getMessage, getMessageByClientId, insertMessage, listMessages, tombstoneMessage, updateMessageBody,
} from '../chat/repo.js';
import { createMessageSchema, historyQuerySchema, messageIdSchema, updateMessageSchema } from '../chat/schemas.js';
import { serializeMessage } from '../chat/serialize.js';
import type { MessageRow } from '../chat/model.js';
import type { ChatEventType, Connection } from '../chat/hub.js';

const pgCode = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

/** Room messaging: history, send, edit, delete and the live stream. Registered under /api/rooms. */
const messageRoutes: FastifyPluginAsync = async (app) => {
  const db = app.db;
  const hub = app.chatHub;

  const authorize = (req: FastifyRequest, slug: unknown, mode: RoomMode) => authorizeRoom(app, req, slug, mode);

  function throttle(req: FastifyRequest): void {
    const wait = app.chatLimiter.take(req.user!.id);
    if (wait > 0) throw new AppError(429, 'RATE_LIMITED', `You are sending messages too quickly. Try again in ${wait}s.`, { retryAfterSeconds: wait });
  }

  /** A message is only reachable through its own room, so access to room A can never be used to touch a message in room B. */
  async function loadMessage(room: RoomRow, id: unknown): Promise<MessageRow> {
    const parsed = messageIdSchema.safeParse(id);
    const m = parsed.success ? await getMessage(db, parsed.data) : undefined;
    if (!m || m.room_id !== room.id) throw notFound('Message not found');
    return m;
  }

  const publish = (type: ChatEventType, m: MessageRow) => hub.publish(m.room_id, { type, message: serializeMessage(m) });

  // ---------------------------------------------------------------- history
  app.get('/:slug/messages', async (req) => {
    const room = await authorize(req, (req.params as { slug: string }).slug, 'read');
    const q = parse(historyQuerySchema, req.query);
    const page = await listMessages(db, room.id, { limit: q.limit, ...(q.before !== undefined ? { before: q.before } : {}) });
    return {
      messages: page.messages.map((m) => serializeMessage(m, req.user)),
      hasMore: page.hasMore,
      // Pass this as ?before= to load the next older page.
      nextBefore: page.hasMore ? page.messages[0]!.seq : null,
    };
  });

  // ---------------------------------------------------------------- send
  app.post('/:slug/messages', async (req, reply) => {
    const room = await authorize(req, (req.params as { slug: string }).slug, 'write');
    throttle(req);
    const body = parse(createMessageSchema, req.body);
    const author = req.user!; // never taken from the payload

    if (body.clientId) {
      const prior = await getMessageByClientId(db, author.id, body.clientId);
      if (prior) return replayed(prior, room, reply, author);
    }
    let created: MessageRow;
    try {
      created = await insertMessage(db, { roomId: room.id, authorId: author.id, clientId: body.clientId ?? null, body: body.body, now: app.now() });
    } catch (e) {
      // Two concurrent sends with the same client id: the unique constraint picked a winner; return that message.
      const prior = pgCode(e) === '23505' && body.clientId ? await getMessageByClientId(db, author.id, body.clientId) : undefined;
      if (prior) return replayed(prior, room, reply, author);
      throw e;
    }
    publish('message.created', created);
    return reply.code(201).send({ message: serializeMessage(created, author) });
  });

  const replayed = (prior: MessageRow, room: RoomRow, reply: { code: (n: number) => { send: (b: unknown) => unknown } }, viewer: { id: string; role: Role }) => {
    if (prior.room_id !== room.id) throw conflict('This client id was already used for another message');
    return reply.code(200).send({ message: serializeMessage(prior, viewer) });
  };

  // ---------------------------------------------------------------- edit (author only)
  app.patch('/:slug/messages/:id', async (req) => {
    const params = req.params as { slug: string; id: string };
    const room = await authorize(req, params.slug, 'write');
    throttle(req);
    const { body } = parse(updateMessageSchema, req.body);
    const msg = await loadMessage(room, params.id);
    // Ownership is checked against the session user, never against anything in the request. Staff cannot edit others' words.
    if (msg.author_id !== req.user!.id) throw forbidden('You can only edit your own messages');
    if (msg.deleted_at) throw conflict('This message was deleted');
    if (msg.hidden_at) throw new AppError(409, 'MESSAGE_HIDDEN', 'This message was hidden by a moderator and cannot be edited.');
    if (msg.body === body) return { message: serializeMessage(msg, req.user) };
    const updated = await updateMessageBody(db, msg.id, body, app.now());
    if (!updated) throw conflict('This message was deleted');
    publish('message.updated', updated);
    return { message: serializeMessage(updated, req.user) };
  });

  // ---------------------------------------------------------------- delete (author, or staff)
  app.delete('/:slug/messages/:id', async (req) => {
    const params = req.params as { slug: string; id: string };
    const room = await authorize(req, params.slug, 'delete');
    throttle(req);
    const msg = await loadMessage(room, params.id);
    const actor = req.user!;
    const own = msg.author_id === actor.id;
    if (!own && !isStaff(actor.role)) throw forbidden('You can only delete your own messages');
    // A hidden message is under review: its author cannot make the evidence disappear.
    if (own && msg.hidden_at && !msg.deleted_at) throw new AppError(409, 'MESSAGE_HIDDEN', 'This message was hidden by a moderator and cannot be deleted.');
    if (msg.deleted_at) return { message: serializeMessage(msg, actor) }; // idempotent

    const deleted = await withTransaction(db, async (tx) => {
      const d = await tombstoneMessage(tx, msg.id, actor.id, app.now());
      // A staff member removing someone else's message leaves a trail; authors deleting their own do not.
      if (d && !own) await audit(tx, { actorId: actor.id, action: 'message.deleted', entityType: 'room_message', entityId: msg.id, data: { roomId: room.id, authorId: msg.author_id } });
      return d;
    });
    if (!deleted) return { message: serializeMessage((await getMessage(db, msg.id))!, actor) };
    publish('message.deleted', deleted);
    return { message: serializeMessage(deleted, actor) };
  });

  // ---------------------------------------------------------------- report a message
  app.post('/:slug/messages/:id/report', async (req, reply) => {
    const params = req.params as { slug: string; id: string };
    // Same room access as reading: you can only report what you are allowed to see. Muted members may still report.
    const room = await authorize(req, params.slug, 'read');
    const input = parse(reportSchema, req.body);
    const reporter = req.user!;
    const msg = await loadMessage(room, params.id);

    if (msg.author_id === reporter.id) throw new AppError(400, 'BAD_REQUEST', 'You cannot report your own message.');
    if (msg.deleted_at || msg.hidden_at) throw new AppError(409, 'MESSAGE_UNAVAILABLE', 'This message is no longer available to report.');
    if (await getReportByReporter(db, msg.id, reporter.id)) throw new AppError(409, 'ALREADY_REPORTED', 'You have already reported this message.');

    // Abuse protection, counted from stored reports so it survives restarts and cannot be dodged by switching tabs.
    const now = app.now();
    for (const [max, windowMs] of [[app.config.REPORTS_PER_HOUR, 3_600_000], [app.config.REPORTS_PER_DAY, 86_400_000]] as const) {
      const times = await recentReportTimes(db, reporter.id, new Date(now.getTime() - windowMs), max);
      if (times.length >= max) {
        const wait = Math.max(1, Math.ceil((times[max - 1]!.getTime() + windowMs - now.getTime()) / 1000));
        throw new AppError(429, 'RATE_LIMITED', 'You have sent too many reports recently. Please try again later.', { retryAfterSeconds: wait });
      }
    }

    try {
      // The text is snapshotted here: later edits, hiding or removal can never change what was reported.
      const report = await insertReport(db, {
        messageId: msg.id, roomId: room.id, reporterId: reporter.id, reportedUserId: msg.author_id,
        reason: input.reason, details: input.details, reportedBody: msg.body, now,
      });
      // The reporter only ever learns that the report was received; nothing about other reports or staff decisions.
      return reply.code(201).send({ report: { id: report.id, status: report.status, createdAt: report.created_at } });
    } catch (e) {
      if (pgCode(e) === '23505') throw new AppError(409, 'ALREADY_REPORTED', 'You have already reported this message.');
      throw e;
    }
  });

  // ---------------------------------------------------------------- live updates (Server-Sent Events)
  app.get('/:slug/stream', async (req, reply) => {
    const room = await authorize(req, (req.params as { slug: string }).slug, 'read');
    const user = req.user!;
    if (hub.streamsFor(user.id) >= app.config.CHAT_MAX_STREAMS_PER_USER) {
      throw new AppError(429, 'TOO_MANY_STREAMS', 'Too many open chat connections. Close other tabs and try again.');
    }
    const tokenHash = req.sessionTokenHash;

    const stream = new PassThrough();
    // A reader that cannot keep up is dropped rather than buffered without bound; the browser reconnects and resyncs.
    const write = (chunk: string) => {
      if (stream.destroyed || stream.writableEnded) return;
      if (stream.writableLength > 1_000_000) { stream.destroy(); return; }
      stream.write(chunk);
    };
    const conn: Connection = {
      userId: user.id,
      roomId: room.id,
      send: (event, data, id) => write(`event: ${event}\n${id !== undefined ? `id: ${id}\n` : ''}data: ${JSON.stringify(data)}\n\n`),
      end: () => { if (!stream.writableEnded) stream.end(); },
    };

    // Re-validates the session and room access with the same rules as a normal request, so a lapsed subscription,
    // revoked role, logout or archived room stops the stream within one interval.
    const stillAllowed = async (): Promise<boolean> => {
      const current = tokenHash ? await findUserBySession(db, tokenHash) : undefined;
      if (!current) return false;
      if ((await getActiveRestrictions(db, current.id, app.now())).suspended) return false;
      const fresh = await getRoomById(db, room.id);
      if (!fresh || (fresh.archived_at !== null && !isStaff(current.role))) return false;
      return canEnterRoom(fresh, { role: current.role, entitlement: await app.billing.entitlementFor(current.id) });
    };

    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      stillAllowed()
        .then((ok) => {
          if (ok) { write(': keep-alive\n\n'); return; }
          conn.send('closed', { reason: 'access_revoked' });
          conn.end();
        })
        .catch((err) => req.log.warn({ err }, 'chat stream recheck failed')) // transient failure: keep the stream, try next tick
        .finally(() => { checking = false; });
    }, app.config.CHAT_STREAM_RECHECK_MS);
    timer.unref();

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(timer);
      hub.remove(conn);
      if (!stream.destroyed) stream.destroy();
    };
    req.raw.on('close', cleanup);
    stream.on('close', cleanup);
    stream.on('error', cleanup);

    // Subscribe BEFORE the first byte so nothing published after this point can be missed; the client resyncs history on connect.
    hub.add(conn);
    write('retry: 3000\n\n');
    return reply
      .header('Content-Type', 'text/event-stream; charset=utf-8')
      .header('Cache-Control', 'no-cache, no-transform')
      .header('X-Accel-Buffering', 'no')
      .send(stream);
  });
};
export default messageRoutes;
