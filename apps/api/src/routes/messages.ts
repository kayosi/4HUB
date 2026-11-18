import { PassThrough } from 'node:stream';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError, conflict, forbidden, notFound, unauthenticated } from '../errors.js';
import { parse } from '../lib/validate.js';
import { isStaff } from '../auth/roles.js';
import { findUserBySession } from '../db/repos.js';
import { withTransaction } from '../db/index.js';
import { audit } from '../billing/repo.js';
import { getRoomById, getRoomBySlug } from '../rooms/repo.js';
import type { RoomRow } from '../rooms/model.js';
import { slugSchema } from '../rooms/schemas.js';
import { canEnterRoom } from '../rooms/serialize.js';
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

  /**
   * The ONE access check for everything chat does. Reuses the room rules from Prompt 4A (canEnterRoom, which defers to the
   * central can()), so a lapsed subscription closes chat exactly like it closes the room page.
   * Messaging requires a signed-in user even in public rooms.
   */
  async function authorizeRoom(req: FastifyRequest, slugParam: unknown, mode: 'read' | 'write'): Promise<RoomRow> {
    if (!req.user) throw unauthenticated();
    const slug = slugSchema.safeParse(slugParam);
    const room = slug.success ? await getRoomBySlug(db, slug.data) : undefined;
    if (!room || (room.archived_at !== null && !isStaff(req.user.role))) throw notFound('Room not found');
    if (!canEnterRoom(room, req.user)) throw new AppError(403, 'PREMIUM_REQUIRED', 'This is a premium room. Upgrade to join.');
    if (mode === 'write' && room.archived_at !== null) throw new AppError(409, 'ROOM_ARCHIVED', 'This room is archived and read-only.');
    return room;
  }

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
    const room = await authorizeRoom(req, (req.params as { slug: string }).slug, 'read');
    const q = parse(historyQuerySchema, req.query);
    const page = await listMessages(db, room.id, { limit: q.limit, ...(q.before !== undefined ? { before: q.before } : {}) });
    return {
      messages: page.messages.map(serializeMessage),
      hasMore: page.hasMore,
      // Pass this as ?before= to load the next older page.
      nextBefore: page.hasMore ? page.messages[0]!.seq : null,
    };
  });

  // ---------------------------------------------------------------- send
  app.post('/:slug/messages', async (req, reply) => {
    const room = await authorizeRoom(req, (req.params as { slug: string }).slug, 'write');
    throttle(req);
    const body = parse(createMessageSchema, req.body);
    const author = req.user!; // never taken from the payload

    if (body.clientId) {
      const prior = await getMessageByClientId(db, author.id, body.clientId);
      if (prior) return replayed(prior, room, reply);
    }
    let created: MessageRow;
    try {
      created = await insertMessage(db, { roomId: room.id, authorId: author.id, clientId: body.clientId ?? null, body: body.body, now: app.now() });
    } catch (e) {
      // Two concurrent sends with the same client id: the unique constraint picked a winner; return that message.
      const prior = pgCode(e) === '23505' && body.clientId ? await getMessageByClientId(db, author.id, body.clientId) : undefined;
      if (prior) return replayed(prior, room, reply);
      throw e;
    }
    publish('message.created', created);
    return reply.code(201).send({ message: serializeMessage(created) });
  });

  const replayed = (prior: MessageRow, room: RoomRow, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (prior.room_id !== room.id) throw conflict('This client id was already used for another message');
    return reply.code(200).send({ message: serializeMessage(prior) });
  };

  // ---------------------------------------------------------------- edit (author only)
  app.patch('/:slug/messages/:id', async (req) => {
    const params = req.params as { slug: string; id: string };
    const room = await authorizeRoom(req, params.slug, 'write');
    throttle(req);
    const { body } = parse(updateMessageSchema, req.body);
    const msg = await loadMessage(room, params.id);
    // Ownership is checked against the session user, never against anything in the request. Staff cannot edit others' words.
    if (msg.author_id !== req.user!.id) throw forbidden('You can only edit your own messages');
    if (msg.deleted_at) throw conflict('This message was deleted');
    if (msg.body === body) return { message: serializeMessage(msg) };
    const updated = await updateMessageBody(db, msg.id, body, app.now());
    if (!updated) throw conflict('This message was deleted');
    publish('message.updated', updated);
    return { message: serializeMessage(updated) };
  });

  // ---------------------------------------------------------------- delete (author, or staff)
  app.delete('/:slug/messages/:id', async (req) => {
    const params = req.params as { slug: string; id: string };
    const room = await authorizeRoom(req, params.slug, 'write');
    throttle(req);
    const msg = await loadMessage(room, params.id);
    const actor = req.user!;
    const own = msg.author_id === actor.id;
    if (!own && !isStaff(actor.role)) throw forbidden('You can only delete your own messages');
    if (msg.deleted_at) return { message: serializeMessage(msg) }; // idempotent

    const deleted = await withTransaction(db, async (tx) => {
      const d = await tombstoneMessage(tx, msg.id, actor.id, app.now());
      // A staff member removing someone else's message leaves a trail; authors deleting their own do not.
      if (d && !own) await audit(tx, { actorId: actor.id, action: 'message.deleted', entityType: 'room_message', entityId: msg.id, data: { roomId: room.id, authorId: msg.author_id } });
      return d;
    });
    if (!deleted) return { message: serializeMessage((await getMessage(db, msg.id))!) };
    publish('message.deleted', deleted);
    return { message: serializeMessage(deleted) };
  });

  // ---------------------------------------------------------------- live updates (Server-Sent Events)
  app.get('/:slug/stream', async (req, reply) => {
    const room = await authorizeRoom(req, (req.params as { slug: string }).slug, 'read');
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
