import { beforeAll, describe, expect, it } from 'vitest';
import { loginCookie, seedUser, get, send, setup, countRows, row, type Ctx } from './helpers.js';

let n = 0;
const makeRoom = async (ctx: Ctx, over: Record<string, unknown> = {}) => {
  n += 1;
  const res = await send(ctx, 'POST', '/api/staff/rooms', ctx.cookies.admin, { name: `Chat room ${n}`, slug: `chat-room-${n}`, description: 'd', category: 'general_discussion', ...over });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json().room as { id: string; slug: string };
};
const url = (slug: string, tail = '') => `/api/rooms/${slug}/messages${tail}`;
const post = (ctx: Ctx, slug: string, cookie: string | undefined, body: unknown) => send(ctx, 'POST', url(slug), cookie, body);
const say = async (ctx: Ctx, slug: string, cookie: string, body = 'hello there') => {
  const res = await post(ctx, slug, cookie, { body });
  if (res.statusCode !== 201) throw new Error(`send failed ${res.statusCode} ${res.body}`);
  return res.json().message as Msg;
};
interface Msg { id: string; seq: number; roomId: string; body: string | null; deleted: boolean; editedAt: string | null; createdAt: string; author: { id: string; displayName: string; isStaff: boolean } }
const code = (r: { json: () => { error: { code: string } } }) => r.json().error.code;

const base = { CHAT_WRITES_PER_MINUTE: '10000' };
let ctx: Ctx; let pub: { id: string; slug: string }; let prem: { id: string; slug: string }; let other: string; let otherId: string;
beforeAll(async () => {
  ctx = await setup(base);
  pub = await makeRoom(ctx);
  prem = await makeRoom(ctx, { access: 'premium' });
  const u = await seedUser(ctx.db, 'free', 'other@example.com');
  otherId = u.id;
  other = await loginCookie(ctx.app, 'other@example.com');
});

describe('access control (server-side)', () => {
  it('requires sign-in for every messaging endpoint, even in public rooms', async () => {
    const m = await say(ctx, pub.slug, ctx.cookies.free);
    const calls: ['GET' | 'POST' | 'PATCH' | 'DELETE', string, unknown?][] = [
      ['GET', url(pub.slug)], ['POST', url(pub.slug), { body: 'x' }], ['PATCH', url(pub.slug, `/${m.id}`), { body: 'x' }], ['DELETE', url(pub.slug, `/${m.id}`)], ['GET', `/api/rooms/${pub.slug}/stream`],
    ];
    for (const [method, u, body] of calls) {
      const res = method === 'GET' ? await get(ctx, u) : await send(ctx, method, u, undefined, body);
      expect(res.statusCode, `${method} ${u}`).toBe(401);
    }
  });

  it('refuses free members every endpoint of a premium room and leaks nothing', async () => {
    const m = await say(ctx, prem.slug, ctx.cookies.premium, 'SECRET-PREMIUM-CHAT');
    const before = await countRows(ctx, 'room_messages');
    const calls: ['GET' | 'POST' | 'PATCH' | 'DELETE', string, unknown?][] = [
      ['GET', url(prem.slug)], ['POST', url(prem.slug), { body: 'let me in' }], ['PATCH', url(prem.slug, `/${m.id}`), { body: 'hacked' }], ['DELETE', url(prem.slug, `/${m.id}`)], ['GET', `/api/rooms/${prem.slug}/stream`],
    ];
    for (const [method, u, body] of calls) {
      const res = method === 'GET' ? await get(ctx, u, ctx.cookies.free) : await send(ctx, method, u, ctx.cookies.free, body);
      expect(res.statusCode, `${method} ${u}`).toBe(403);
      expect(code(res)).toBe('PREMIUM_REQUIRED');
      expect(res.body).not.toContain('SECRET-PREMIUM-CHAT');
    }
    expect(await countRows(ctx, 'room_messages')).toBe(before);
    expect((await get(ctx, url(prem.slug, '?limit=5'), ctx.cookies.premium)).json().messages.some((x: Msg) => x.body === 'SECRET-PREMIUM-CHAT')).toBe(true);
    expect((await row(ctx, 'select body from room_messages where id = $1', [m.id]))[0]).toMatchObject({ body: 'SECRET-PREMIUM-CHAT' });
  });

  it('lets premium members and staff use premium rooms, and any signed-in member use public ones', async () => {
    for (const who of ['premium', 'moderator', 'admin'] as const) {
      expect((await post(ctx, prem.slug, ctx.cookies[who], { body: `hi from ${who}` })).statusCode).toBe(201);
      expect((await get(ctx, url(prem.slug), ctx.cookies[who])).statusCode).toBe(200);
    }
    for (const who of ['free', 'premium', 'moderator', 'admin'] as const) expect((await post(ctx, pub.slug, ctx.cookies[who], { body: 'hi' })).statusCode).toBe(201);
  });

  it('returns 404 for unknown or malformed rooms', async () => {
    for (const slug of ['nope-room', 'Bad_Slug', 'x']) {
      expect((await get(ctx, url(slug), ctx.cookies.admin)).statusCode, slug).toBe(404);
      expect((await post(ctx, slug, ctx.cookies.admin, { body: 'x' })).statusCode, slug).toBe(404);
    }
  });

  it('follows the subscription: revoking premium blocks reading and posting on the next request', async () => {
    const u = await seedUser(ctx.db, 'free', 'lapsing@example.com');
    await ctx.app.billing.grant(ctx.users.admin.id, u.id, 'premium_monthly', 30, 'fixture');
    const cookie = await loginCookie(ctx.app, 'lapsing@example.com');
    expect((await post(ctx, prem.slug, cookie, { body: 'before' })).statusCode).toBe(201);
    await send(ctx, 'POST', `/api/admin/users/${u.id}/subscription/revoke`, ctx.cookies.admin, { reason: 'fixture' });
    expect((await get(ctx, url(prem.slug), cookie)).statusCode).toBe(403);
    expect((await post(ctx, prem.slug, cookie, { body: 'after' })).statusCode).toBe(403);
  });

  it('follows the subscription clock through grace and expiry', async () => {
    const own = await setup(base);
    const room = await makeRoom(own, { access: 'premium' });
    expect((await post(own, room.slug, own.cookies.premium, { body: 'a' })).statusCode).toBe(201);
    own.clock.advanceDays(31); // inside the 3-day grace window
    expect((await post(own, room.slug, own.cookies.premium, { body: 'b' })).statusCode).toBe(201);
    own.clock.advanceDays(5);
    expect((await post(own, room.slug, own.cookies.premium, { body: 'c' })).statusCode).toBe(403);
    expect((await get(own, url(room.slug), own.cookies.premium)).statusCode).toBe(403);
  });

  it('turning a room premium locks free members out of its chat immediately', async () => {
    const room = await makeRoom(ctx);
    await say(ctx, room.slug, ctx.cookies.free, 'visible while public');
    await send(ctx, 'PATCH', `/api/staff/rooms/${room.id}`, ctx.cookies.admin, { access: 'premium' });
    expect((await get(ctx, url(room.slug), ctx.cookies.free)).statusCode).toBe(403);
  });

  it('hides archived rooms from members, and makes them read-only for staff', async () => {
    const room = await makeRoom(ctx);
    const m = await say(ctx, room.slug, ctx.cookies.free, 'before archive');
    await send(ctx, 'POST', `/api/staff/rooms/${room.id}/archive`, ctx.cookies.admin);
    for (const [method, u, body] of [['GET', url(room.slug)], ['POST', url(room.slug), { body: 'x' }], ['PATCH', url(room.slug, `/${m.id}`), { body: 'x' }], ['DELETE', url(room.slug, `/${m.id}`)]] as const) {
      const res = method === 'GET' ? await get(ctx, u, ctx.cookies.free) : await send(ctx, method, u, ctx.cookies.free, body);
      expect(res.statusCode, `member ${method}`).toBe(404);
    }
    expect((await get(ctx, url(room.slug), ctx.cookies.moderator)).json().messages).toHaveLength(1);
    const blocked = await post(ctx, room.slug, ctx.cookies.admin, { body: 'nope' });
    expect(blocked.statusCode).toBe(409);
    expect(code(blocked)).toBe('ROOM_ARCHIVED');
    expect((await send(ctx, 'DELETE', url(room.slug, `/${m.id}`), ctx.cookies.admin)).statusCode).toBe(409);
  });

  it('cannot reach a message in another room by using a room you can access', async () => {
    const secret = await say(ctx, prem.slug, ctx.cookies.premium, 'premium-only text');
    for (const who of ['premium', 'admin'] as const) {
      expect((await send(ctx, 'PATCH', url(pub.slug, `/${secret.id}`), ctx.cookies[who], { body: 'rewritten' })).statusCode).toBe(404);
      expect((await send(ctx, 'DELETE', url(pub.slug, `/${secret.id}`), ctx.cookies[who])).statusCode).toBe(404);
    }
    expect((await row(ctx, 'select body, deleted_at from room_messages where id = $1', [secret.id]))[0]).toMatchObject({ body: 'premium-only text', deleted_at: null });
  });
});

describe('sending and reading messages', () => {
  it('creates a message authored by the signed-in user, without exposing private data', async () => {
    const room = await makeRoom(ctx);
    const res = await post(ctx, room.slug, ctx.cookies.free, { body: 'Gold looks bullish' });
    expect(res.statusCode).toBe(201);
    const m = res.json().message as Msg;
    expect(m).toMatchObject({ body: 'Gold looks bullish', roomId: room.id, deleted: false, editedAt: null, author: { id: ctx.users.free.id, displayName: 'free user', isStaff: false } });
    expect(typeof m.seq).toBe('number');
    expect(Number.isNaN(Date.parse(m.createdAt))).toBe(false);
    expect(res.body).not.toContain('free@example.com');
    expect(res.body).not.toContain('clientId');
    expect((await say(ctx, room.slug, ctx.cookies.moderator)).author.isStaff).toBe(true);
  });

  it('cannot impersonate another user: author fields in the payload are rejected', async () => {
    const room = await makeRoom(ctx);
    for (const extra of [{ authorId: ctx.users.admin.id }, { userId: ctx.users.admin.id }, { author: { id: ctx.users.admin.id } }, { seq: 1 }, { createdAt: '2020-01-01T00:00:00Z' }, { roomId: pub.id }]) {
      const res = await post(ctx, room.slug, ctx.cookies.free, { body: 'x', ...extra });
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
    }
    expect(await countRows(ctx, 'room_messages', 'room_id = $1', [room.id])).toBe(0);
    await say(ctx, room.slug, ctx.cookies.free);
    expect((await row<{ author_id: string }>(ctx, 'select author_id from room_messages where room_id = $1', [room.id]))[0]!.author_id).toBe(ctx.users.free.id);
  });

  it('normalises content: trims, unifies line breaks, strips spoofing characters, keeps emoji sequences', async () => {
    const room = await makeRoom(ctx);
    const family = '👨‍👩‍👧'; // contains zero-width joiners that must survive
    const m = await say(ctx, room.slug, ctx.cookies.free, `  line one\r\nline\u202E two\u200B ${family}\n\n\n\nend  `);
    expect(m.body).toBe(`line one\nline two ${family}\n\nend`);
  });

  it('stores markup as inert text: returned verbatim, as JSON, never as HTML', async () => {
    const room = await makeRoom(ctx);
    const xss = `<script>alert(1)</script><img src=x onerror=alert(1)> "quotes" & 'more' javascript:alert(1)`;
    const res = await post(ctx, room.slug, ctx.cookies.free, { body: xss });
    expect(res.json().message.body).toBe(xss);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const hist = await get(ctx, url(room.slug), ctx.cookies.premium);
    expect(hist.json().messages[0].body).toBe(xss);
    expect(hist.headers['content-type']).toMatch(/^application\/json/);
  });

  it.each([
    ['empty', { body: '' }], ['whitespace only', { body: '  \n\t ' }], ['only invisible characters', { body: '\u200B\u202E\u2060' }],
    ['too long', { body: 'a'.repeat(2001) }], ['absurdly long', { body: 'a'.repeat(200_000) }], ['control character', { body: 'bad\u0007char' }], ['null byte', { body: 'bad\u0000char' }],
    ['missing body', {}], ['body is a number', { body: 5 }], ['body is an object', { body: { $gt: '' } }], ['body is an array', { body: ['a'] }], ['invalid client id', { body: 'x', clientId: 'not-a-uuid' }],
  ])('rejects invalid content: %s', async (_label, payload) => {
    const room = await makeRoom(ctx);
    const res = await post(ctx, room.slug, ctx.cookies.free, payload);
    expect([400, 413]).toContain(res.statusCode);
    expect(await countRows(ctx, 'room_messages', 'room_id = $1', [room.id])).toBe(0);
  });

  it('counts characters, not bytes: 2000 emoji are accepted, 2001 are not', async () => {
    const room = await makeRoom(ctx);
    expect((await post(ctx, room.slug, ctx.cookies.free, { body: '😀'.repeat(2000) })).statusCode).toBe(201);
    expect((await post(ctx, room.slug, ctx.cookies.free, { body: '😀'.repeat(2001) })).statusCode).toBe(400);
    expect((await post(ctx, room.slug, ctx.cookies.free, { body: 'a'.repeat(2000) })).statusCode).toBe(201);
  });

  it('is idempotent for a retried send with the same client id', async () => {
    const room = await makeRoom(ctx);
    const clientId = '11111111-1111-4111-8111-111111111111';
    const first = await post(ctx, room.slug, ctx.cookies.free, { body: 'once', clientId });
    const again = await post(ctx, room.slug, ctx.cookies.free, { body: 'once', clientId });
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    expect(again.json().message.id).toBe(first.json().message.id);
    expect(await countRows(ctx, 'room_messages', 'room_id = $1', [room.id])).toBe(1);
    // The key is per author, and cannot be replayed into another room.
    expect((await post(ctx, room.slug, other, { body: 'other person', clientId })).statusCode).toBe(201);
    const elsewhere = await post(ctx, pub.slug, ctx.cookies.free, { body: 'once', clientId });
    expect(elsewhere.statusCode).toBe(409);
  });

  it('returns history oldest-to-newest, scoped to the room', async () => {
    const room = await makeRoom(ctx); const noise = await makeRoom(ctx);
    for (const t of ['one', 'two', 'three']) await say(ctx, room.slug, ctx.cookies.free, t);
    await say(ctx, noise.slug, ctx.cookies.free, 'different room');
    const res = await get(ctx, url(room.slug), ctx.cookies.premium);
    expect(res.json().messages.map((m: Msg) => m.body)).toEqual(['one', 'two', 'three']);
    expect(res.json()).toMatchObject({ hasMore: false, nextBefore: null });
    expect(res.body).not.toContain('different room');
  });

  it('shows an empty room as an empty list', async () => {
    const room = await makeRoom(ctx);
    expect((await get(ctx, url(room.slug), ctx.cookies.free)).json()).toEqual({ messages: [], hasMore: false, nextBefore: null });
  });

  it('paginates with a stable cursor: no gaps, no duplicates, correct order', async () => {
    const room = await makeRoom(ctx);
    const all: string[] = [];
    for (let i = 1; i <= 25; i++) { await say(ctx, room.slug, ctx.cookies.free, `m${i}`); all.push(`m${i}`); }
    const p1 = (await get(ctx, url(room.slug, '?limit=10'), ctx.cookies.free)).json();
    expect(p1.messages.map((m: Msg) => m.body)).toEqual(all.slice(15));
    expect(p1.hasMore).toBe(true);
    expect(p1.nextBefore).toBe(p1.messages[0].seq);
    const p2 = (await get(ctx, url(room.slug, `?limit=10&before=${p1.nextBefore}`), ctx.cookies.free)).json();
    expect(p2.messages.map((m: Msg) => m.body)).toEqual(all.slice(5, 15));
    expect(p2.hasMore).toBe(true);
    // A message arriving between page loads does not shift older pages.
    await say(ctx, room.slug, ctx.cookies.premium, 'late arrival');
    const p3 = (await get(ctx, url(room.slug, `?limit=10&before=${p2.nextBefore}`), ctx.cookies.free)).json();
    expect(p3.messages.map((m: Msg) => m.body)).toEqual(all.slice(0, 5));
    expect(p3).toMatchObject({ hasMore: false, nextBefore: null });
    expect(await get(ctx, url(room.slug, '?before=1'), ctx.cookies.free).then((r) => r.json().messages)).toEqual([]);
    const seqs = [...p3.messages, ...p2.messages, ...p1.messages].map((m: Msg) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('uses a default page size and bounds the limit', async () => {
    const room = await makeRoom(ctx);
    for (let i = 0; i < 32; i++) await say(ctx, room.slug, ctx.cookies.free, `d${i}`);
    expect((await get(ctx, url(room.slug), ctx.cookies.free)).json().messages).toHaveLength(30);
    for (const q of ['?limit=0', '?limit=101', '?limit=abc', '?before=0', '?before=-3', '?before=abc']) {
      expect((await get(ctx, url(room.slug, q), ctx.cookies.free)).statusCode, q).toBe(400);
    }
  });
});

describe('editing messages', () => {
  it('lets the author edit; the id and order stay, and the edit is marked', async () => {
    const room = await makeRoom(ctx);
    const m = await say(ctx, room.slug, ctx.cookies.free, 'original');
    const res = await send(ctx, 'PATCH', url(room.slug, `/${m.id}`), ctx.cookies.free, { body: '  fixed  \r\n text ' });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toMatchObject({ id: m.id, seq: m.seq, body: 'fixed\n text', author: { id: ctx.users.free.id } });
    expect(res.json().message.editedAt).toBeTruthy();
    expect((await get(ctx, url(room.slug), ctx.cookies.free)).json().messages[0].body).toBe('fixed\n text');
  });

  it('treats an unchanged body as a no-op (not marked edited)', async () => {
    const room = await makeRoom(ctx);
    const m = await say(ctx, room.slug, ctx.cookies.free, 'same');
    const res = await send(ctx, 'PATCH', url(room.slug, `/${m.id}`), ctx.cookies.free, { body: 'same' });
    expect(res.json().message.editedAt).toBeNull();
  });

  it('only the author may edit: other members, moderators and admins are refused', async () => {
    const room = await makeRoom(ctx);
    const m = await say(ctx, room.slug, ctx.cookies.free, 'mine');
    for (const cookie of [other, ctx.cookies.premium, ctx.cookies.moderator, ctx.cookies.admin]) {
      const res = await send(ctx, 'PATCH', url(room.slug, `/${m.id}`), cookie, { body: 'rewritten' });
      expect(res.statusCode).toBe(403);
    }
    expect((await row(ctx, 'select body, edited_at from room_messages where id = $1', [m.id]))[0]).toMatchObject({ body: 'mine', edited_at: null });
  });

  it('validates edits like new messages, and rejects attempts to change ownership or metadata', async () => {
    const room = await makeRoom(ctx);
    const m = await say(ctx, room.slug, ctx.cookies.free, 'keep');
    for (const payload of [{ body: '' }, { body: 'a'.repeat(2001) }, { body: 'x\u0007' }, {}, { body: 'ok', authorId: otherId }, { body: 'ok', deleted: true }, { body: 'ok', seq: 1 }]) {
      expect((await send(ctx, 'PATCH', url(room.slug, `/${m.id}`), ctx.cookies.free, payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await row<{ body: string; author_id: string }>(ctx, 'select body, author_id from room_messages where id = $1', [m.id]))[0]).toMatchObject({ body: 'keep', author_id: ctx.users.free.id });
  });

  it('returns 404 for unknown or malformed message ids and 409 when editing a deleted message', async () => {
    const room = await makeRoom(ctx);
    for (const id of ['nope', '00000000-0000-4000-8000-000000000000']) {
      expect((await send(ctx, 'PATCH', url(room.slug, `/${id}`), ctx.cookies.free, { body: 'x' })).statusCode).toBe(404);
      expect((await send(ctx, 'DELETE', url(room.slug, `/${id}`), ctx.cookies.free)).statusCode).toBe(404);
    }
    const m = await say(ctx, room.slug, ctx.cookies.free);
    await send(ctx, 'DELETE', url(room.slug, `/${m.id}`), ctx.cookies.free);
    expect((await send(ctx, 'PATCH', url(room.slug, `/${m.id}`), ctx.cookies.free, { body: 'back from the dead' })).statusCode).toBe(409);
  });
});

describe('deleting messages', () => {
  it('lets the author delete their own message; the content is wiped, not just hidden', async () => {
    const room = await makeRoom(ctx);
    const m = await say(ctx, room.slug, ctx.cookies.free, 'regret this');
    const res = await send(ctx, 'DELETE', url(room.slug, `/${m.id}`), ctx.cookies.free);
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toMatchObject({ id: m.id, deleted: true, body: null });
    expect((await row(ctx, 'select body, deleted_at, deleted_by from room_messages where id = $1', [m.id]))[0]).toMatchObject({ body: '', deleted_by: ctx.users.free.id });
    const hist = await get(ctx, url(room.slug), ctx.cookies.premium);
    expect(hist.json().messages[0]).toMatchObject({ id: m.id, deleted: true, body: null });
    expect(hist.body).not.toContain('regret this');
    expect(await countRows(ctx, 'audit_log', "action = 'message.deleted' and entity_id = $1", [m.id])).toBe(0);
  });

  it('refuses other members, and lets moderators and admins remove anyone\'s message with an audit trail', async () => {
    const room = await makeRoom(ctx);
    const m = await say(ctx, room.slug, ctx.cookies.free, 'rude message');
    for (const cookie of [other, ctx.cookies.premium]) expect((await send(ctx, 'DELETE', url(room.slug, `/${m.id}`), cookie)).statusCode).toBe(403);
    expect((await row(ctx, 'select deleted_at from room_messages where id = $1', [m.id]))[0]).toMatchObject({ deleted_at: null });

    expect((await send(ctx, 'DELETE', url(room.slug, `/${m.id}`), ctx.cookies.moderator)).statusCode).toBe(200);
    const m2 = await say(ctx, room.slug, ctx.cookies.premium, 'another');
    expect((await send(ctx, 'DELETE', url(room.slug, `/${m2.id}`), ctx.cookies.admin)).statusCode).toBe(200);
    const log = await row<{ actor_id: string; data: { authorId: string } }>(ctx, "select actor_id, data from audit_log where action = 'message.deleted' and entity_id = $1", [m.id]);
    expect(log).toHaveLength(1);
    expect(log[0]!.actor_id).toBe(ctx.users.moderator.id);
    expect(log[0]!.data.authorId).toBe(ctx.users.free.id);
  });

  it('is idempotent: deleting twice changes nothing and audits once', async () => {
    const room = await makeRoom(ctx);
    const m = await say(ctx, room.slug, ctx.cookies.free);
    await send(ctx, 'DELETE', url(room.slug, `/${m.id}`), ctx.cookies.moderator);
    const again = await send(ctx, 'DELETE', url(room.slug, `/${m.id}`), ctx.cookies.admin);
    expect(again.statusCode).toBe(200);
    expect(again.json().message.deleted).toBe(true);
    expect(await countRows(ctx, 'audit_log', "action = 'message.deleted' and entity_id = $1", [m.id])).toBe(1);
  });

  it('a demoted moderator loses the power to delete others\' messages immediately', async () => {
    const room = await makeRoom(ctx);
    const mod = await seedUser(ctx.db, 'free', 'demoted-chat@example.com');
    await send(ctx, 'PATCH', `/api/admin/users/${mod.id}/role`, ctx.cookies.admin, { role: 'moderator' });
    const cookie = await loginCookie(ctx.app, 'demoted-chat@example.com');
    const m = await say(ctx, room.slug, ctx.cookies.free);
    await send(ctx, 'PATCH', `/api/admin/users/${mod.id}/role`, ctx.cookies.admin, { role: 'free' });
    expect((await send(ctx, 'DELETE', url(room.slug, `/${m.id}`), cookie)).statusCode).toBe(403);
  });
});

describe('write rate limit', () => {
  it('limits sends, edits and deletes per user, per window, and tells the client when to retry', async () => {
    const own = await setup({ CHAT_WRITES_PER_MINUTE: '3' });
    const room = await makeRoom(own);
    const a = own.cookies.free; const b = own.cookies.premium;
    const m = await say(own, room.slug, a, 'one');
    expect((await send(own, 'PATCH', url(room.slug, `/${m.id}`), a, { body: 'two' })).statusCode).toBe(200);
    expect((await post(own, room.slug, a, { body: 'three' })).statusCode).toBe(201);
    const blocked = await post(own, room.slug, a, { body: 'four' });
    expect(blocked.statusCode).toBe(429);
    expect(code(blocked)).toBe('RATE_LIMITED');
    expect(blocked.json().error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect((await send(own, 'DELETE', url(room.slug, `/${m.id}`), a)).statusCode).toBe(429);
    expect(await countRows(own, 'room_messages', 'room_id = $1', [room.id])).toBe(2);
    expect((await post(own, room.slug, b, { body: 'someone else is fine' })).statusCode).toBe(201); // per user
    expect((await get(own, url(room.slug), a)).statusCode).toBe(200); // reading is not throttled by this limiter
    own.clock.advanceMs(61_000);
    expect((await post(own, room.slug, a, { body: 'after the window' })).statusCode).toBe(201);
  });
});
