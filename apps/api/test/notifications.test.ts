import { beforeAll, describe, expect, it } from 'vitest';
import { createUser } from '../src/db/repos.js';
import { EventBus } from '../src/events.js';
import { startSweeper } from '../src/notifications/sweeper.js';
import { countRows, get, loginCookie, row, seedUser, send, setup, type Ctx } from './helpers.js';

interface N { id: string; seq: number; category: string; type: string; title: string; body: string; data: Record<string, unknown>; createdAt: string; readAt: string | null }
interface Page { notifications: N[]; hasMore: boolean; nextBefore: number | null; unread: number; byCategory: Record<string, number> }

const list = async (ctx: Ctx, cookie: string, qs = '') => (await get(ctx, `/api/notifications${qs}`, cookie)).json() as Page;
const mk = (ctx: Ctx, userId: string, over: Record<string, unknown> = {}) =>
  ctx.app.notifications.create({ userId, category: 'signal', type: 'signal.published', title: 'A title', body: 'A body', ...over } as never);
const code = (r: { json: () => { error: { code: string } } }) => r.json().error.code;

let ctx: Ctx; let otherCookie: string; let otherId: string;
beforeAll(async () => {
  ctx = await setup({ NOTIFICATION_SWEEP_MS: '0' });
  const u = await seedUser(ctx.db, 'free', 'other@example.com'); otherId = u.id;
  otherCookie = await loginCookie(ctx.app, 'other@example.com');
});

// ------------------------------------------------------------------------------------------------ creation and de-duplication
describe('creating notifications', () => {
  it('stores a notification for exactly one user, unread, with its content', async () => {
    const n = (await mk(ctx, otherId, { category: 'payment', type: 'payment.succeeded', title: 'Payment received', body: 'KES 10', data: { paymentId: 'p-1' }, dedupeKey: 'c-1' }))!;
    expect(n).toMatchObject({ user_id: otherId, category: 'payment', type: 'payment.succeeded', title: 'Payment received', body: 'KES 10', data: { paymentId: 'p-1' }, read_at: null });
    expect(typeof n.seq).toBe('number');
    expect(await countRows(ctx, 'notifications', 'dedupe_key = $1', ['c-1'])).toBe(1);
  });

  it('never creates the same event twice for the same user, but does for different users', async () => {
    const key = 'dup-1';
    expect(await mk(ctx, otherId, { dedupeKey: key })).not.toBeNull();
    expect(await mk(ctx, otherId, { dedupeKey: key })).toBeNull();
    expect(await mk(ctx, otherId, { dedupeKey: key, title: 'Different text, same event' })).toBeNull();
    expect(await mk(ctx, ctx.users.free.id, { dedupeKey: key })).not.toBeNull(); // same key, another person
    expect(await countRows(ctx, 'notifications', 'dedupe_key = $1', [key])).toBe(2);
  });

  it('is safe under simultaneous identical events: exactly one row', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => mk(ctx, otherId, { dedupeKey: 'race-1' })));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await countRows(ctx, 'notifications', "dedupe_key = 'race-1'")).toBe(1);
  });

  it('does not de-duplicate notifications that carry no key', async () => {
    await mk(ctx, otherId, { title: 'no-key' }); await mk(ctx, otherId, { title: 'no-key' });
    expect(await countRows(ctx, 'notifications', "title = 'no-key'")).toBe(2);
  });

  it('refuses an unknown category at the database level', async () => {
    await expect(ctx.db.query("insert into notifications (id, user_id, category, type, title) values (gen_random_uuid(), $1, 'spam', 'x', 'x')", [otherId])).rejects.toThrow();
  });

  it('fan-out fills in only the missing recipients when run again, and chunks large audiences', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await seedUser(ctx.db, 'free', `fan${i}@example.com`)).id);
    const content = { category: 'signal' as const, type: 'signal.published', title: 'Fan-out', body: 'x' };
    await ctx.app.notifications.notifyMany([ids[0]!], content, 'fan-1');
    await ctx.app.notifications.notifyMany(ids, content, 'fan-1'); // re-run with everyone
    await ctx.app.notifications.notifyMany(ids, content, 'fan-1'); // and again
    expect(await countRows(ctx, 'notifications', "dedupe_key = 'fan-1'")).toBe(3);
    await ctx.app.notifications.notifyMany([], content, 'fan-1'); // empty audience is a no-op
  });

  it('delivers to every member of an audience larger than one insert batch', async () => {
    const own = await setup({ NOTIFICATION_SWEEP_MS: '0' });
    const hash = (await own.db.query<{ password_hash: string }>('select password_hash from users limit 1')).rows[0]!.password_hash;
    const ids: string[] = [];
    for (let i = 0; i < 1203; i++) ids.push((await createUser(own.db, { email: `bulk${i}@example.com`, displayName: `Bulk ${i}`, passwordHash: hash, role: 'free' })).id);
    await own.app.notifications.notifyMany(ids, { category: 'announcement', type: 'announcement.published', title: 'Bulk', body: 'x' }, 'bulk-1');
    expect(await countRows(own, 'notifications', "dedupe_key = 'bulk-1'")).toBe(1203);
    await own.app.notifications.notifyMany(ids, { category: 'announcement', type: 'announcement.published', title: 'Bulk', body: 'x' }, 'bulk-1');
    expect(await countRows(own, 'notifications', "dedupe_key = 'bulk-1'")).toBe(1203);
  }, 60_000);
});

// ------------------------------------------------------------------------------------------------ ownership
describe('users only reach their own notifications', () => {
  it('requires sign-in on every endpoint', async () => {
    const mine = (await mk(ctx, ctx.users.premium.id))!;
    for (const [method, url] of [['GET', '/api/notifications'], ['GET', '/api/notifications/unread-count'], ['POST', '/api/notifications/read-all'], ['POST', `/api/notifications/${mine.id}/read`]] as const) {
      const res = method === 'GET' ? await get(ctx, url) : await send(ctx, 'POST', url);
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    expect((await row(ctx, 'select read_at from notifications where id = $1', [mine.id]))[0]).toMatchObject({ read_at: null });
  });

  it('lists, counts and marks only the signed-in user\'s own notifications', async () => {
    const a = await seedUser(ctx.db, 'free', 'owner-a@example.com'); const b = await seedUser(ctx.db, 'free', 'owner-b@example.com');
    const ca = await loginCookie(ctx.app, 'owner-a@example.com'); const cb = await loginCookie(ctx.app, 'owner-b@example.com');
    await mk(ctx, a.id, { title: 'for A 1' }); await mk(ctx, a.id, { title: 'for A 2' }); await mk(ctx, b.id, { title: 'for B' });

    const pa = await list(ctx, ca); const pb = await list(ctx, cb);
    expect(pa.notifications.map((n) => n.title).sort()).toEqual(['for A 1', 'for A 2']);
    expect(pb.notifications.map((n) => n.title)).toEqual(['for B']);
    expect([pa.unread, pb.unread]).toEqual([2, 1]);
    expect((await get(ctx, '/api/notifications/unread-count', cb)).json().unread).toBe(1);

    await send(ctx, 'POST', '/api/notifications/read-all', ca);
    expect((await list(ctx, ca)).unread).toBe(0);
    expect((await list(ctx, cb)).unread).toBe(1); // B untouched
  });

  it('treats someone else\'s notification exactly like a missing one', async () => {
    const theirs = (await mk(ctx, ctx.users.premium.id, { title: 'private to premium' }))!;
    const res = await send(ctx, 'POST', `/api/notifications/${theirs.id}/read`, ctx.cookies.free);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('private to premium');
    for (const id of ['nope', '00000000-0000-4000-8000-000000000000']) expect((await send(ctx, 'POST', `/api/notifications/${id}/read`, ctx.cookies.free)).statusCode).toBe(404);
    expect((await row(ctx, 'select read_at from notifications where id = $1', [theirs.id]))[0]).toMatchObject({ read_at: null });
  });

  it('accepts no user id from the client, so another member cannot be targeted through parameters', async () => {
    await mk(ctx, ctx.users.premium.id, { title: 'premium-only item' });
    for (const qs of [`?userId=${ctx.users.premium.id}`, `?user_id=${ctx.users.premium.id}`]) {
      const p = await list(ctx, otherCookie, qs);
      expect(JSON.stringify(p)).not.toContain('premium-only item');
    }
    const res = await send(ctx, 'POST', '/api/notifications/read-all', otherCookie, { userId: ctx.users.premium.id });
    expect(res.statusCode).toBe(400); // strict body: unknown fields rejected
  });

  it('exposes only whitelisted fields', async () => {
    await mk(ctx, ctx.users.admin.id, { dedupeKey: 'secret-key-xyz', data: { signalId: 's-1' } });
    const res = await get(ctx, '/api/notifications', ctx.cookies.admin);
    expect(res.body).not.toContain('secret-key-xyz');
    expect(res.body).not.toContain('dedupe');
    expect(res.body).not.toContain('user_id');
    expect(Object.keys(res.json().notifications[0]).sort()).toEqual(['body', 'category', 'createdAt', 'data', 'id', 'readAt', 'seq', 'title', 'type']);
  });

  it('refuses a suspended account like every other request', async () => {
    const u = await seedUser(ctx.db, 'free', 'to-suspend@example.com');
    const cookie = await loginCookie(ctx.app, 'to-suspend@example.com');
    await send(ctx, 'POST', `/api/admin/users/${u.id}/restrictions`, ctx.cookies.admin, { type: 'suspended', reason: 'Testing suspension' });
    const res = await get(ctx, '/api/notifications', cookie);
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe('ACCOUNT_SUSPENDED');
  });
});

// ------------------------------------------------------------------------------------------------ retrieval and pagination
describe('retrieval and pagination', () => {
  let cookie: string; let userId: string;
  beforeAll(async () => {
    const u = await seedUser(ctx.db, 'free', 'pager@example.com'); userId = u.id;
    cookie = await loginCookie(ctx.app, 'pager@example.com');
    for (let i = 1; i <= 25; i++) await mk(ctx, userId, { title: `n${i}`, category: i % 2 ? 'signal' : 'payment', dedupeKey: `pg-${i}` });
  });

  it('returns newest first, 20 by default, with a cursor to the next page', async () => {
    const p = await list(ctx, cookie);
    expect(p.notifications).toHaveLength(20);
    expect(p.notifications[0]!.title).toBe('n25');
    expect(p.hasMore).toBe(true);
    expect(p.nextBefore).toBe(p.notifications[19]!.seq);
  });

  it('pages through everything with no gaps or duplicates, even when new ones arrive between pages', async () => {
    const seen: string[] = [];
    let before: number | null = null;
    for (let i = 0; i < 10; i++) {
      const p: Page = await list(ctx, cookie, `?limit=7${before ? `&before=${before}` : ''}`);
      seen.push(...p.notifications.map((n) => n.title));
      if (i === 0) await mk(ctx, userId, { title: 'arrived mid-paging' }); // must not shift older pages
      if (!p.hasMore) { expect(p.nextBefore).toBeNull(); break; }
      before = p.nextBefore;
    }
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => `n${25 - i}`));
    expect(new Set(seen).size).toBe(25);
    expect(seen).not.toContain('arrived mid-paging');
  });

  it('returns an empty page past the end, and for a user with nothing', async () => {
    expect((await list(ctx, cookie, '?before=1')).notifications).toEqual([]);
    const fresh = await seedUser(ctx.db, 'free', 'nothing@example.com');
    expect(fresh.id).toBeTruthy();
    const empty = await list(ctx, await loginCookie(ctx.app, 'nothing@example.com'));
    expect(empty).toMatchObject({ notifications: [], hasMore: false, nextBefore: null, unread: 0 });
  });

  it('filters by category and by unread, and combines them', async () => {
    const payments = await list(ctx, cookie, '?category=payment&limit=50');
    expect(payments.notifications.every((n) => n.category === 'payment')).toBe(true);
    expect(payments.notifications).toHaveLength(12);
    const one = payments.notifications[0]!;
    await send(ctx, 'POST', `/api/notifications/${one.id}/read`, cookie);
    const unreadPayments = await list(ctx, cookie, '?category=payment&unread=true&limit=50');
    expect(unreadPayments.notifications).toHaveLength(11);
    expect(unreadPayments.notifications.some((n) => n.id === one.id)).toBe(false);
    expect((await list(ctx, cookie, '?unread=false&category=payment&limit=50')).notifications).toHaveLength(12); // "false" does not filter
  });

  it('validates query parameters', async () => {
    for (const qs of ['?limit=0', '?limit=51', '?limit=abc', '?before=0', '?before=-1', '?before=abc', '?category=memes', '?unread=maybe']) {
      expect((await get(ctx, `/api/notifications${qs}`, cookie)).statusCode, qs).toBe(400);
    }
  });
});

// ------------------------------------------------------------------------------------------------ unread counts and read state
describe('unread counts and read state', () => {
  const fresh = async (email: string) => {
    const u = await seedUser(ctx.db, 'free', email);
    return { id: u.id, cookie: await loginCookie(ctx.app, email) };
  };

  it('counts unread overall and per category, with every category present', async () => {
    const u = await fresh('counts@example.com');
    await mk(ctx, u.id, { category: 'signal' }); await mk(ctx, u.id, { category: 'signal' }); await mk(ctx, u.id, { category: 'payment' });
    const c = (await get(ctx, '/api/notifications/unread-count', u.cookie)).json();
    expect(c).toEqual({ unread: 3, byCategory: { signal: 2, subscription: 0, payment: 1, community: 0, announcement: 0 } });
  });

  it('marks one read: the count drops, the first read time is kept, and repeating it changes nothing', async () => {
    const own = await setup({ NOTIFICATION_SWEEP_MS: '0' });
    const n = (await own.app.notifications.create({ userId: own.users.free.id, category: 'signal', type: 't', title: 'x' }))!;
    const first = await send(own, 'POST', `/api/notifications/${n.id}/read`, own.cookies.free);
    expect(first.statusCode).toBe(200);
    expect(first.json().notification.readAt).toBeTruthy();
    expect(first.json().unread).toBe(0);
    own.clock.advanceMs(60_000);
    const again = await send(own, 'POST', `/api/notifications/${n.id}/read`, own.cookies.free);
    expect(again.statusCode).toBe(200);
    expect(again.json().notification.readAt).toBe(first.json().notification.readAt);
  });

  it('marks everything read, or just one category, and reports how many changed', async () => {
    const u = await fresh('readall@example.com');
    for (const category of ['signal', 'signal', 'payment', 'community']) await mk(ctx, u.id, { category });
    const some = await send(ctx, 'POST', '/api/notifications/read-all', u.cookie, { category: 'signal' });
    expect(some.json()).toMatchObject({ updated: 2, unread: 2, byCategory: { signal: 0, payment: 1, community: 1 } });
    const rest = await send(ctx, 'POST', '/api/notifications/read-all', u.cookie);
    expect(rest.json()).toMatchObject({ updated: 2, unread: 0 });
    expect((await send(ctx, 'POST', '/api/notifications/read-all', u.cookie)).json().updated).toBe(0); // nothing left
    expect((await list(ctx, u.cookie)).notifications.every((n) => n.readAt !== null)).toBe(true);
  });

  it('shows the count on every page of the list, and rejects an invalid category to read-all', async () => {
    const u = await fresh('listcount@example.com');
    await mk(ctx, u.id); await mk(ctx, u.id);
    expect((await list(ctx, u.cookie)).unread).toBe(2);
    expect((await send(ctx, 'POST', '/api/notifications/read-all', u.cookie, { category: 'memes' })).statusCode).toBe(400);
  });

  it('keeps read notifications in the list (reading hides nothing)', async () => {
    const u = await fresh('keep@example.com');
    const n = (await mk(ctx, u.id, { title: 'stays' }))!;
    await send(ctx, 'POST', `/api/notifications/${n.id}/read`, u.cookie);
    const p = await list(ctx, u.cookie);
    expect(p.notifications.map((x) => x.title)).toEqual(['stays']);
    expect(p.notifications[0]!.readAt).toBeTruthy();
    expect(p.unread).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------ announcements
describe('administrator announcements', () => {
  const announce = (cookie: string | undefined, body: unknown) => send(ctx, 'POST', '/api/admin/announcements', cookie, body);
  const valid = (over: Record<string, unknown> = {}) => ({ title: 'Scheduled maintenance', body: 'We will be offline on Sunday.', ...over });
  const setPrefs = (userId: string, prefs: object) => ctx.db.query('update users set notification_prefs = $2::jsonb where id = $1', [userId, JSON.stringify(prefs)]);

  it('is for administrators only', async () => {
    const before = await countRows(ctx, 'announcements');
    expect((await announce(undefined, valid())).statusCode).toBe(401);
    for (const who of ['free', 'premium', 'moderator'] as const) expect((await announce(ctx.cookies[who], valid())).statusCode, who).toBe(403);
    expect((await get(ctx, '/api/admin/announcements', ctx.cookies.moderator)).statusCode).toBe(403);
    expect(await countRows(ctx, 'announcements')).toBe(before);
  });

  it('reaches only members who opted in, unless it is marked important', async () => {
    await setPrefs(ctx.users.premium.id, { newSignals: true, signalUpdates: true, announcements: true });
    await setPrefs(ctx.users.free.id, { newSignals: true, signalUpdates: true, announcements: false });
    const res = await announce(ctx.cookies.admin, valid({ title: 'Opt-in only news' }));
    expect(res.statusCode).toBe(201);
    const { announcement, recipients } = res.json();
    expect(announcement).toMatchObject({ title: 'Opt-in only news', important: false, recipients });
    const got = await row<{ user_id: string }>(ctx, "select user_id from notifications where dedupe_key = $1", [`announcement:${announcement.id}`]);
    expect(got.map((g) => g.user_id)).toContain(ctx.users.premium.id);
    expect(got.map((g) => g.user_id)).not.toContain(ctx.users.free.id);
    expect(got).toHaveLength(recipients);
    const mine = (await list(ctx, ctx.cookies.premium, '?category=announcement')).notifications[0]!;
    expect(mine).toMatchObject({ category: 'announcement', type: 'announcement.published', title: 'Opt-in only news', body: 'We will be offline on Sunday.', data: { announcementId: announcement.id, important: false } });
    expect((await list(ctx, ctx.cookies.free, '?category=announcement')).notifications.some((n) => n.title === 'Opt-in only news')).toBe(false);
  });

  it('reaches everyone when important, even members who opted out', async () => {
    await setPrefs(ctx.users.free.id, { newSignals: false, signalUpdates: false, announcements: false });
    const res = await announce(ctx.cookies.admin, valid({ title: 'Security notice', important: true }));
    const total = await countRows(ctx, 'users');
    expect(res.json().recipients).toBe(total);
    expect((await list(ctx, ctx.cookies.free, '?category=announcement')).notifications.some((n) => n.title === 'Security notice')).toBe(true);
  });

  it('does not announce twice for a double submit with the same idempotency key', async () => {
    const clientId = '22222222-2222-4222-8222-222222222222';
    const first = await announce(ctx.cookies.admin, valid({ title: 'Once only', important: true, clientId }));
    const again = await announce(ctx.cookies.admin, valid({ title: 'Once only', important: true, clientId }));
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    expect(again.json().announcement.id).toBe(first.json().announcement.id);
    expect(again.json().recipients).toBe(first.json().recipients);
    expect(await countRows(ctx, 'announcements', "title = 'Once only'")).toBe(1);
    expect(await countRows(ctx, 'notifications', "title = 'Once only' and user_id = $1", [ctx.users.premium.id])).toBe(1);
    // The key belongs to the administrator who used it.
    const other = await seedUser(ctx.db, 'admin', 'admin-b@example.com');
    expect(other.id).toBeTruthy();
    const second = await announce(await loginCookie(ctx.app, 'admin-b@example.com'), valid({ title: 'Once only B', important: true, clientId }));
    expect(second.statusCode).toBe(201);
  });

  it('sends two separate announcements when asked twice without a key (each is its own event)', async () => {
    await announce(ctx.cookies.admin, valid({ title: 'Twice A', important: true }));
    await announce(ctx.cookies.admin, valid({ title: 'Twice A', important: true }));
    expect(await countRows(ctx, 'announcements', "title = 'Twice A'")).toBe(2);
    expect(await countRows(ctx, 'notifications', "title = 'Twice A' and user_id = $1", [ctx.users.premium.id])).toBe(2);
  });

  it('records the announcement in the audit log and lists them newest first', async () => {
    const res = await announce(ctx.cookies.admin, valid({ title: 'Audited news', important: true }));
    const [log] = await row<{ actor_id: string; data: { recipients: number; important: boolean } }>(ctx, "select actor_id, data from audit_log where action = 'announcement.published' and entity_id = $1", [res.json().announcement.id]);
    expect(log).toMatchObject({ actor_id: ctx.users.admin.id, data: { important: true, recipients: res.json().recipients } });
    ctx.clock.advanceMs(1000);
    await announce(ctx.cookies.admin, valid({ title: 'Latest news', important: true }));
    const listed = (await get(ctx, '/api/admin/announcements', ctx.cookies.admin)).json().announcements as { title: string; recipients: number }[];
    expect(listed[0]!.title).toBe('Latest news');
    expect(listed.map((a) => a.title)).toContain('Audited news');
  });

  it.each([
    ['title too short', { title: 'ab' }], ['title too long', { title: 'x'.repeat(121) }], ['missing title', { title: undefined }], ['empty body', { body: '   ' }],
    ['body too long', { body: 'x'.repeat(1001) }], ['control characters', { title: 'bad\u0007title' }], ['important not a boolean', { important: 'yes' }],
    ['recipients supplied', { recipients: 5 }], ['author supplied', { createdBy: '00000000-0000-4000-8000-000000000000' }], ['invalid key', { clientId: 'nope' }],
  ])('rejects invalid input: %s', async (_l, over) => {
    const before = await countRows(ctx, 'announcements');
    expect((await announce(ctx.cookies.admin, valid(over))).statusCode).toBe(400);
    expect(await countRows(ctx, 'announcements')).toBe(before);
  });

  it('strips invisible spoofing characters from announcement text', async () => {
    const res = await announce(ctx.cookies.admin, valid({ title: 'Clean\u202E title\u200B', important: true }));
    expect(res.json().announcement.title).toBe('Clean title');
  });
});

// ------------------------------------------------------------------------------------------------ event bus and timer
describe('event bus', () => {
  it('runs every listener, isolates failures, and never throws into the caller', async () => {
    const errors: unknown[] = [];
    const bus = new EventBus({ error: (...a: unknown[]) => { errors.push(a); } } as never);
    const seen: string[] = [];
    bus.on('signal.published', () => { seen.push('first'); });
    bus.on('signal.published', () => { throw new Error('listener broke'); });
    bus.on('signal.published', async () => { seen.push('third'); });
    await expect(bus.emit('signal.published', { signalId: 's', asset: 'X', direction: 'buy', timeframe: 'H1', visibility: 'free', actorId: 'a' })).resolves.toBeUndefined();
    expect(seen).toEqual(['first', 'third']);
    expect(errors).toHaveLength(1);
  });

  it('emitAll announces in order, and events nobody listens to are harmless', async () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on('payment.failed', (e) => { order.push(`failed:${e.paymentId}`); });
    bus.on('payment.succeeded', (e) => { order.push(`ok:${e.paymentId}`); });
    const base = { userId: 'u', amountMinor: 1, currency: 'KES', planName: 'P' };
    await bus.emitAll([
      { type: 'payment.failed', payload: { ...base, paymentId: '1', reason: null } },
      { type: 'payment.succeeded', payload: { ...base, paymentId: '2' } },
      { type: 'moderation.report_closed', payload: { reportId: 'r', outcome: 'dismissed' } },
    ]);
    expect(order).toEqual(['failed:1', 'ok:2']);
  });
});

describe('the sweep timer', () => {
  const log = { error: () => undefined };
  it('does nothing when switched off', async () => {
    let calls = 0;
    const stop = startSweeper({ sweepSubscriptions: async () => { calls += 1; return { expiring: 0, grace: 0, expired: 0 }; } }, 0, log);
    await new Promise((r) => setTimeout(r, 60));
    stop();
    expect(calls).toBe(0);
  });

  it('runs repeatedly, never overlaps itself, survives a failing sweep, and stops when told', async () => {
    let calls = 0; let active = 0; let maxActive = 0;
    const errors: unknown[] = [];
    const stop = startSweeper({
      sweepSubscriptions: async () => {
        calls += 1; active += 1; maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 40));
        active -= 1;
        if (calls === 2) throw new Error('database blip');
        return { expiring: 0, grace: 0, expired: 0 };
      },
    }, 15, { error: (...a: unknown[]) => { errors.push(a); } });
    await new Promise((r) => setTimeout(r, 400));
    stop();
    const stopped = calls;
    await new Promise((r) => setTimeout(r, 100));
    expect(stopped).toBeGreaterThanOrEqual(3);
    expect(maxActive).toBe(1);
    expect(errors).toHaveLength(1);
    expect(calls).toBe(stopped); // really stopped
  });
});
