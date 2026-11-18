import { beforeAll, describe, expect, it } from 'vitest';
import { can } from '../src/auth/access.js';
import { loginCookie, seedUser, get, send, setup, countRows, row, type Ctx } from './helpers.js';

const GUIDE = 'SECRET-GUIDELINES members only: be kind';
let n = 0;
const payload = (over: Record<string, unknown> = {}) => {
  n += 1;
  return { name: `Room number ${n}`, slug: `room-number-${n}`, description: 'A place to talk', guidelines: GUIDE, category: 'general_discussion', ...over };
};

let ctx: Ctx;
beforeAll(async () => { ctx = await setup(); });

const mk = async (over: Record<string, unknown> = {}, as: 'admin' | 'moderator' = 'admin') => {
  const res = await send(ctx, 'POST', '/api/staff/rooms', ctx.cookies[as], payload(over));
  if (res.statusCode !== 201) throw new Error(`create failed: ${res.statusCode} ${res.body}`);
  return res.json().room as { id: string; slug: string; [k: string]: unknown };
};
const mkPremium = (over: Record<string, unknown> = {}) => mk({ access: 'premium', ...over });
const errCode = (r: { json: () => { error: { code: string } } }) => r.json().error.code;

describe('capability registry', () => {
  const ent = (caps: string[]) => ({ tier: 'x', capabilities: caps }) as never;
  it('premium subscribers and staff may enter premium rooms; free members and visitors may not', () => {
    expect(can({ role: 'free', entitlement: ent(['premium_community']) }, 'premium_community')).toBe(true);
    expect(can({ role: 'free', entitlement: ent([]) }, 'premium_community')).toBe(false);
    expect(can({ role: 'moderator', entitlement: ent([]) }, 'premium_community')).toBe(true);
    expect(can({ role: 'admin', entitlement: ent([]) }, 'premium_community')).toBe(true);
    expect(can(null, 'premium_community')).toBe(false);
  });
});

describe('database invariants', () => {
  it('rejects a public premium_community room even when the API is bypassed', async () => {
    const insert = ctx.db.query(
      `insert into community_rooms (id, slug, name, description, category, access, created_by) values (gen_random_uuid(), 'bypass-room', 'Bypass room', 'x', 'premium_community', 'public', $1)`,
      [ctx.users.admin.id],
    );
    await expect(insert).rejects.toThrow();
  });
});

describe('management is staff-only (server-side)', () => {
  it('rejects visitors with 401 and free/premium members with 403 on every management endpoint', async () => {
    const room = await mk();
    const before = await countRows(ctx, 'community_rooms');
    const calls: [string, string, unknown?][] = [
      ['GET', '/api/staff/rooms'], ['GET', `/api/staff/rooms/${room.id}`], ['POST', '/api/staff/rooms', payload()],
      ['PATCH', `/api/staff/rooms/${room.id}`, { name: 'Hijacked room' }], ['POST', `/api/staff/rooms/${room.id}/archive`], ['POST', `/api/staff/rooms/${room.id}/restore`],
    ];
    for (const [method, url, body] of calls) {
      const m = method as 'GET' | 'POST' | 'PATCH';
      const visitor = m === 'GET' ? await get(ctx, url) : await send(ctx, m, url, undefined, body);
      expect(visitor.statusCode, `${method} ${url} visitor`).toBe(401);
      for (const who of ['free', 'premium'] as const) {
        const res = m === 'GET' ? await get(ctx, url, ctx.cookies[who]) : await send(ctx, m, url, ctx.cookies[who], body);
        expect(res.statusCode, `${method} ${url} ${who}`).toBe(403);
      }
    }
    expect(await countRows(ctx, 'community_rooms')).toBe(before);
    const after = await get(ctx, `/api/staff/rooms/${room.id}`, ctx.cookies.admin);
    expect(after.json().room.name).toBe(room.name);
    expect(after.json().room.archivedAt).toBeNull();
  });

  it('a moderator who is demoted loses management access immediately', async () => {
    const mod = await seedUser(ctx.db, 'free', 'demote-me@example.com');
    await send(ctx, 'PATCH', `/api/admin/users/${mod.id}/role`, ctx.cookies.admin, { role: 'moderator' });
    const cookie = await loginCookie(ctx.app, 'demote-me@example.com');
    expect((await get(ctx, '/api/staff/rooms', cookie)).statusCode).toBe(200);
    await send(ctx, 'PATCH', `/api/admin/users/${mod.id}/role`, ctx.cookies.admin, { role: 'free' });
    expect((await get(ctx, '/api/staff/rooms', cookie)).statusCode).toBe(403);
  });
});

describe('creating rooms', () => {
  it.each(['admin', 'moderator'] as const)('%s can create a room, and the action is audited', async (who) => {
    const body = payload({ category: 'market_analysis', sortOrder: 7 });
    const res = await send(ctx, 'POST', '/api/staff/rooms', ctx.cookies[who], body);
    expect(res.statusCode).toBe(201);
    const room = res.json().room;
    expect(room).toMatchObject({ slug: body.slug, name: body.name, category: 'market_analysis', access: 'public', locked: false, sortOrder: 7, archivedAt: null, guidelines: GUIDE });
    const [stored] = await row<{ created_by: string }>(ctx, 'select created_by from community_rooms where id = $1', [room.id]);
    expect(stored!.created_by).toBe(ctx.users[who].id);
    const log = await row<{ actor_id: string; data: { slug: string } }>(ctx, "select actor_id, data from audit_log where action = 'room.created' and entity_id = $1", [room.id]);
    expect(log).toHaveLength(1);
    expect(log[0]!.actor_id).toBe(ctx.users[who].id);
  });

  it('derives the URL name from the room name when none is given', async () => {
    const res = await send(ctx, 'POST', '/api/staff/rooms', ctx.cookies.admin, { name: 'Gold & Silver: Café Talk!', description: 'd', category: 'trading_discussion' });
    expect(res.statusCode).toBe(201);
    expect(res.json().room.slug).toBe('gold-silver-cafe-talk');
  });

  it('defaults a premium_community room to premium access', async () => {
    const room = await mk({ category: 'premium_community' });
    expect(room.access).toBe('premium');
  });

  it('allows premium access on any category', async () => {
    expect((await mk({ category: 'market_analysis', access: 'premium' })).access).toBe('premium');
  });

  it.each([
    ['name too short', { name: 'ab' }, 'name'],
    ['name missing', { name: undefined }, 'name'],
    ['name with control characters', { name: 'Bad\u0007name' }, 'name'],
    ['description empty', { description: '   ' }, 'description'],
    ['description too long', { description: 'x'.repeat(301) }, 'description'],
    ['guidelines too long', { guidelines: 'x'.repeat(2001) }, 'guidelines'],
    ['unknown category', { category: 'memes' }, 'category'],
    ['unknown access', { access: 'vip' }, 'access'],
    ['premium_community room set public', { category: 'premium_community', access: 'public' }, 'access'],
    ['slug with spaces', { slug: 'not valid' }, 'slug'],
    ['slug with uppercase symbols', { slug: 'Bad_Slug!' }, 'slug'],
    ['slug too short', { slug: 'ab' }, 'slug'],
    ['sort order out of range', { sortOrder: 5000 }, 'sortOrder'],
    ['sort order not an integer', { sortOrder: 1.5 }, 'sortOrder'],
    ['unknown field (mass assignment)', { archivedAt: '2020-01-01T00:00:00Z' }, null],
    ['unknown field createdBy', { createdBy: '00000000-0000-4000-8000-000000000000' }, null],
  ])('rejects invalid input: %s', async (_label, over, field) => {
    const before = await countRows(ctx, 'community_rooms');
    const res = await send(ctx, 'POST', '/api/staff/rooms', ctx.cookies.admin, { ...payload(), ...over });
    expect(res.statusCode).toBe(400);
    expect(errCode(res)).toBe('BAD_REQUEST');
    if (field) expect(Object.keys(res.json().error.details)).toContain(field);
    expect(await countRows(ctx, 'community_rooms')).toBe(before);
  });

  it('rejects a name from which no URL name can be derived', async () => {
    const res = await send(ctx, 'POST', '/api/staff/rooms', ctx.cookies.admin, { name: '!!!???', description: 'd', category: 'general_discussion' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.slug).toBeTruthy();
  });

  it('rejects a duplicate URL name with 409, explicit or derived', async () => {
    const first = await mk();
    const dupe = await send(ctx, 'POST', '/api/staff/rooms', ctx.cookies.moderator, payload({ slug: first.slug }));
    expect(dupe.statusCode).toBe(409);
    const derived = await send(ctx, 'POST', '/api/staff/rooms', ctx.cookies.admin, { name: 'Same Name Twice', description: 'd', category: 'general_discussion' });
    const again = await send(ctx, 'POST', '/api/staff/rooms', ctx.cookies.admin, { name: 'Same Name Twice', description: 'd', category: 'general_discussion' });
    expect(derived.statusCode).toBe(201);
    expect(again.statusCode).toBe(409);
  });

  it('stores nothing and audits nothing when a create fails', async () => {
    const audits = await countRows(ctx, 'audit_log', "action = 'room.created'");
    await send(ctx, 'POST', '/api/staff/rooms', ctx.cookies.admin, payload({ name: 'x' }));
    expect(await countRows(ctx, 'audit_log', "action = 'room.created'")).toBe(audits);
  });
});

describe('editing rooms', () => {
  it.each(['admin', 'moderator'] as const)('%s can edit a room; the slug never changes; the edit is audited', async (who) => {
    const room = await mk();
    const res = await send(ctx, 'PATCH', `/api/staff/rooms/${room.id}`, ctx.cookies[who], {
      name: 'Renamed room', description: 'New description', guidelines: 'New guidelines', category: 'trading_discussion', access: 'premium', sortOrder: 3,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().room).toMatchObject({ slug: room.slug, name: 'Renamed room', description: 'New description', guidelines: 'New guidelines', category: 'trading_discussion', access: 'premium', sortOrder: 3 });
    const [stored] = await row<{ updated_by: string }>(ctx, 'select updated_by from community_rooms where id = $1', [room.id]);
    expect(stored!.updated_by).toBe(ctx.users[who].id);
    const log = await row<{ data: { changed: string[]; from: { access: string }; to: { access: string } } }>(ctx, "select data from audit_log where action = 'room.updated' and entity_id = $1", [room.id]);
    expect(log).toHaveLength(1);
    expect(log[0]!.data.changed.sort()).toEqual(['access', 'category', 'description', 'guidelines', 'name', 'sortOrder']);
    expect(log[0]!.data.from.access).toBe('public');
    expect(log[0]!.data.to.access).toBe('premium');
  });

  it('supports partial edits and records nothing for a no-op edit', async () => {
    const room = await mk();
    const noop = await send(ctx, 'PATCH', `/api/staff/rooms/${room.id}`, ctx.cookies.admin, { name: room.name });
    expect(noop.statusCode).toBe(200);
    expect(await countRows(ctx, 'audit_log', "action = 'room.updated' and entity_id = $1", [room.id])).toBe(0);
    const part = await send(ctx, 'PATCH', `/api/staff/rooms/${room.id}`, ctx.cookies.admin, { description: 'Only this' });
    expect(part.json().room).toMatchObject({ description: 'Only this', name: room.name });
  });

  it('cannot move a public room into premium_community without premium access, and leaves it unchanged', async () => {
    const room = await mk();
    const res = await send(ctx, 'PATCH', `/api/staff/rooms/${room.id}`, ctx.cookies.admin, { category: 'premium_community' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.access).toBeTruthy();
    expect((await get(ctx, `/api/staff/rooms/${room.id}`, ctx.cookies.admin)).json().room.category).toBe('general_discussion');
    const ok = await send(ctx, 'PATCH', `/api/staff/rooms/${room.id}`, ctx.cookies.admin, { category: 'premium_community', access: 'premium' });
    expect(ok.statusCode).toBe(200);
  });

  it('cannot make a premium_community room public', async () => {
    const room = await mk({ category: 'premium_community' });
    const res = await send(ctx, 'PATCH', `/api/staff/rooms/${room.id}`, ctx.cookies.moderator, { access: 'public' });
    expect(res.statusCode).toBe(400);
    expect((await get(ctx, `/api/staff/rooms/${room.id}`, ctx.cookies.admin)).json().room.access).toBe('premium');
  });

  it.each([
    ['empty body', {}], ['slug change', { slug: 'new-slug-value' }], ['archive via edit', { archivedAt: null }], ['invalid name', { name: '' }], ['invalid access', { access: 'secret' }],
  ])('rejects %s', async (_l, body) => {
    const room = await mk();
    const res = await send(ctx, 'PATCH', `/api/staff/rooms/${room.id}`, ctx.cookies.admin, body);
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for malformed or unknown room ids', async () => {
    for (const id of ['nope', '00000000-0000-4000-8000-000000000000']) {
      expect((await send(ctx, 'PATCH', `/api/staff/rooms/${id}`, ctx.cookies.admin, { name: 'Some name' })).statusCode).toBe(404);
      expect((await get(ctx, `/api/staff/rooms/${id}`, ctx.cookies.admin)).statusCode).toBe(404);
      expect((await send(ctx, 'POST', `/api/staff/rooms/${id}/archive`, ctx.cookies.admin)).statusCode).toBe(404);
    }
  });
});

describe('archiving rooms', () => {
  it.each(['admin', 'moderator'] as const)('%s can archive and restore; archived rooms vanish for members but not staff', async (who) => {
    const room = await mk();
    const url = `/api/staff/rooms/${room.id}`;
    const archived = await send(ctx, 'POST', `${url}/archive`, ctx.cookies[who]);
    expect(archived.statusCode).toBe(200);
    expect(archived.json().room.archivedAt).toBeTruthy();

    for (const cookie of [undefined, ctx.cookies.free, ctx.cookies.premium]) {
      const list = (await get(ctx, '/api/rooms', cookie)).json().rooms as { slug: string }[];
      expect(list.map((r) => r.slug)).not.toContain(room.slug);
      expect((await get(ctx, `/api/rooms/${room.slug}`, cookie)).statusCode).toBe(404);
    }
    expect((await get(ctx, `/api/rooms/${room.slug}`, ctx.cookies.moderator)).statusCode).toBe(200);
    const archivedList = (await get(ctx, '/api/staff/rooms?status=archived', ctx.cookies.admin)).json().rooms as { id: string }[];
    expect(archivedList.map((r) => r.id)).toContain(room.id);
    const activeList = (await get(ctx, '/api/staff/rooms?status=active', ctx.cookies.admin)).json().rooms as { id: string }[];
    expect(activeList.map((r) => r.id)).not.toContain(room.id);

    const restored = await send(ctx, 'POST', `${url}/restore`, ctx.cookies[who]);
    expect(restored.json().room.archivedAt).toBeNull();
    expect((await get(ctx, `/api/rooms/${room.slug}`, ctx.cookies.free)).statusCode).toBe(200);
  });

  it('archive and restore are idempotent and audited once per real change', async () => {
    const room = await mk();
    const url = `/api/staff/rooms/${room.id}`;
    await send(ctx, 'POST', `${url}/archive`, ctx.cookies.admin);
    const again = await send(ctx, 'POST', `${url}/archive`, ctx.cookies.admin);
    expect(again.statusCode).toBe(200);
    expect(await countRows(ctx, 'audit_log', "action = 'room.archived' and entity_id = $1", [room.id])).toBe(1);
    await send(ctx, 'POST', `${url}/restore`, ctx.cookies.admin);
    await send(ctx, 'POST', `${url}/restore`, ctx.cookies.admin);
    expect(await countRows(ctx, 'audit_log', "action = 'room.restored' and entity_id = $1", [room.id])).toBe(1);
  });

  it('keeps the URL name reserved while a room is archived', async () => {
    const room = await mk();
    await send(ctx, 'POST', `/api/staff/rooms/${room.id}/archive`, ctx.cookies.admin);
    expect((await send(ctx, 'POST', '/api/staff/rooms', ctx.cookies.admin, payload({ slug: room.slug }))).statusCode).toBe(409);
  });

  it('rejects an invalid status filter', async () => {
    expect((await get(ctx, '/api/staff/rooms?status=deleted', ctx.cookies.admin)).statusCode).toBe(400);
  });
});

describe('room listing', () => {
  let pub: { slug: string; id: string }; let prem: { slug: string; id: string }; let premCat: { slug: string; id: string };
  beforeAll(async () => {
    pub = await mk({ sortOrder: 1 });
    prem = await mkPremium({ category: 'market_analysis', sortOrder: 2 });
    premCat = await mk({ category: 'premium_community', sortOrder: 3 });
  });
  type Item = { slug: string; locked: boolean; access: string; guidelines?: string };
  const list = async (cookie?: string, qs = '') => (await get(ctx, `/api/rooms${qs}`, cookie)).json().rooms as Item[];
  const find = (items: Item[], r: { slug: string }) => items.find((i) => i.slug === r.slug);

  it('shows public rooms unlocked to everyone, including visitors', async () => {
    for (const cookie of [undefined, ctx.cookies.free, ctx.cookies.premium, ctx.cookies.moderator]) {
      expect(find(await list(cookie), pub)).toMatchObject({ locked: false, access: 'public' });
    }
  });

  it('shows premium rooms as locked to visitors and free members, unlocked to premium members and staff', async () => {
    for (const cookie of [undefined, ctx.cookies.free]) {
      const items = await list(cookie);
      expect(find(items, prem)!.locked).toBe(true);
      expect(find(items, premCat)!.locked).toBe(true);
    }
    for (const cookie of [ctx.cookies.premium, ctx.cookies.moderator, ctx.cookies.admin]) {
      const items = await list(cookie);
      expect(find(items, prem)!.locked).toBe(false);
      expect(find(items, premCat)!.locked).toBe(false);
    }
  });

  it('never includes member-only content in the listing, for any viewer', async () => {
    for (const cookie of [undefined, ctx.cookies.free, ctx.cookies.premium, ctx.cookies.admin]) {
      const res = await get(ctx, '/api/rooms', cookie);
      expect(res.body).not.toContain('SECRET-GUIDELINES');
      for (const item of res.json().rooms) expect(item).not.toHaveProperty('guidelines');
    }
  });

  it('filters by category, orders by sort order, and validates the filter', async () => {
    const items = await list(ctx.cookies.free, '?category=market_analysis');
    expect(items.every((i) => (i as unknown as { category: string }).category === 'market_analysis')).toBe(true);
    expect(find(items, prem)).toBeTruthy();
    expect(find(items, pub)).toBeUndefined();
    const all = (await list()).map((i) => i.slug);
    expect(all.indexOf(pub.slug)).toBeLessThan(all.indexOf(prem.slug));
    expect(all.indexOf(prem.slug)).toBeLessThan(all.indexOf(premCat.slug));
    expect((await get(ctx, '/api/rooms?category=memes')).statusCode).toBe(400);
  });
});

describe('room access', () => {
  let pub: { slug: string }; let prem: { slug: string };
  beforeAll(async () => { pub = await mk(); prem = await mkPremium({ category: 'premium_community' }); });
  const open = (slug: string, cookie?: string) => get(ctx, `/api/rooms/${slug}`, cookie);

  it('lets anyone open a public room and returns its guidelines', async () => {
    for (const cookie of [undefined, ctx.cookies.free, ctx.cookies.premium]) {
      const res = await open(pub.slug, cookie);
      expect(res.statusCode).toBe(200);
      expect(res.json().room).toMatchObject({ slug: pub.slug, locked: false, guidelines: GUIDE });
    }
  });

  it('asks visitors to sign in for a premium room, revealing no member-only content', async () => {
    const res = await open(prem.slug);
    expect(res.statusCode).toBe(401);
    expect(errCode(res)).toBe('UNAUTHENTICATED');
    expect(res.json().error.details.room).toMatchObject({ slug: prem.slug, locked: true });
    expect(res.body).not.toContain('SECRET-GUIDELINES');
  });

  it('refuses free members with PREMIUM_REQUIRED, revealing no member-only content', async () => {
    const res = await open(prem.slug, ctx.cookies.free);
    expect(res.statusCode).toBe(403);
    expect(errCode(res)).toBe('PREMIUM_REQUIRED');
    expect(res.json().error.details.room).not.toHaveProperty('guidelines');
    expect(res.body).not.toContain('SECRET-GUIDELINES');
  });

  it('lets premium members and staff into premium rooms', async () => {
    for (const cookie of [ctx.cookies.premium, ctx.cookies.moderator, ctx.cookies.admin]) {
      const res = await open(prem.slug, cookie);
      expect(res.statusCode).toBe(200);
      expect(res.json().room).toMatchObject({ locked: false, guidelines: GUIDE });
    }
  });

  it('returns 404 for unknown or malformed room names', async () => {
    for (const slug of ['does-not-exist', 'Bad_Slug', 'x', 'a'.repeat(80), '%00']) {
      expect((await open(slug, ctx.cookies.admin)).statusCode, slug).toBe(404);
    }
  });

  it('follows the subscription: revoking premium locks the member out on the next request', async () => {
    const u = await seedUser(ctx.db, 'free', 'revoked-room@example.com');
    await ctx.app.billing.grant(ctx.users.admin.id, u.id, 'premium_monthly', 30, 'fixture');
    const cookie = await loginCookie(ctx.app, 'revoked-room@example.com');
    expect((await open(prem.slug, cookie)).statusCode).toBe(200);
    await send(ctx, 'POST', `/api/admin/users/${u.id}/subscription/revoke`, ctx.cookies.admin, { reason: 'fixture' });
    expect((await open(prem.slug, cookie)).statusCode).toBe(403);
    expect((await get(ctx, '/api/rooms', cookie)).json().rooms.find((r: { slug: string }) => r.slug === prem.slug).locked).toBe(true);
  });

  it('follows the subscription clock: access is kept through grace and lapses when it ends', async () => {
    const own = await setup();
    const room = (await send(own, 'POST', '/api/staff/rooms', own.cookies.admin, payload({ access: 'premium' }))).json().room as { slug: string };
    const url = `/api/rooms/${room.slug}`;
    expect((await get(own, url, own.cookies.premium)).statusCode).toBe(200);
    own.clock.advanceDays(31); // 30-day period ended; inside the 3-day grace window
    expect((await get(own, url, own.cookies.premium)).statusCode).toBe(200);
    own.clock.advanceDays(5); // grace over
    expect((await get(own, url, own.cookies.premium)).statusCode).toBe(403);
    expect((await get(own, url, own.cookies.admin)).statusCode).toBe(200); // staff unaffected
  });

  it('turning a public room into a premium room locks it for free members immediately', async () => {
    const room = await mk();
    expect((await open(room.slug, ctx.cookies.free)).statusCode).toBe(200);
    await send(ctx, 'PATCH', `/api/staff/rooms/${room.id}`, ctx.cookies.moderator, { access: 'premium' });
    expect((await open(room.slug, ctx.cookies.free)).statusCode).toBe(403);
  });
});
