import { beforeAll, describe, expect, it } from 'vitest';
import { loginCookie, seedUser, get, send, setup, countRows, row, type Ctx } from './helpers.js';

// ----------------------------------------------------------------------------------------------- fixtures
let n = 0;
interface Msg { id: string; seq: number; body: string | null; deleted: boolean; moderation: { state: string; reason: string | null } | null; author: { id: string } }
interface Item { id: string; status: string; reason: string; details: string; resolution: string | null; resolutionNote: string | null; resolvedBy: { displayName: string } | null;
  reporter: { id: string; displayName: string }; reportedUser: { id: string; displayName: string; role: string };
  room: { slug: string; name: string }; message: { id: string; state: string; snapshot: string; current: string | null; editedSinceReport: boolean; moderationReason: string | null; reportCount: number } }
const makeRoom = async (ctx: Ctx, over: Record<string, unknown> = {}) => {
  n += 1;
  const res = await send(ctx, 'POST', '/api/staff/rooms', ctx.cookies.admin, { name: `Mod room ${n}`, slug: `mod-room-${n}`, description: 'd', category: 'general_discussion', ...over });
  return res.json().room as { id: string; slug: string };
};
const say = async (ctx: Ctx, slug: string, cookie: string, body = 'a normal message') => {
  const res = await send(ctx, 'POST', `/api/rooms/${slug}/messages`, cookie, { body });
  if (res.statusCode !== 201) throw new Error(`send failed ${res.statusCode} ${res.body}`);
  return res.json().message as Msg;
};
const report = (ctx: Ctx, slug: string, id: string, cookie: string | undefined, payload: unknown = { reason: 'spam' }) =>
  send(ctx, 'POST', `/api/rooms/${slug}/messages/${id}/report`, cookie, payload);
const history = async (ctx: Ctx, slug: string, cookie: string) => (await get(ctx, `/api/rooms/${slug}/messages?limit=100`, cookie)).json().messages as Msg[];
const find = async (ctx: Ctx, slug: string, cookie: string, id: string) => (await history(ctx, slug, cookie)).find((m) => m.id === id)!;
const queue = async (ctx: Ctx, qs = '', cookie = ctx.cookies.moderator) => (await get(ctx, `/api/moderation/reports${qs}`, cookie)).json();
const code = (r: { json: () => { error: { code: string } } }) => r.json().error.code;
const M = (id: string, action: string) => `/api/moderation/messages/${id}/${action}`;
const R = (id: string, action: string) => `/api/moderation/reports/${id}/${action}`;

const base = { CHAT_WRITES_PER_MINUTE: '10000', REPORTS_PER_HOUR: '1000', REPORTS_PER_DAY: '1000' };
let ctx: Ctx; let pub: { id: string; slug: string }; let prem: { id: string; slug: string };
let authorCookie: string; let authorId: string; let otherCookie: string; let modCookie2: string; let adminCookie2: string;
beforeAll(async () => {
  ctx = await setup(base);
  pub = await makeRoom(ctx);
  prem = await makeRoom(ctx, { access: 'premium' });
  const a = await seedUser(ctx.db, 'free', 'author@example.com'); authorId = a.id;
  authorCookie = await loginCookie(ctx.app, 'author@example.com');
  await seedUser(ctx.db, 'free', 'other@example.com');
  otherCookie = await loginCookie(ctx.app, 'other@example.com');
  await seedUser(ctx.db, 'moderator', 'mod2@example.com');
  modCookie2 = await loginCookie(ctx.app, 'mod2@example.com');
  await seedUser(ctx.db, 'admin', 'admin2@example.com');
  adminCookie2 = await loginCookie(ctx.app, 'admin2@example.com');
});

// ----------------------------------------------------------------------------------------------- reporting
describe('reporting a message', () => {
  it('records the reporter, reason, details, timestamp and an exact snapshot of the content', async () => {
    const m = await say(ctx, pub.slug, authorCookie, 'Buy my signals now!!! t.me/scam');
    const res = await report(ctx, pub.slug, m.id, ctx.cookies.free, { reason: 'scam', details: '  Looks like a pump group  ' });
    expect(res.statusCode).toBe(201);
    expect(Object.keys(res.json().report).sort()).toEqual(['createdAt', 'id', 'status']); // the reporter learns nothing else
    expect(res.json().report.status).toBe('open');
    const [r] = await row<Record<string, unknown>>(ctx, 'select * from message_reports where id = $1', [res.json().report.id]);
    expect(r).toMatchObject({
      message_id: m.id, room_id: pub.id, reporter_id: ctx.users.free.id, reported_user_id: authorId, reason: 'scam',
      details: 'Looks like a pump group', reported_body: 'Buy my signals now!!! t.me/scam', status: 'open', resolved_by: null, resolved_at: null,
    });
    expect(Math.abs((r!.created_at as Date).getTime() - ctx.clock.now().getTime())).toBeLessThan(5000);
  });

  it('keeps the snapshot even after the author edits the message or a moderator removes it', async () => {
    const m = await say(ctx, pub.slug, authorCookie, 'original offensive text');
    const rep = (await report(ctx, pub.slug, m.id, ctx.cookies.free, { reason: 'harassment' })).json().report;
    await send(ctx, 'PATCH', `/api/rooms/${pub.slug}/messages/${m.id}`, authorCookie, { body: 'innocent edit' });
    let [r] = await row<{ reported_body: string }>(ctx, 'select reported_body from message_reports where id = $1', [rep.id]);
    expect(r!.reported_body).toBe('original offensive text');
    await send(ctx, 'POST', M(m.id, 'remove'), ctx.cookies.moderator, { reason: 'Harassment' });
    [r] = await row<{ reported_body: string }>(ctx, 'select reported_body from message_reports where id = $1', [rep.id]);
    expect(r!.reported_body).toBe('original offensive text');
    const item = (await get(ctx, `/api/moderation/reports/${rep.id}`, ctx.cookies.moderator)).json().report as Item;
    expect(item.message).toMatchObject({ snapshot: 'original offensive text', current: null, state: 'removed' });
  });

  it('requires sign-in, and only lets people report what they can see', async () => {
    const m = await say(ctx, pub.slug, authorCookie);
    expect((await report(ctx, pub.slug, m.id, undefined)).statusCode).toBe(401);
    const secret = await say(ctx, prem.slug, ctx.cookies.premium, 'premium chatter');
    const denied = await report(ctx, prem.slug, secret.id, ctx.cookies.free);
    expect(denied.statusCode).toBe(403);
    expect(code(denied)).toBe('PREMIUM_REQUIRED');
    expect(await countRows(ctx, 'message_reports', 'message_id = $1', [secret.id])).toBe(0);
    expect((await report(ctx, prem.slug, secret.id, otherCookie)).statusCode).toBe(403);
    expect((await report(ctx, pub.slug, secret.id, ctx.cookies.free)).statusCode).toBe(404); // right message id, wrong room
    expect((await report(ctx, prem.slug, secret.id, ctx.cookies.admin)).statusCode).toBe(201); // staff can see premium rooms
  });

  it('rejects reports on your own message, duplicates, unknown messages and unavailable messages', async () => {
    const m = await say(ctx, pub.slug, authorCookie);
    expect((await report(ctx, pub.slug, m.id, authorCookie)).statusCode).toBe(400);
    expect((await report(ctx, pub.slug, m.id, ctx.cookies.free)).statusCode).toBe(201);
    const dupe = await report(ctx, pub.slug, m.id, ctx.cookies.free, { reason: 'harassment' });
    expect(dupe.statusCode).toBe(409);
    expect(code(dupe)).toBe('ALREADY_REPORTED');
    expect((await report(ctx, pub.slug, m.id, otherCookie)).statusCode).toBe(201); // a different person may report it
    for (const id of ['nope', '00000000-0000-4000-8000-000000000000']) expect((await report(ctx, pub.slug, id, ctx.cookies.free)).statusCode).toBe(404);

    const gone = await say(ctx, pub.slug, authorCookie);
    await send(ctx, 'DELETE', `/api/rooms/${pub.slug}/messages/${gone.id}`, authorCookie);
    const hidden = await say(ctx, pub.slug, authorCookie);
    await send(ctx, 'POST', M(hidden.id, 'hide'), ctx.cookies.moderator, { reason: 'Under review' });
    for (const id of [gone.id, hidden.id]) {
      const res = await report(ctx, pub.slug, id, ctx.cookies.free);
      expect(res.statusCode).toBe(409);
      expect(code(res)).toBe('MESSAGE_UNAVAILABLE');
    }
  });

  it('hides archived rooms from reporters who cannot see them', async () => {
    const room = await makeRoom(ctx);
    const m = await say(ctx, room.slug, authorCookie);
    await send(ctx, 'POST', `/api/staff/rooms/${room.id}/archive`, ctx.cookies.admin);
    expect((await report(ctx, room.slug, m.id, ctx.cookies.free)).statusCode).toBe(404);
  });

  it.each([
    ['unknown reason', { reason: 'rude' }], ['missing reason', {}], ['reason not a string', { reason: 5 }],
    ['"other" without details', { reason: 'other' }], ['"other" with tiny details', { reason: 'other', details: 'no' }],
    ['details too long', { reason: 'spam', details: 'x'.repeat(501) }], ['details with control characters', { reason: 'spam', details: 'bad\u0007' }],
    ['status supplied', { reason: 'spam', status: 'resolved' }], ['reporter supplied', { reason: 'spam', reporterId: '00000000-0000-4000-8000-000000000000' }],
    ['snapshot supplied', { reason: 'spam', reportedBody: 'fake' }],
  ])('rejects an invalid report: %s', async (_l, payload) => {
    const m = await say(ctx, pub.slug, authorCookie);
    const before = await countRows(ctx, 'message_reports');
    expect((await report(ctx, pub.slug, m.id, ctx.cookies.free, payload)).statusCode).toBe(400);
    expect(await countRows(ctx, 'message_reports')).toBe(before);
  });

  it('keeps the reporter secret from the reported person and from other members', async () => {
    const m = await say(ctx, pub.slug, authorCookie, 'something rude');
    await report(ctx, pub.slug, m.id, ctx.cookies.free, { reason: 'harassment', details: 'SECRET-REPORTER-DETAILS' });
    for (const cookie of [authorCookie, otherCookie]) {
      const res = await get(ctx, `/api/rooms/${pub.slug}/messages?limit=100`, cookie);
      expect(res.body).not.toContain('SECRET-REPORTER-DETAILS');
      expect(res.body).not.toContain(ctx.users.free.id);
      expect(res.body.toLowerCase()).not.toContain('report');
    }
  });

  it('lets muted members and staff-authored messages be reported, and reports about staff reach the queue', async () => {
    const mod = await say(ctx, pub.slug, ctx.cookies.moderator, 'a moderator said this');
    const res = await report(ctx, pub.slug, mod.id, ctx.cookies.free, { reason: 'inappropriate' });
    expect(res.statusCode).toBe(201);
    const q = await queue(ctx, '?limit=50');
    expect((q.reports as Item[]).find((r) => r.id === res.json().report.id)!.reportedUser.role).toBe('moderator');
  });
});

describe('reporting abuse limits', () => {
  it('limits reports per hour and per day, counted from stored reports, with a retry hint', async () => {
    const own = await setup({ ...base, REPORTS_PER_HOUR: '2', REPORTS_PER_DAY: '3' });
    const room = await makeRoom(own);
    const msgs: Msg[] = [];
    for (let i = 0; i < 6; i++) msgs.push(await say(own, room.slug, own.cookies.premium, `target ${i}`));
    const r = (i: number, cookie = own.cookies.free) => report(own, room.slug, msgs[i]!.id, cookie);

    expect((await r(0)).statusCode).toBe(201);
    expect((await r(1)).statusCode).toBe(201);
    const blocked = await r(2);
    expect(blocked.statusCode).toBe(429);
    expect(code(blocked)).toBe('RATE_LIMITED');
    expect(blocked.json().error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.json().error.details.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(await countRows(own, 'message_reports')).toBe(2);
    // Another person is unaffected, and so is reading.
    expect((await r(2, own.cookies.moderator)).statusCode).toBe(201);
    expect((await get(own, `/api/rooms/${room.slug}/messages`, own.cookies.free)).statusCode).toBe(200);

    own.clock.advanceMs(3_600_000 + 60_000);
    expect((await r(2)).statusCode).toBe(201); // hour window passed: 3rd report of the day
    own.clock.advanceMs(3_600_000 + 60_000);
    const daily = await r(3);
    expect(daily.statusCode).toBe(429); // daily cap of 3 reached even though the hourly window is clear
    own.clock.advanceMs(23 * 3_600_000);
    expect((await r(3)).statusCode).toBe(201);
  });

  it('does not count rejected attempts (duplicates, invalid input) against the limit', async () => {
    const own = await setup({ ...base, REPORTS_PER_HOUR: '2' });
    const room = await makeRoom(own);
    const a = await say(own, room.slug, own.cookies.premium, 'a'); const b = await say(own, room.slug, own.cookies.premium, 'b');
    await report(own, room.slug, a.id, own.cookies.free);
    for (let i = 0; i < 5; i++) {
      await report(own, room.slug, a.id, own.cookies.free); // duplicate
      await report(own, room.slug, b.id, own.cookies.free, { reason: 'nope' }); // invalid
    }
    expect((await report(own, room.slug, b.id, own.cookies.free)).statusCode).toBe(201);
  });
});

// ----------------------------------------------------------------------------------------------- permissions
describe('moderation controls are for staff only (server-side)', () => {
  it('refuses visitors (401) and free/premium members (403) on every moderation endpoint, with no side effects', async () => {
    const m = await say(ctx, pub.slug, authorCookie, 'untouchable');
    const rep = (await report(ctx, pub.slug, m.id, otherCookie)).json().report;
    const calls: ['GET' | 'POST', string, unknown?][] = [
      ['GET', '/api/moderation/reports'], ['GET', `/api/moderation/reports/${rep.id}`], ['GET', '/api/moderation/overview'],
      ['POST', R(rep.id, 'resolve'), {}], ['POST', R(rep.id, 'dismiss'), {}],
      ['POST', M(m.id, 'hide'), { reason: 'nope nope' }], ['POST', M(m.id, 'unhide')], ['POST', M(m.id, 'remove'), { reason: 'nope nope' }],
    ];
    for (const [method, url, body] of calls) {
      const visitor = method === 'GET' ? await get(ctx, url) : await send(ctx, 'POST', url, undefined, body);
      expect(visitor.statusCode, `visitor ${method} ${url}`).toBe(401);
      for (const who of ['free', 'premium'] as const) {
        const res = method === 'GET' ? await get(ctx, url, ctx.cookies[who]) : await send(ctx, 'POST', url, ctx.cookies[who], body);
        expect(res.statusCode, `${who} ${method} ${url}`).toBe(403);
      }
    }
    expect((await row(ctx, 'select status from message_reports where id = $1', [rep.id]))[0]).toMatchObject({ status: 'open' });
    expect(await find(ctx, pub.slug, authorCookie, m.id)).toMatchObject({ body: 'untouchable', moderation: null });
  });

  it('lets both moderators and administrators use the queue', async () => {
    for (const who of ['moderator', 'admin'] as const) {
      expect((await get(ctx, '/api/moderation/reports', ctx.cookies[who])).statusCode).toBe(200);
      expect((await get(ctx, '/api/moderation/overview', ctx.cookies[who])).json().reports).toMatchObject({ open: expect.any(Number) });
    }
  });

  it('a demoted moderator loses queue access immediately', async () => {
    const u = await seedUser(ctx.db, 'free', 'demoted-mod@example.com');
    await send(ctx, 'PATCH', `/api/admin/users/${u.id}/role`, ctx.cookies.admin, { role: 'moderator' });
    const cookie = await loginCookie(ctx.app, 'demoted-mod@example.com');
    expect((await get(ctx, '/api/moderation/reports', cookie)).statusCode).toBe(200);
    await send(ctx, 'PATCH', `/api/admin/users/${u.id}/role`, ctx.cookies.admin, { role: 'free' });
    expect((await get(ctx, '/api/moderation/reports', cookie)).statusCode).toBe(403);
  });
});

// ----------------------------------------------------------------------------------------------- the queue
describe('the moderation queue', () => {
  it('lists open reports oldest first with everything a moderator needs to decide', async () => {
    const own = await setup(base);
    const room = await makeRoom(own);
    const first = await say(own, room.slug, own.cookies.premium, 'first offender');
    const second = await say(own, room.slug, own.cookies.premium, 'second offender');
    const r1 = (await report(own, room.slug, first.id, own.cookies.free, { reason: 'spam', details: 'link spam' })).json().report;
    own.clock.advanceMs(60_000);
    const r2 = (await report(own, room.slug, second.id, own.cookies.free, { reason: 'harassment' })).json().report;
    own.clock.advanceMs(60_000);
    await report(own, room.slug, first.id, own.cookies.moderator, { reason: 'scam' }); // a second report on the same message

    const q = (await queue(own, '', own.cookies.moderator)) as { reports: Item[]; counts: Record<string, number> };
    expect(q.reports.map((r) => r.id).slice(0, 2)).toEqual([r1.id, r2.id]);
    expect(q.counts).toMatchObject({ open: 3, resolved: 0, dismissed: 0 });
    expect(q.reports[0]).toMatchObject({
      status: 'open', reason: 'spam', details: 'link spam', reporter: { displayName: 'free user' }, reportedUser: { displayName: 'premium user', role: 'free' },
      room: { slug: room.slug }, message: { id: first.id, state: 'visible', snapshot: 'first offender', current: 'first offender', editedSinceReport: false, reportCount: 2 },
    });
    expect(q.reports[1]!.message.reportCount).toBe(1);
  });

  it('shows how the message looks now: edited, hidden or removed', async () => {
    const m = await say(ctx, pub.slug, authorCookie, 'before the edit');
    const rep = (await report(ctx, pub.slug, m.id, ctx.cookies.free)).json().report;
    await send(ctx, 'PATCH', `/api/rooms/${pub.slug}/messages/${m.id}`, authorCookie, { body: 'after the edit' });
    let item = (await get(ctx, `/api/moderation/reports/${rep.id}`, ctx.cookies.moderator)).json().report as Item;
    expect(item.message).toMatchObject({ snapshot: 'before the edit', current: 'after the edit', editedSinceReport: true, state: 'visible' });
    await send(ctx, 'POST', M(m.id, 'hide'), ctx.cookies.moderator, { reason: 'Looks bad' });
    item = (await get(ctx, `/api/moderation/reports/${rep.id}`, ctx.cookies.moderator)).json().report as Item;
    expect(item.message).toMatchObject({ state: 'hidden', current: 'after the edit', moderationReason: 'Looks bad' }); // staff can still read hidden text
  });

  it('filters by status, paginates, and validates parameters', async () => {
    const own = await setup(base);
    const room = await makeRoom(own);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const m = await say(own, room.slug, own.cookies.premium, `msg ${i}`);
      ids.push((await report(own, room.slug, m.id, own.cookies.free)).json().report.id);
      own.clock.advanceMs(1000);
    }
    await send(own, 'POST', R(ids[0]!, 'resolve'), own.cookies.moderator, { note: 'done' });
    await send(own, 'POST', R(ids[1]!, 'dismiss'), own.cookies.moderator, {});
    const open = await queue(own, '?status=open&limit=2', own.cookies.moderator);
    expect(open.reports.map((r: Item) => r.id)).toEqual([ids[2], ids[3]]);
    expect((await queue(own, '?status=open&limit=2&offset=2', own.cookies.moderator)).reports.map((r: Item) => r.id)).toEqual([ids[4]]);
    expect((await queue(own, '?status=resolved', own.cookies.moderator)).reports.map((r: Item) => r.id)).toEqual([ids[0]]);
    expect((await queue(own, '?status=dismissed', own.cookies.moderator)).reports.map((r: Item) => r.id)).toEqual([ids[1]]);
    expect((await queue(own, '?status=all', own.cookies.moderator)).reports).toHaveLength(5);
    expect(open.counts).toEqual({ open: 3, resolved: 1, dismissed: 1 });
    for (const qs of ['?status=bogus', '?limit=0', '?limit=51', '?offset=-1', '?limit=abc']) expect((await get(own, `/api/moderation/reports${qs}`, own.cookies.moderator)).statusCode, qs).toBe(400);
  });

  it('returns 404 for unknown or malformed report ids', async () => {
    for (const id of ['nope', '00000000-0000-4000-8000-000000000000']) {
      expect((await get(ctx, `/api/moderation/reports/${id}`, ctx.cookies.moderator)).statusCode).toBe(404);
      expect((await send(ctx, 'POST', R(id, 'resolve'), ctx.cookies.moderator, {})).statusCode).toBe(404);
    }
  });
});

// ----------------------------------------------------------------------------------------------- resolving and dismissing
describe('resolving and dismissing reports', () => {
  it.each([['resolve', 'resolved', 'report.resolved', 'handled'], ['dismiss', 'dismissed', 'report.dismissed', null]] as const)(
    'a moderator can %s a report; it is recorded and audited', async (action, status, auditAction, resolution) => {
      const m = await say(ctx, pub.slug, authorCookie);
      const rep = (await report(ctx, pub.slug, m.id, ctx.cookies.free)).json().report;
      const res = await send(ctx, 'POST', R(rep.id, action), ctx.cookies.moderator, { note: '  Spoke to the member  ' });
      expect(res.statusCode).toBe(200);
      expect(res.json().report).toMatchObject({ status, resolution, resolutionNote: 'Spoke to the member', resolvedBy: { displayName: 'moderator user' } });
      expect(res.json().report.resolvedAt).toBeTruthy();
      const [r] = await row<Record<string, unknown>>(ctx, 'select status, resolved_by, resolution from message_reports where id = $1', [rep.id]);
      expect(r).toMatchObject({ status, resolved_by: ctx.users.moderator.id, resolution });
      const log = await row<{ actor_id: string; data: { note: string; reportedUserId: string } }>(ctx, 'select actor_id, data from audit_log where action = $1 and entity_id = $2', [auditAction, rep.id]);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ actor_id: ctx.users.moderator.id, data: { note: 'Spoke to the member', reportedUserId: authorId } });
      expect(await find(ctx, pub.slug, authorCookie, m.id)).toMatchObject({ body: 'a normal message', moderation: null }); // no content change
    });

  it('cannot close a report twice, and the note is validated', async () => {
    const m = await say(ctx, pub.slug, authorCookie);
    const rep = (await report(ctx, pub.slug, m.id, ctx.cookies.free)).json().report;
    for (const bad of [{ note: 'x'.repeat(501) }, { note: 'bad\u0007' }, { status: 'open' }, { resolvedBy: '00000000-0000-4000-8000-000000000000' }]) {
      expect((await send(ctx, 'POST', R(rep.id, 'resolve'), ctx.cookies.moderator, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await send(ctx, 'POST', R(rep.id, 'resolve'), ctx.cookies.moderator)).statusCode).toBe(200); // note is optional
    expect((await send(ctx, 'POST', R(rep.id, 'dismiss'), ctx.cookies.admin, {})).statusCode).toBe(409);
    expect((await send(ctx, 'POST', R(rep.id, 'resolve'), ctx.cookies.admin, {})).statusCode).toBe(409);
    expect(await countRows(ctx, 'audit_log', "entity_id = $1 and action like 'report.%'", [rep.id])).toBe(1);
  });

  it('nobody closes a report they filed or one about themselves', async () => {
    const m = await say(ctx, pub.slug, authorCookie);
    const mine = (await report(ctx, pub.slug, m.id, modCookie2)).json().report; // moderator 2 is the reporter
    const denied = await send(ctx, 'POST', R(mine.id, 'dismiss'), modCookie2, {});
    expect(denied.statusCode).toBe(403);
    expect(code(denied)).toBe('CONFLICT_OF_INTEREST');
    expect((await send(ctx, 'POST', R(mine.id, 'dismiss'), ctx.cookies.moderator, {})).statusCode).toBe(200); // someone else can

    const own = await say(ctx, pub.slug, modCookie2, 'moderator 2 wrote this');
    const about = (await report(ctx, pub.slug, own.id, ctx.cookies.free)).json().report;
    expect(code(await send(ctx, 'POST', R(about.id, 'resolve'), modCookie2, {}))).toBe('CONFLICT_OF_INTEREST');
    expect((await row(ctx, 'select status from message_reports where id = $1', [about.id]))[0]).toMatchObject({ status: 'open' });
  });

  it('only administrators close reports about staff; administrators may review each other', async () => {
    const modMsg = await say(ctx, pub.slug, modCookie2, 'staff message');
    const adminMsg = await say(ctx, pub.slug, adminCookie2, 'admin message');
    const aboutMod = (await report(ctx, pub.slug, modMsg.id, ctx.cookies.free)).json().report;
    const aboutAdmin = (await report(ctx, pub.slug, adminMsg.id, ctx.cookies.free)).json().report;
    expect((await send(ctx, 'POST', R(aboutMod.id, 'dismiss'), ctx.cookies.moderator, {})).statusCode).toBe(403);
    expect((await send(ctx, 'POST', R(aboutAdmin.id, 'dismiss'), ctx.cookies.moderator, {})).statusCode).toBe(403);
    expect((await send(ctx, 'POST', R(aboutMod.id, 'dismiss'), ctx.cookies.admin, {})).statusCode).toBe(200);
    expect((await send(ctx, 'POST', R(aboutAdmin.id, 'resolve'), ctx.cookies.admin, {})).statusCode).toBe(200);
  });

  it('lists closed reports under their status with who closed them', async () => {
    const m = await say(ctx, pub.slug, authorCookie);
    const rep = (await report(ctx, pub.slug, m.id, ctx.cookies.free)).json().report;
    await send(ctx, 'POST', R(rep.id, 'dismiss'), ctx.cookies.admin, { note: 'Not a violation' });
    const closed = (await queue(ctx, '?status=dismissed&limit=50')).reports as Item[];
    expect(closed.find((r) => r.id === rep.id)).toMatchObject({ status: 'dismissed', resolutionNote: 'Not a violation', resolvedBy: { displayName: 'admin user' } });
    expect(((await queue(ctx, '?status=open&limit=50')).reports as Item[]).some((r) => r.id === rep.id)).toBe(false);
  });
});

// ----------------------------------------------------------------------------------------------- hiding and removing messages
describe('hiding and removing messages', () => {
  const capture = (roomId: string) => {
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const conn = { userId: 'spy', roomId, send: (type: string, data: unknown) => events.push({ type, data: data as Record<string, unknown> }), end: () => undefined };
    ctx.app.chatHub.add(conn);
    return { events, stop: () => ctx.app.chatHub.remove(conn) };
  };

  it('hides a message: content disappears from the chat, the author is told why, other members are not', async () => {
    const m = await say(ctx, pub.slug, authorCookie, 'borderline text');
    const rep = (await report(ctx, pub.slug, m.id, ctx.cookies.free)).json().report;
    const spy = capture(pub.id);
    const res = await send(ctx, 'POST', M(m.id, 'hide'), ctx.cookies.moderator, { reason: '  Needs review  ' });
    expect(res.statusCode).toBe(200);
    expect(res.json().resolvedReports).toBe(1);
    expect(res.json().message).toMatchObject({ id: m.id, body: null, deleted: false, moderation: { state: 'hidden', reason: 'Needs review' } });

    for (const [cookie, reason] of [[authorCookie, 'Needs review'], [ctx.cookies.moderator, 'Needs review'], [otherCookie, null], [ctx.cookies.free, null]] as const) {
      const seen = await find(ctx, pub.slug, cookie, m.id);
      expect(seen.body).toBeNull();
      expect(seen.moderation).toEqual({ state: 'hidden', reason });
    }
    expect((await get(ctx, `/api/rooms/${pub.slug}/messages`, otherCookie)).body).not.toContain('borderline text');
    // Live clients are told too, without the reason or the content.
    expect(spy.events).toHaveLength(1);
    expect(spy.events[0]).toMatchObject({ type: 'message.updated', data: { id: m.id, body: null, moderation: { state: 'hidden', reason: null } } });
    expect(JSON.stringify(spy.events)).not.toContain('borderline text');
    spy.stop();
    // The report was settled by the action.
    expect((await row(ctx, 'select status, resolution, resolution_note, resolved_by from message_reports where id = $1', [rep.id]))[0])
      .toMatchObject({ status: 'resolved', resolution: 'hidden', resolution_note: 'Needs review', resolved_by: ctx.users.moderator.id });
  });

  it('audits hiding with the reason, settled reports and a snapshot of the content', async () => {
    const m = await say(ctx, pub.slug, authorCookie, 'evidence text');
    const rep = (await report(ctx, pub.slug, m.id, ctx.cookies.free)).json().report;
    await send(ctx, 'POST', M(m.id, 'hide'), ctx.cookies.moderator, { reason: 'Hidden for review' });
    const [log] = await row<{ actor_id: string; data: Record<string, unknown> }>(ctx, "select actor_id, data from audit_log where action = 'message.hidden' and entity_id = $1", [m.id]);
    expect(log!.actor_id).toBe(ctx.users.moderator.id);
    expect(log!.data).toMatchObject({ authorId, roomId: pub.id, reason: 'Hidden for review', reportIds: [rep.id], contentSnapshot: 'evidence text' });
  });

  it('a hidden message cannot be edited, deleted by its author, or reported; staff can restore it', async () => {
    const m = await say(ctx, pub.slug, authorCookie, 'will be hidden');
    await send(ctx, 'POST', M(m.id, 'hide'), ctx.cookies.moderator, { reason: 'Under review' });
    const edit = await send(ctx, 'PATCH', `/api/rooms/${pub.slug}/messages/${m.id}`, authorCookie, { body: 'sneaky rewrite' });
    expect(edit.statusCode).toBe(409);
    expect(code(edit)).toBe('MESSAGE_HIDDEN');
    expect(code(await send(ctx, 'DELETE', `/api/rooms/${pub.slug}/messages/${m.id}`, authorCookie))).toBe('MESSAGE_HIDDEN');
    expect((await row(ctx, 'select body, deleted_at from room_messages where id = $1', [m.id]))[0]).toMatchObject({ body: 'will be hidden', deleted_at: null });
    expect((await send(ctx, 'POST', M(m.id, 'hide'), ctx.cookies.admin, { reason: 'again again' })).statusCode).toBe(409);

    const spy = capture(pub.id);
    const restored = await send(ctx, 'POST', M(m.id, 'unhide'), ctx.cookies.admin);
    expect(restored.statusCode).toBe(200);
    expect(restored.json().message).toMatchObject({ body: 'will be hidden', moderation: null });
    expect(await find(ctx, pub.slug, otherCookie, m.id)).toMatchObject({ body: 'will be hidden', moderation: null });
    expect(spy.events[0]).toMatchObject({ type: 'message.updated', data: { id: m.id, body: 'will be hidden' } });
    spy.stop();
    expect((await send(ctx, 'POST', M(m.id, 'unhide'), ctx.cookies.admin)).statusCode).toBe(409); // not hidden any more
    expect(await countRows(ctx, 'audit_log', "action = 'message.unhidden' and entity_id = $1", [m.id])).toBe(1);
    expect((await send(ctx, 'PATCH', `/api/rooms/${pub.slug}/messages/${m.id}`, authorCookie, { body: 'now allowed' })).statusCode).toBe(200);
  });

  it('removes a message permanently: content wiped, the author told why, evidence kept in the audit log', async () => {
    const m = await say(ctx, pub.slug, authorCookie, 'Seriously abusive words');
    const rep = (await report(ctx, pub.slug, m.id, ctx.cookies.free)).json().report;
    const rep2 = (await report(ctx, pub.slug, m.id, otherCookie)).json().report;
    const spy = capture(pub.id);
    const res = await send(ctx, 'POST', M(m.id, 'remove'), ctx.cookies.moderator, { reason: 'Abuse' });
    expect(res.statusCode).toBe(200);
    expect(res.json().resolvedReports).toBe(2);
    expect(res.json().message).toMatchObject({ body: null, deleted: true, moderation: { state: 'removed', reason: 'Abuse' } });
    expect((await row(ctx, 'select body, deleted_by, moderation_reason from room_messages where id = $1', [m.id]))[0])
      .toMatchObject({ body: '', deleted_by: ctx.users.moderator.id, moderation_reason: 'Abuse' });
    expect(await find(ctx, pub.slug, authorCookie, m.id)).toMatchObject({ body: null, moderation: { state: 'removed', reason: 'Abuse' } });
    expect(await find(ctx, pub.slug, otherCookie, m.id)).toMatchObject({ body: null, moderation: { state: 'removed', reason: null } });
    expect(spy.events[0]).toMatchObject({ type: 'message.deleted', data: { id: m.id, body: null, moderation: { state: 'removed', reason: null } } });
    expect(JSON.stringify(spy.events)).not.toContain('abusive');
    spy.stop();

    const [log] = await row<{ data: Record<string, unknown> }>(ctx, "select data from audit_log where action = 'message.removed' and entity_id = $1", [m.id]);
    expect(log!.data).toMatchObject({ reason: 'Abuse', contentSnapshot: 'Seriously abusive words', authorId });
    expect((log!.data.reportIds as string[]).sort()).toEqual([rep.id, rep2.id].sort());
    // Irreversible and final.
    expect((await send(ctx, 'POST', M(m.id, 'unhide'), ctx.cookies.admin)).statusCode).toBe(409);
    expect((await send(ctx, 'POST', M(m.id, 'remove'), ctx.cookies.admin, { reason: 'twice twice' })).statusCode).toBe(409);
    expect((await send(ctx, 'POST', M(m.id, 'hide'), ctx.cookies.admin, { reason: 'twice twice' })).statusCode).toBe(409);
    expect((await send(ctx, 'PATCH', `/api/rooms/${pub.slug}/messages/${m.id}`, authorCookie, { body: 'edit' })).statusCode).toBe(409);
  });

  it('can remove a message that is already hidden', async () => {
    const m = await say(ctx, pub.slug, authorCookie, 'hidden then removed');
    await send(ctx, 'POST', M(m.id, 'hide'), ctx.cookies.moderator, { reason: 'First hidden' });
    expect((await send(ctx, 'POST', M(m.id, 'remove'), ctx.cookies.moderator, { reason: 'Then removed' })).statusCode).toBe(200);
    expect(await find(ctx, pub.slug, authorCookie, m.id)).toMatchObject({ body: null, moderation: { state: 'removed', reason: 'Then removed' } });
    expect((await row(ctx, 'select hidden_at from room_messages where id = $1', [m.id]))[0]).toMatchObject({ hidden_at: null });
  });

  it('treats the older staff delete from messaging as a moderator removal', async () => {
    const m = await say(ctx, pub.slug, authorCookie, 'removed the old way');
    await send(ctx, 'DELETE', `/api/rooms/${pub.slug}/messages/${m.id}`, ctx.cookies.moderator);
    expect(await find(ctx, pub.slug, otherCookie, m.id)).toMatchObject({ deleted: true, moderation: { state: 'removed', reason: null } });
    const own = await say(ctx, pub.slug, authorCookie, 'removed by its author');
    await send(ctx, 'DELETE', `/api/rooms/${pub.slug}/messages/${own.id}`, authorCookie);
    expect(await find(ctx, pub.slug, otherCookie, own.id)).toMatchObject({ deleted: true, moderation: null }); // self-deletion is not moderation
  });

  it.each([
    ['no reason', {}], ['reason too short', { reason: 'ab' }], ['reason too long', { reason: 'x'.repeat(201) }], ['control characters', { reason: 'bad\u0007reason' }],
    ['unknown field', { reason: 'fine reason', hiddenBy: '00000000-0000-4000-8000-000000000000' }],
  ])('requires a valid reason to hide or remove: %s', async (_l, payload) => {
    const m = await say(ctx, pub.slug, authorCookie);
    for (const action of ['hide', 'remove']) expect((await send(ctx, 'POST', M(m.id, action), ctx.cookies.moderator, payload)).statusCode).toBe(400);
    expect(await find(ctx, pub.slug, authorCookie, m.id)).toMatchObject({ moderation: null });
  });

  it('returns 404 for unknown messages', async () => {
    for (const id of ['nope', '00000000-0000-4000-8000-000000000000']) for (const a of ['hide', 'unhide', 'remove']) {
      expect((await send(ctx, 'POST', M(id, a), ctx.cookies.moderator, { reason: 'some reason' })).statusCode).toBe(404);
    }
  });

  it('enforces rank: moderators act on members only; administrators on moderators; nobody on administrators or themselves', async () => {
    const asModerator = await say(ctx, pub.slug, modCookie2, 'by a moderator');
    const asAdmin = await say(ctx, pub.slug, adminCookie2, 'by an admin');
    const reason = { reason: 'some reason' };
    for (const target of [asModerator, asAdmin]) expect((await send(ctx, 'POST', M(target.id, 'hide'), ctx.cookies.moderator, reason)).statusCode).toBe(403);
    expect((await send(ctx, 'POST', M(asModerator.id, 'remove'), modCookie2, reason)).statusCode).toBe(403); // not even your own
    expect((await send(ctx, 'POST', M(asAdmin.id, 'hide'), ctx.cookies.admin, reason)).statusCode).toBe(403); // admin vs admin
    expect((await send(ctx, 'POST', M(asAdmin.id, 'remove'), adminCookie2, reason)).statusCode).toBe(403); // own message
    expect(await find(ctx, pub.slug, otherCookie, asModerator.id)).toMatchObject({ body: 'by a moderator', moderation: null });
    expect(await find(ctx, pub.slug, otherCookie, asAdmin.id)).toMatchObject({ body: 'by an admin', moderation: null });
    expect((await send(ctx, 'POST', M(asModerator.id, 'hide'), ctx.cookies.admin, reason)).statusCode).toBe(200); // admin may moderate a moderator
  });

  it('works in archived rooms, so abuse can still be cleaned up', async () => {
    const room = await makeRoom(ctx);
    const m = await say(ctx, room.slug, authorCookie, 'old abuse');
    await send(ctx, 'POST', `/api/staff/rooms/${room.id}/archive`, ctx.cookies.admin);
    expect((await send(ctx, 'POST', M(m.id, 'remove'), ctx.cookies.moderator, { reason: 'Old abuse' })).statusCode).toBe(200);
  });
});

// ----------------------------------------------------------------------------------------------- audit trail
describe('audit trail', () => {
  it('keeps every moderation action with who did it, and the records survive the content being wiped', async () => {
    const m = await say(ctx, pub.slug, authorCookie, 'audit me');
    const rep = (await report(ctx, pub.slug, m.id, ctx.cookies.free)).json().report;
    await send(ctx, 'POST', M(m.id, 'hide'), ctx.cookies.moderator, { reason: 'Step one' });
    await send(ctx, 'POST', M(m.id, 'unhide'), ctx.cookies.admin);
    await send(ctx, 'POST', M(m.id, 'remove'), ctx.cookies.admin, { reason: 'Step two' });
    const log = await row<{ action: string; actor_id: string }>(ctx, "select action, actor_id from audit_log where entity_id = $1 and entity_type = 'room_message' order by created_at asc, action asc", [m.id]);
    expect(log.map((l) => l.action).sort()).toEqual(['message.hidden', 'message.removed', 'message.unhidden']);
    expect(log.find((l) => l.action === 'message.hidden')!.actor_id).toBe(ctx.users.moderator.id);
    expect(log.find((l) => l.action === 'message.removed')!.actor_id).toBe(ctx.users.admin.id);
    expect((await row(ctx, 'select reported_body from message_reports where id = $1', [rep.id]))[0]).toMatchObject({ reported_body: 'audit me' });
  });

  it('writes nothing to the audit log for failed or forbidden actions', async () => {
    const m = await say(ctx, pub.slug, authorCookie);
    const before = await countRows(ctx, 'audit_log');
    await send(ctx, 'POST', M(m.id, 'hide'), ctx.cookies.free, { reason: 'not allowed' });
    await send(ctx, 'POST', M(m.id, 'hide'), ctx.cookies.moderator, { reason: 'x' });
    await send(ctx, 'POST', M(m.id, 'unhide'), ctx.cookies.moderator);
    expect(await countRows(ctx, 'audit_log')).toBe(before);
  });

  it('exposes no way to delete reports, restrictions or audit records', async () => {
    const m = await say(ctx, pub.slug, authorCookie);
    const rep = (await report(ctx, pub.slug, m.id, ctx.cookies.free)).json().report;
    for (const url of [`/api/moderation/reports/${rep.id}`, '/api/moderation/reports', '/api/admin/audit', `/api/admin/restrictions/${rep.id}`]) {
      for (const who of ['moderator', 'admin'] as const) {
        const res = await send(ctx, 'DELETE', url, ctx.cookies[who]);
        expect([404, 405], `${who} DELETE ${url}`).toContain(res.statusCode);
      }
    }
    expect(await countRows(ctx, 'message_reports', 'id = $1', [rep.id])).toBe(1);
  });
});
