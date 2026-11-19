import { beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, loginCookie, seedUser, get, send, setup, countRows, row, type Ctx } from './helpers.js';

interface Restriction { id: string; userId: string; type: string; reason: string; expiresAt: string | null; liftedAt: string | null; active: boolean }
let n = 0;
const base = { CHAT_WRITES_PER_MINUTE: '100000', REPORTS_PER_HOUR: '1000', REPORTS_PER_DAY: '1000' };
const code = (r: { json: () => { error: { code: string } } }) => r.json().error.code;

let ctx: Ctx; let room: { id: string; slug: string }; let adminCookie2: string; let adminId2: string;
beforeAll(async () => {
  ctx = await setup(base);
  room = (await send(ctx, 'POST', '/api/staff/rooms', ctx.cookies.admin, { name: 'Restriction room', slug: 'restriction-room', description: 'd', category: 'general_discussion' })).json().room;
  const a2 = await seedUser(ctx.db, 'admin', 'admin2@example.com'); adminId2 = a2.id;
  adminCookie2 = await loginCookie(ctx.app, 'admin2@example.com');
});

/** A fresh member with their own session, so tests never share restriction state. */
async function member(role: 'free' | 'moderator' = 'free') {
  n += 1;
  const email = `member${n}@example.com`;
  const u = await seedUser(ctx.db, role, email);
  return { id: u.id, email, cookie: await loginCookie(ctx.app, email) };
}
const restrict = (userId: string, payload: unknown, cookie = ctx.cookies.admin, c = ctx) => send(c, 'POST', `/api/admin/users/${userId}/restrictions`, cookie, payload);
const lift = (id: string, payload: unknown = {}, cookie = ctx.cookies.admin) => send(ctx, 'POST', `/api/admin/restrictions/${id}/lift`, cookie, payload);
const post = (cookie: string, body = 'hello everyone') => send(ctx, 'POST', `/api/rooms/${room.slug}/messages`, cookie, { body });
const mute = async (userId: string, extra: Record<string, unknown> = {}) => (await restrict(userId, { type: 'muted', reason: 'Repeated spam', ...extra })).json().restriction as Restriction;
const suspend = async (userId: string, extra: Record<string, unknown> = {}) => (await restrict(userId, { type: 'suspended', reason: 'Harassment of members', ...extra })).json().restriction as Restriction;

describe('restrictions are an administrator power (server-side)', () => {
  it('refuses visitors (401) and members, premium members and moderators (403), changing nothing', async () => {
    const target = await member();
    const r = await mute(target.id);
    const before = await countRows(ctx, 'user_restrictions');
    const calls: ['GET' | 'POST', string, unknown?][] = [
      ['GET', `/api/admin/users/${target.id}/restrictions`],
      ['POST', `/api/admin/users/${target.id}/restrictions`, { type: 'suspended', reason: 'Not allowed' }],
      ['POST', `/api/admin/restrictions/${r.id}/lift`, {}],
    ];
    for (const [method, url, body] of calls) {
      const visitor = method === 'GET' ? await get(ctx, url) : await send(ctx, 'POST', url, undefined, body);
      expect(visitor.statusCode, `visitor ${url}`).toBe(401);
      for (const who of ['free', 'premium', 'moderator'] as const) {
        const res = method === 'GET' ? await get(ctx, url, ctx.cookies[who]) : await send(ctx, 'POST', url, ctx.cookies[who], body);
        expect(res.statusCode, `${who} ${url}`).toBe(403);
      }
    }
    expect(await countRows(ctx, 'user_restrictions')).toBe(before);
    expect((await row(ctx, 'select lifted_at from user_restrictions where id = $1', [r.id]))[0]).toMatchObject({ lifted_at: null });
    expect((await post(target.cookie)).statusCode).toBe(403); // still muted
  });

  it('applies the rank rule: administrators cannot be restricted, not even by another administrator or themselves', async () => {
    for (const [target, cookie] of [[adminId2, ctx.cookies.admin], [ctx.users.admin.id, adminCookie2], [ctx.users.admin.id, ctx.cookies.admin]] as const) {
      expect((await restrict(target, { type: 'muted', reason: 'Not allowed' }, cookie)).statusCode).toBe(403);
    }
    expect(await countRows(ctx, 'user_restrictions', 'user_id = $1 or user_id = $2', [adminId2, ctx.users.admin.id])).toBe(0);
    const mod = await member('moderator');
    expect((await restrict(mod.id, { type: 'muted', reason: 'Moderator misconduct' })).statusCode).toBe(201); // moderators can be
  });

  it('returns 404 for unknown or malformed users and restrictions', async () => {
    for (const id of ['nope', '00000000-0000-4000-8000-000000000000']) {
      expect((await restrict(id, { type: 'muted', reason: 'Some reason' })).statusCode).toBe(404);
      expect((await get(ctx, `/api/admin/users/${id}/restrictions`, ctx.cookies.admin)).statusCode).toBe(404);
      expect((await lift(id)).statusCode).toBe(404);
    }
  });

  it.each([
    ['unknown type', { type: 'banned', reason: 'Some reason' }], ['missing type', { reason: 'Some reason' }], ['missing reason', { type: 'muted' }],
    ['reason too short', { type: 'muted', reason: 'no' }], ['reason too long', { type: 'muted', reason: 'x'.repeat(301) }], ['control characters', { type: 'muted', reason: 'bad\u0007' }],
    ['duration zero', { type: 'muted', reason: 'Some reason', durationHours: 0 }], ['duration too long', { type: 'muted', reason: 'Some reason', durationHours: 8761 }],
    ['fractional duration', { type: 'muted', reason: 'Some reason', durationHours: 1.5 }], ['duration as text', { type: 'muted', reason: 'Some reason', durationHours: '5' }],
    ['expiry supplied', { type: 'muted', reason: 'Some reason', expiresAt: '2099-01-01T00:00:00Z' }], ['creator supplied', { type: 'muted', reason: 'Some reason', createdBy: '00000000-0000-4000-8000-000000000000' }],
    ['already lifted supplied', { type: 'muted', reason: 'Some reason', liftedAt: '2020-01-01T00:00:00Z' }],
  ])('rejects invalid input: %s', async (_l, payload) => {
    const target = await member();
    expect((await restrict(target.id, payload)).statusCode).toBe(400);
    expect(await countRows(ctx, 'user_restrictions', 'user_id = $1', [target.id])).toBe(0);
  });

  it('allows one active restriction of each type, and a new one after lifting', async () => {
    const t = await member();
    const m = await mute(t.id);
    const dupe = await restrict(t.id, { type: 'muted', reason: 'Again again' });
    expect(dupe.statusCode).toBe(409);
    expect((await suspend(t.id)).active).toBe(true); // a different type is fine
    expect((await lift(m.id)).statusCode).toBe(200);
    expect((await restrict(t.id, { type: 'muted', reason: 'A second offence' })).statusCode).toBe(201);
  });
});

describe('muting a member', () => {
  it('stops posting and editing with a clear explanation, but not reading, reporting or deleting their own messages', async () => {
    const t = await member();
    const mine = (await post(t.cookie, 'before the mute')).json().message;
    const other = (await post(ctx.cookies.premium, 'someone else')).json().message;
    const r = await restrict(t.id, { type: 'muted', reason: 'Posting spam links', durationHours: 24 });
    expect(r.statusCode).toBe(201);
    expect(r.json().restriction).toMatchObject({ type: 'muted', reason: 'Posting spam links', active: true, liftedAt: null });

    const send1 = await post(t.cookie, 'let me talk');
    expect(send1.statusCode).toBe(403);
    expect(code(send1)).toBe('ACCOUNT_RESTRICTED');
    expect(send1.json().error.message).toContain('Posting spam links');
    expect(send1.json().error.details).toMatchObject({ type: 'muted', reason: 'Posting spam links' });
    expect(send1.json().error.details.expiresAt).toBeTruthy();
    expect(send1.body).not.toContain(ctx.users.admin.id); // who applied it is not disclosed
    const edit = await send(ctx, 'PATCH', `/api/rooms/${room.slug}/messages/${mine.id}`, t.cookie, { body: 'edited' });
    expect(code(edit)).toBe('ACCOUNT_RESTRICTED');
    expect((await row(ctx, 'select body from room_messages where id = $1', [mine.id]))[0]).toMatchObject({ body: 'before the mute' });

    expect((await get(ctx, `/api/rooms/${room.slug}/messages`, t.cookie)).statusCode).toBe(200);
    expect((await send(ctx, 'POST', `/api/rooms/${room.slug}/messages/${other.id}/report`, t.cookie, { reason: 'spam' })).statusCode).toBe(201);
    expect((await send(ctx, 'DELETE', `/api/rooms/${room.slug}/messages/${mine.id}`, t.cookie)).statusCode).toBe(200);
    expect((await post(ctx.cookies.free)).statusCode).toBe(201); // nobody else is affected
  });

  it('tells the member about the restriction through their own profile only', async () => {
    const t = await member();
    const clean = await member();
    await mute(t.id, { durationHours: 5 });
    const mine = (await get(ctx, '/api/me', t.cookie)).json().user;
    expect(mine.restrictions.muted).toMatchObject({ type: 'muted', reason: 'Repeated spam' });
    expect(mine.restrictions.muted.expiresAt).toBeTruthy();
    expect((await get(ctx, '/api/me', clean.cookie)).json().user.restrictions).toEqual({ muted: null });
  });

  it('ends on its own when the time is up, and stops being reported as active', async () => {
    const own = await setup(base);
    const rm = (await send(own, 'POST', '/api/staff/rooms', own.cookies.admin, { name: 'Timed room', slug: 'timed-room', description: 'd', category: 'general_discussion' })).json().room;
    const p = () => send(own, 'POST', `/api/rooms/${rm.slug}/messages`, own.cookies.free, { body: 'hi' });
    const r = (await restrict(own.users.free.id, { type: 'muted', reason: 'Cooling off', durationHours: 2 }, own.cookies.admin, own)).json().restriction as Restriction;
    expect(new Date(r.expiresAt!).getTime() - own.clock.now().getTime()).toBe(2 * 3_600_000);
    expect((await p()).statusCode).toBe(403);
    own.clock.advanceMs(119 * 60_000);
    expect((await p()).statusCode).toBe(403);
    own.clock.advanceMs(2 * 60_000);
    expect((await p()).statusCode).toBe(201);
    const hist = (await get(own, `/api/admin/users/${own.users.free.id}/restrictions`, own.cookies.admin)).json().restrictions as Restriction[];
    expect(hist[0]).toMatchObject({ id: r.id, active: false, liftedAt: null });
    expect((await send(own, 'POST', `/api/admin/restrictions/${r.id}/lift`, own.cookies.admin, {})).statusCode).toBe(409); // nothing left to lift
  });

  it('can be lifted at once by any administrator, with the note and actor recorded', async () => {
    const t = await member();
    const r = await mute(t.id);
    expect((await post(t.cookie)).statusCode).toBe(403);
    const res = await lift(r.id, { note: '  Apologised to the room  ' }, adminCookie2);
    expect(res.statusCode).toBe(200);
    expect(res.json().restriction).toMatchObject({ active: false });
    expect(res.json().restriction.liftedAt).toBeTruthy();
    expect((await post(t.cookie)).statusCode).toBe(201);
    expect((await get(ctx, '/api/me', t.cookie)).json().user.restrictions).toEqual({ muted: null });
    const [row1] = await row<{ lifted_by: string; lift_note: string }>(ctx, 'select lifted_by, lift_note from user_restrictions where id = $1', [r.id]);
    expect(row1).toMatchObject({ lifted_by: adminId2, lift_note: 'Apologised to the room' });
    const log = await row<{ actor_id: string; data: { note: string; type: string } }>(ctx, "select actor_id, data from audit_log where action = 'user.restriction_lifted' and entity_id = $1", [t.id]);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor_id: adminId2, data: { type: 'muted', note: 'Apologised to the room' } });
  });

  it('cannot lift twice, and the lift note is validated', async () => {
    const t = await member();
    const r = await mute(t.id);
    for (const bad of [{ note: 'x'.repeat(301) }, { note: 'bad\u0007' }, { liftedBy: adminId2 }]) expect((await lift(r.id, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    expect((await send(ctx, 'POST', `/api/admin/restrictions/${r.id}/lift`, ctx.cookies.admin)).statusCode).toBe(200); // no body is fine
    expect((await lift(r.id)).statusCode).toBe(409);
    expect(await countRows(ctx, 'audit_log', "action = 'user.restriction_lifted' and entity_id = $1", [t.id])).toBe(1);
  });

  it('records who restricted whom and why, in the audit log', async () => {
    const t = await member();
    const r = await mute(t.id, { durationHours: 12 });
    const [log] = await row<{ actor_id: string; entity_type: string; data: Record<string, unknown> }>(ctx, "select actor_id, entity_type, data from audit_log where action = 'user.restricted' and entity_id = $1", [t.id]);
    expect(log).toMatchObject({ actor_id: ctx.users.admin.id, entity_type: 'user', data: { restrictionId: r.id, type: 'muted', reason: 'Repeated spam' } });
    expect(log!.data.expiresAt).toBeTruthy();
    expect((await row(ctx, 'select created_by from user_restrictions where id = $1', [r.id]))[0]).toMatchObject({ created_by: ctx.users.admin.id });
  });

  it('does not stop a muted moderator from moderating', async () => {
    const mod = await member('moderator');
    await mute(mod.id);
    expect((await post(mod.cookie)).statusCode).toBe(403);
    const victim = (await post(ctx.cookies.premium, 'needs moderating')).json().message;
    expect((await send(ctx, 'POST', `/api/moderation/messages/${victim.id}/hide`, mod.cookie, { reason: 'Still a moderator' })).statusCode).toBe(200);
  });
});

describe('suspending an account', () => {
  it('blocks every request from a signed-in session and explains why, while visitors are unaffected', async () => {
    const t = await member();
    expect((await get(ctx, '/api/me', t.cookie)).statusCode).toBe(200);
    await suspend(t.id, { durationHours: 48 });
    for (const url of ['/api/me', '/api/rooms', `/api/rooms/${room.slug}/messages`, '/api/signals', '/api/billing/subscription']) {
      const res = await get(ctx, url, t.cookie);
      expect(res.statusCode, url).toBe(403);
      expect(code(res), url).toBe('ACCOUNT_SUSPENDED');
    }
    const res = await post(t.cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('Harassment of members');
    expect(res.json().error.message).toMatch(/suspended until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    expect(res.json().error.details).toMatchObject({ type: 'suspended', reason: 'Harassment of members' });
    expect(res.body).not.toContain(ctx.users.admin.id);
    expect((await get(ctx, '/api/rooms')).statusCode).toBe(200); // public browsing needs no session
  });

  it('still allows signing out, then refuses to sign back in with the reason (never revealing it to a wrong password)', async () => {
    const t = await member();
    await suspend(t.id);
    expect((await send(ctx, 'POST', '/api/auth/logout', t.cookie)).statusCode).toBe(204);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: t.email, password: PASSWORD } });
    expect(login.statusCode).toBe(403);
    expect(login.json().error.code).toBe('ACCOUNT_SUSPENDED');
    expect(login.json().error.message).toContain('Harassment of members');
    expect(login.cookies).toHaveLength(0); // no session was created
    const wrong = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: t.email, password: 'wrong-password-123' } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).not.toContain('Harassment');
  });

  it('is lifted immediately: the existing session works again and sign-in succeeds', async () => {
    const t = await member();
    const r = await suspend(t.id);
    expect((await get(ctx, '/api/me', t.cookie)).statusCode).toBe(403);
    await lift(r.id, { note: 'Appeal accepted' });
    expect((await get(ctx, '/api/me', t.cookie)).statusCode).toBe(200);
    expect((await post(t.cookie)).statusCode).toBe(201);
    await loginCookie(ctx.app, t.email);
  });

  it('expires on its own', async () => {
    const own = await setup(base);
    await restrict(own.users.free.id, { type: 'suspended', reason: 'Short timeout', durationHours: 1 }, own.cookies.admin, own);
    expect((await get(own, '/api/me', own.cookies.free)).statusCode).toBe(403);
    own.clock.advanceMs(61 * 60_000);
    expect((await get(own, '/api/me', own.cookies.free)).statusCode).toBe(200);
  });

  it('applies to staff too: a suspended moderator loses the moderation tools', async () => {
    const mod = await member('moderator');
    expect((await get(ctx, '/api/moderation/reports', mod.cookie)).statusCode).toBe(200);
    await suspend(mod.id);
    const res = await get(ctx, '/api/moderation/reports', mod.cookie);
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe('ACCOUNT_SUSPENDED');
  });

  it('combines with a mute, and each is lifted separately', async () => {
    const t = await member();
    const m = await mute(t.id); const s = await suspend(t.id);
    await lift(s.id);
    expect((await get(ctx, '/api/me', t.cookie)).statusCode).toBe(200);
    expect(code(await post(t.cookie))).toBe('ACCOUNT_RESTRICTED'); // the mute is still in force
    await lift(m.id);
    expect((await post(t.cookie)).statusCode).toBe(201);
  });
});

describe('restriction history and visibility', () => {
  it('lists a user\'s restrictions newest first with their state, for administrators only', async () => {
    const t = await member();
    const first = await mute(t.id);
    await lift(first.id);
    ctx.clock.advanceMs(1000); // the test clock is frozen; real actions never share a timestamp
    const second = await suspend(t.id);
    const hist = (await get(ctx, `/api/admin/users/${t.id}/restrictions`, ctx.cookies.admin)).json().restrictions as Restriction[];
    expect(hist.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(hist.map((r) => r.active)).toEqual([true, false]);
    expect(hist[1]!.liftedAt).toBeTruthy();
    expect(JSON.stringify(hist)).not.toContain('created_by');
  });

  it('shows current restrictions on the administrator user list', async () => {
    const t = await member(); const clean = await member();
    await mute(t.id, { durationHours: 3 });
    const users = (await get(ctx, '/api/admin/users?limit=100', ctx.cookies.admin)).json().users as { id: string; restrictions: { muted: { reason: string } | null; suspended: unknown } }[];
    expect(users.find((u) => u.id === t.id)!.restrictions).toMatchObject({ muted: { reason: 'Repeated spam' }, suspended: null });
    expect(users.find((u) => u.id === clean.id)!.restrictions).toEqual({ muted: null, suspended: null });
  });

  it('never deletes history: lifted restrictions stay on record', async () => {
    const t = await member();
    const r = await mute(t.id);
    await lift(r.id);
    expect(await countRows(ctx, 'user_restrictions', 'id = $1', [r.id])).toBe(1);
    expect(await countRows(ctx, 'audit_log', "entity_id = $1 and action like 'user.restrict%'", [t.id])).toBe(2);
  });
});
