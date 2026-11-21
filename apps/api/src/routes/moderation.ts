import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { requireRole } from '../plugins/auth.js';
import { AppError, conflict, forbidden, notFound } from '../errors.js';
import { parse } from '../lib/validate.js';
import { withTransaction } from '../db/index.js';
import { findUserById } from '../db/repos.js';
import { audit } from '../billing/repo.js';
import { getMessage } from '../chat/repo.js';
import { serializeMessage } from '../chat/serialize.js';
import type { ChatEventType } from '../chat/hub.js';
import type { MessageRow } from '../chat/model.js';
import type { ActiveRestrictions, ReportView, RestrictionRow } from '../moderation/model.js';
import { canCloseReportAbout, canModerateContentOf, canRestrict } from '../moderation/rank.js';
import { restrictionSummary } from '../moderation/feedback.js';
import {
  closeReport, countReportsByStatus, countReportsForMessages, getActiveRestrictions, getReportView, getRestriction, hideMessage, insertRestriction,
  isActive, liftRestriction, listActiveRestrictionsForUsers, listReportViews, listRestrictionsForUser, removeMessage, resolveOpenReportsForMessage, unhideMessage,
} from '../moderation/repo.js';
import { closeReportSchema, liftSchema, moderateSchema, queueQuerySchema, restrictSchema, uuidSchema } from '../moderation/schemas.js';

const toId = (v: unknown, what: string): string => {
  const r = uuidSchema.safeParse(v);
  if (!r.success) throw notFound(`${what} not found`);
  return r.data;
};

const reportItem = (v: ReportView, reportCount: number, restrictions: ActiveRestrictions | undefined) => {
  const state = v.deleted_at ? 'removed' : v.hidden_at ? 'hidden' : 'visible';
  return {
    id: v.id,
    status: v.status,
    reason: v.reason,
    details: v.details,
    createdAt: v.created_at,
    resolution: v.resolution,
    resolutionNote: v.resolution_note,
    resolvedAt: v.resolved_at,
    resolvedBy: v.resolver_name ? { displayName: v.resolver_name } : null,
    reporter: { id: v.reporter_id, displayName: v.reporter_name },
    reportedUser: {
      id: v.reported_user_id, displayName: v.reported_name, role: v.reported_role,
      restrictions: { muted: restrictions?.muted ? restrictionSummary(restrictions.muted) : null, suspended: restrictions?.suspended ? restrictionSummary(restrictions.suspended) : null },
    },
    room: { id: v.room_id, slug: v.room_slug, name: v.room_name },
    message: {
      id: v.message_id,
      state,
      /** Exactly what was reported; never changes. */
      snapshot: v.reported_body,
      /** What the message says now (staff can read hidden messages; removed ones are gone). */
      current: state === 'removed' ? null : v.current_body,
      editedSinceReport: state !== 'removed' && v.current_body !== v.reported_body,
      moderationReason: v.moderation_reason,
      reportCount,
    },
  };
};

/** Moderator and administrator tools: the report queue, report decisions and message hiding/removal. Mounted at /api/moderation. */
export const moderationQueueRoutes: FastifyPluginAsync = async (app) => {
  const db = app.db;
  app.addHook('preHandler', requireRole('moderator', 'admin'));

  async function itemFor(v: ReportView) {
    const counts = await countReportsForMessages(db, [v.message_id]);
    const restr = await listActiveRestrictionsForUsers(db, [v.reported_user_id], app.now());
    return reportItem(v, counts.get(v.message_id) ?? 1, restr.get(v.reported_user_id));
  }

  // ------------------------------------------------------------------ the queue
  app.get('/reports', async (req) => {
    const q = parse(queueQuerySchema, req.query);
    const rows = await listReportViews(db, q);
    const counts = await countReportsForMessages(db, [...new Set(rows.map((r) => r.message_id))]);
    const restr = await listActiveRestrictionsForUsers(db, [...new Set(rows.map((r) => r.reported_user_id))], app.now());
    return {
      reports: rows.map((r) => reportItem(r, counts.get(r.message_id) ?? 1, restr.get(r.reported_user_id))),
      counts: await countReportsByStatus(db),
      limit: q.limit, offset: q.offset,
    };
  });

  app.get('/reports/:id', async (req) => {
    const v = await getReportView(db, toId((req.params as { id: string }).id, 'Report'));
    if (!v) throw notFound('Report not found');
    return { report: await itemFor(v) };
  });

  // ------------------------------------------------------------------ resolving and dismissing
  const close = (status: 'resolved' | 'dismissed') => async (req: FastifyRequest) => {
    const actor = req.user!;
    const v = await getReportView(db, toId((req.params as { id: string }).id, 'Report'));
    if (!v) throw notFound('Report not found');
    const { note } = parse(closeReportSchema, req.body ?? {});
    if (v.status !== 'open') throw conflict('This report has already been closed');
    // Nobody decides a report they filed or one about themselves, and rank limits who may judge reports about staff.
    if (v.reporter_id === actor.id || v.reported_user_id === actor.id) throw new AppError(403, 'CONFLICT_OF_INTEREST', 'You cannot close a report that you filed or that is about you. Ask another moderator.');
    if (!canCloseReportAbout(actor.role, v.reported_role)) throw forbidden('Only an administrator can close reports about staff members');

    const closed = await withTransaction(db, async (tx) => {
      const r = await closeReport(tx, v.id, { status, resolution: status === 'resolved' ? 'handled' : null, note: note ?? null, actorId: actor.id, now: app.now() });
      if (!r) throw conflict('This report has already been closed'); // someone else closed it first
      await audit(tx, {
        actorId: actor.id, action: status === 'resolved' ? 'report.resolved' : 'report.dismissed', entityType: 'message_report', entityId: v.id,
        data: { messageId: v.message_id, reporterId: v.reporter_id, reportedUserId: v.reported_user_id, reason: v.reason, note: note ?? null },
      });
      return r;
    });
    await app.events.emit('moderation.report_closed', { reportId: closed.id, outcome: status });
    return { report: await itemFor((await getReportView(db, closed.id))!) };
  };
  app.post('/reports/:id/resolve', close('resolved'));
  app.post('/reports/:id/dismiss', close('dismissed'));

  // ------------------------------------------------------------------ hiding and removing messages
  const publish = (type: ChatEventType, m: MessageRow) => app.chatHub.publish(m.room_id, { type, message: serializeMessage(m) });

  async function loadActionable(req: FastifyRequest): Promise<MessageRow> {
    const msg = await getMessage(db, toId((req.params as { id: string }).id, 'Message'));
    if (!msg) throw notFound('Message not found');
    // Rank rule: moderators act on members, administrators on moderators and members, never on peers, superiors or themselves.
    if (!canModerateContentOf(req.user!.role, msg.author_role) || msg.author_id === req.user!.id) {
      throw forbidden('You cannot moderate messages from this account');
    }
    return msg;
  }

  app.post('/messages/:id/hide', async (req) => {
    const actor = req.user!;
    const { reason } = parse(moderateSchema, req.body);
    const msg = await loadActionable(req);
    if (msg.deleted_at) throw conflict('This message has already been removed');
    if (msg.hidden_at) throw conflict('This message is already hidden');
    const closedReports = await withTransaction(db, async (tx) => {
      if (!(await hideMessage(tx, msg.id, actor.id, reason, app.now()))) throw conflict('This message was just moderated by someone else');
      const ids = await resolveOpenReportsForMessage(tx, msg.id, { resolution: 'hidden', note: reason, actorId: actor.id, now: app.now() });
      await audit(tx, {
        actorId: actor.id, action: 'message.hidden', entityType: 'room_message', entityId: msg.id,
        data: { roomId: msg.room_id, authorId: msg.author_id, reason, reportIds: ids, contentSnapshot: msg.body },
      });
      return ids;
    });
    const updated = (await getMessage(db, msg.id))!;
    publish('message.updated', updated);
    await app.events.emit('moderation.message_hidden', { messageId: msg.id, authorId: msg.author_id, roomId: msg.room_id, reason, reportIds: closedReports, at: updated.hidden_at ?? app.now() });
    return { message: serializeMessage(updated, actor), resolvedReports: closedReports.length };
  });

  app.post('/messages/:id/unhide', async (req) => {
    const actor = req.user!;
    const msg = await loadActionable(req);
    if (!msg.hidden_at || msg.deleted_at) throw conflict('This message is not hidden');
    await withTransaction(db, async (tx) => {
      if (!(await unhideMessage(tx, msg.id))) throw conflict('This message is not hidden');
      await audit(tx, { actorId: actor.id, action: 'message.unhidden', entityType: 'room_message', entityId: msg.id, data: { roomId: msg.room_id, authorId: msg.author_id } });
    });
    const updated = (await getMessage(db, msg.id))!;
    publish('message.updated', updated);
    await app.events.emit('moderation.message_unhidden', { messageId: msg.id, authorId: msg.author_id, roomId: msg.room_id, at: app.now() });
    return { message: serializeMessage(updated, actor) };
  });

  app.post('/messages/:id/remove', async (req) => {
    const actor = req.user!;
    const { reason } = parse(moderateSchema, req.body);
    const msg = await loadActionable(req);
    if (msg.deleted_at) throw conflict('This message has already been removed');
    const closedReports = await withTransaction(db, async (tx) => {
      if (!(await removeMessage(tx, msg.id, actor.id, reason, app.now()))) throw conflict('This message was just moderated by someone else');
      const ids = await resolveOpenReportsForMessage(tx, msg.id, { resolution: 'removed', note: reason, actorId: actor.id, now: app.now() });
      // The content is wiped from the chat, so the audit record keeps it: that is the evidence for the decision.
      await audit(tx, {
        actorId: actor.id, action: 'message.removed', entityType: 'room_message', entityId: msg.id,
        data: { roomId: msg.room_id, authorId: msg.author_id, reason, reportIds: ids, contentSnapshot: msg.body },
      });
      return ids;
    });
    const updated = (await getMessage(db, msg.id))!;
    publish('message.deleted', updated);
    await app.events.emit('moderation.message_removed', { messageId: msg.id, authorId: msg.author_id, roomId: msg.room_id, reason, reportIds: closedReports, at: app.now() });
    return { message: serializeMessage(updated, actor), resolvedReports: closedReports.length };
  });
};

const restrictionView = (r: RestrictionRow, now: Date) => ({
  id: r.id, userId: r.user_id, type: r.type, reason: r.reason, createdAt: r.created_at, expiresAt: r.expires_at,
  liftedAt: r.lifted_at, active: isActive(r, now),
});

/** Administrator-only account restrictions. Mounted at /api/admin (alongside the existing admin routes). */
export const adminRestrictionRoutes: FastifyPluginAsync = async (app) => {
  const db = app.db;
  app.addHook('preHandler', requireRole('admin'));

  app.get('/users/:id/restrictions', async (req) => {
    const id = toId((req.params as { id: string }).id, 'User');
    if (!(await findUserById(db, id))) throw notFound('User not found');
    const now = app.now();
    return { restrictions: (await listRestrictionsForUser(db, id)).map((r) => restrictionView(r, now)) };
  });

  app.post('/users/:id/restrictions', async (req, reply) => {
    const actor = req.user!;
    const id = toId((req.params as { id: string }).id, 'User');
    const input = parse(restrictSchema, req.body);
    const target = await findUserById(db, id);
    if (!target) throw notFound('User not found');
    if (!canRestrict(actor.role, target.role) || target.id === actor.id) throw forbidden('Administrators cannot be restricted');
    const now = app.now();
    const active: ActiveRestrictions = await getActiveRestrictions(db, id, now);
    if (active[input.type]) throw conflict(`This account already has an active ${input.type === 'muted' ? 'mute' : 'suspension'}. Lift it first to change it.`);
    const expiresAt = input.durationHours ? new Date(now.getTime() + input.durationHours * 3_600_000) : null;
    const r = await withTransaction(db, async (tx) => {
      const created = await insertRestriction(tx, { userId: id, type: input.type, reason: input.reason, createdBy: actor.id, expiresAt, now });
      await audit(tx, {
        actorId: actor.id, action: 'user.restricted', entityType: 'user', entityId: id,
        data: { restrictionId: created.id, type: input.type, reason: input.reason, expiresAt },
      });
      return created;
    });
    await app.events.emit('moderation.restricted', { restrictionId: r.id, userId: id, type: input.type, reason: input.reason, expiresAt });
    return reply.code(201).send({ restriction: restrictionView(r, now) });
  });

  app.post('/restrictions/:id/lift', async (req) => {
    const actor = req.user!;
    const id = toId((req.params as { id: string }).id, 'Restriction');
    const { note } = parse(liftSchema, req.body ?? {});
    const existing = await getRestriction(db, id);
    if (!existing) throw notFound('Restriction not found');
    const now = app.now();
    const lifted = await withTransaction(db, async (tx) => {
      const r = await liftRestriction(tx, id, actor.id, note ?? null, now);
      if (!r) throw conflict('This restriction is no longer active');
      await audit(tx, {
        actorId: actor.id, action: 'user.restriction_lifted', entityType: 'user', entityId: r.user_id,
        data: { restrictionId: r.id, type: r.type, note: note ?? null },
      });
      return r;
    });
    await app.events.emit('moderation.restriction_lifted', { restrictionId: lifted.id, userId: lifted.user_id, type: lifted.type });
    return { restriction: restrictionView(lifted, now) };
  });
};
