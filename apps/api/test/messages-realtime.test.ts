import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loginCookie, seedUser, send, setup, type Ctx } from './helpers.js';

interface Frame { event?: string; id?: string; data?: string; comment?: string; retry?: string }

/** Minimal Server-Sent Events client over a real socket (inject() cannot hold a stream open). */
async function openStream(base: string, slug: string, cookie: string | undefined) {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/rooms/${slug}/stream`, { headers: cookie ? { cookie } : {}, signal: ac.signal });
  const frames: Frame[] = [];
  let ended = false;
  const waiters: (() => void)[] = [];
  const wake = () => waiters.splice(0).forEach((w) => w());
  if (res.status === 200 && res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, i); buf = buf.slice(i + 2);
            const f: Frame = {};
            for (const line of raw.split('\n')) {
              if (line.startsWith(':')) f.comment = line.slice(1).trim();
              else if (line.startsWith('event: ')) f.event = line.slice(7);
              else if (line.startsWith('id: ')) f.id = line.slice(4);
              else if (line.startsWith('data: ')) f.data = line.slice(6);
              else if (line.startsWith('retry: ')) f.retry = line.slice(7);
            }
            frames.push(f); wake();
          }
        }
      } catch { /* aborted */ }
      ended = true; wake();
    })();
  }
  const until = async (pred: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) return false;
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 25); });
    }
    return true;
  };
  return {
    status: res.status, headers: res.headers, frames, close: () => ac.abort(),
    events: (name: string) => frames.filter((f) => f.event === name).map((f) => ({ ...f, json: JSON.parse(f.data ?? 'null') })),
    waitForEvent: (name: string, ms?: number) => until(() => frames.some((f) => f.event === name), ms),
    waitForEnd: (ms?: number) => until(() => ended, ms),
    isEnded: () => ended,
    async errorBody() { return res.status === 200 ? null : await res.json(); },
  };
}

let n = 0;
const makeRoom = async (ctx: Ctx, over: Record<string, unknown> = {}) => {
  n += 1;
  const res = await send(ctx, 'POST', '/api/staff/rooms', ctx.cookies.admin, { name: `Live room ${n}`, slug: `live-room-${n}`, description: 'd', category: 'general_discussion', ...over });
  return res.json().room as { id: string; slug: string };
};
const say = async (ctx: Ctx, slug: string, cookie: string, body: string) => (await send(ctx, 'POST', `/api/rooms/${slug}/messages`, cookie, { body })).json().message;
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

describe('live updates over Server-Sent Events', () => {
  let ctx: Ctx; let base: string; let pub: { id: string; slug: string }; let prem: { id: string; slug: string };
  const open: { close: () => void }[] = [];
  const stream = async (slug: string, cookie: string | undefined) => { const s = await openStream(base, slug, cookie); open.push(s); return s; };

  beforeAll(async () => {
    ctx = await setup({ CHAT_WRITES_PER_MINUTE: '10000', CHAT_STREAM_RECHECK_MS: '100', CHAT_MAX_STREAMS_PER_USER: '3' });
    base = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    pub = await makeRoom(ctx);
    prem = await makeRoom(ctx, { access: 'premium' });
  });
  afterAll(async () => {
    open.forEach((s) => s.close());
    // The test client may leave a stray idle connection after an aborted request; drop it so close() does not wait on it.
    ctx.app.server.closeAllConnections();
    await ctx.app.close();
  });

  it('streams as text/event-stream with a reconnect hint and no caching', async () => {
    const s = await stream(pub.slug, ctx.cookies.free);
    expect(s.status).toBe(200);
    expect(s.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(s.headers.get('cache-control')).toContain('no-cache');
    expect(s.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await s.waitForEnd(200)).toBe(false);
    expect(s.frames[0]?.retry).toBe('3000');
    s.close();
  });

  it('delivers created, edited and deleted messages to other members in real time', async () => {
    const watcher = await stream(pub.slug, ctx.cookies.premium);
    const m = await say(ctx, pub.slug, ctx.cookies.free, 'live hello');
    expect(await watcher.waitForEvent('message.created')).toBe(true);
    const created = watcher.events('message.created')[0]!;
    expect(created.json).toMatchObject({ id: m.id, body: 'live hello', author: { displayName: 'free user' }, deleted: false });
    expect(created.id).toBe(String(m.seq)); // event id is the cursor
    expect(created.data).not.toContain('free@example.com');

    await send(ctx, 'PATCH', `/api/rooms/${pub.slug}/messages/${m.id}`, ctx.cookies.free, { body: 'live edited' });
    expect(await watcher.waitForEvent('message.updated')).toBe(true);
    expect(watcher.events('message.updated')[0]!.json).toMatchObject({ id: m.id, body: 'live edited' });
    expect(watcher.events('message.updated')[0]!.json.editedAt).toBeTruthy();

    await send(ctx, 'DELETE', `/api/rooms/${pub.slug}/messages/${m.id}`, ctx.cookies.moderator);
    expect(await watcher.waitForEvent('message.deleted')).toBe(true);
    const gone = watcher.events('message.deleted')[0]!;
    expect(gone.json).toMatchObject({ id: m.id, deleted: true, body: null });
    expect(gone.data).not.toContain('live edited'); // deleted content never travels
    watcher.close();
  });

  it('also echoes a message to its own author\'s stream (the client de-duplicates by id)', async () => {
    const mine = await stream(pub.slug, ctx.cookies.free);
    const m = await say(ctx, pub.slug, ctx.cookies.free, 'echo');
    expect(await mine.waitForEvent('message.created')).toBe(true);
    expect(mine.events('message.created')[0]!.json.id).toBe(m.id);
    mine.close();
  });

  it('keeps rooms separate: a stream only receives its own room\'s messages', async () => {
    const other = await makeRoom(ctx);
    const watcher = await stream(pub.slug, ctx.cookies.free);
    await say(ctx, other.slug, ctx.cookies.premium, 'in another room');
    const m = await say(ctx, pub.slug, ctx.cookies.premium, 'in this room');
    expect(await watcher.waitForEvent('message.created')).toBe(true);
    await settle();
    const got = watcher.events('message.created').map((e) => e.json.id);
    expect(got).toEqual([m.id]);
    watcher.close();
  });

  it('does not deliver rejected or invalid messages', async () => {
    const watcher = await stream(pub.slug, ctx.cookies.premium);
    await send(ctx, 'POST', `/api/rooms/${pub.slug}/messages`, ctx.cookies.free, { body: '' });
    await send(ctx, 'POST', `/api/rooms/${pub.slug}/messages`, undefined, { body: 'anonymous' });
    await settle();
    expect(watcher.events('message.created')).toHaveLength(0);
    watcher.close();
  });

  it('refuses visitors, free members in premium rooms, unknown rooms and archived rooms, opening no stream', async () => {
    const visitor = await openStream(base, pub.slug, undefined);
    expect(visitor.status).toBe(401);
    const free = await openStream(base, prem.slug, ctx.cookies.free);
    expect(free.status).toBe(403);
    expect((await free.errorBody()).error.code).toBe('PREMIUM_REQUIRED');
    expect((await openStream(base, 'no-such-room', ctx.cookies.free)).status).toBe(404);
    const gone = await makeRoom(ctx);
    await send(ctx, 'POST', `/api/staff/rooms/${gone.id}/archive`, ctx.cookies.admin);
    expect((await openStream(base, gone.slug, ctx.cookies.free)).status).toBe(404);
    await settle();
  });

  it('delivers premium-room messages only to entitled viewers', async () => {
    const watcher = await stream(prem.slug, ctx.cookies.premium);
    const staff = await stream(prem.slug, ctx.cookies.moderator);
    await say(ctx, prem.slug, ctx.cookies.admin, 'members only');
    expect(await watcher.waitForEvent('message.created')).toBe(true);
    expect(await staff.waitForEvent('message.created')).toBe(true);
    watcher.close(); staff.close();
  });

  it('caps concurrent streams per user', async () => {
    const tabs = [];
    for (let i = 0; i < 3; i++) tabs.push(await stream(pub.slug, ctx.cookies.premium));
    const fourth = await openStream(base, pub.slug, ctx.cookies.premium);
    expect(fourth.status).toBe(429);
    expect((await fourth.errorBody()).error.code).toBe('TOO_MANY_STREAMS');
    tabs.forEach((t) => t.close());
    await settle(300); // closing a tab frees its slot
    const again = await stream(pub.slug, ctx.cookies.premium);
    expect(again.status).toBe(200);
    again.close();
  });

  it('sends keep-alives and cleans up when the client disconnects', async () => {
    await settle(300);
    const baseline = ctx.app.chatHub.size();
    const s = await stream(pub.slug, ctx.cookies.free);
    expect(await s.waitForEvent('never', 10)).toBe(false);
    expect(ctx.app.chatHub.size()).toBe(baseline + 1);
    const end = Date.now() + 2000;
    while (!s.frames.some((f) => f.comment === 'keep-alive') && Date.now() < end) await settle(50);
    expect(s.frames.some((f) => f.comment === 'keep-alive')).toBe(true);
    s.close();
    const t = Date.now() + 2000;
    while (ctx.app.chatHub.size() > baseline && Date.now() < t) await settle(50);
    expect(ctx.app.chatHub.size()).toBe(baseline);
  });

  it('closes the stream when the subscription is revoked, and stops delivering', async () => {
    const u = await seedUser(ctx.db, 'free', 'stream-lapse@example.com');
    await ctx.app.billing.grant(ctx.users.admin.id, u.id, 'premium_monthly', 30, 'fixture');
    const cookie = await loginCookie(ctx.app, 'stream-lapse@example.com');
    const s = await stream(prem.slug, cookie);
    expect(s.status).toBe(200);
    await send(ctx, 'POST', `/api/admin/users/${u.id}/subscription/revoke`, ctx.cookies.admin, { reason: 'fixture' });
    expect(await s.waitForEvent('closed', 3000)).toBe(true);
    expect(s.events('closed')[0]!.json).toEqual({ reason: 'access_revoked' });
    expect(await s.waitForEnd(2000)).toBe(true);
    await say(ctx, prem.slug, ctx.cookies.admin, 'after revoke');
    expect(s.events('message.created').some((e) => e.json.body === 'after revoke')).toBe(false);
  });

  it('closes the stream when the session ends', async () => {
    const u = await seedUser(ctx.db, 'free', 'stream-logout@example.com');
    const cookie = await loginCookie(ctx.app, 'stream-logout@example.com');
    const s = await stream(pub.slug, cookie);
    await ctx.db.query('delete from sessions where user_id = $1', [u.id]);
    expect(await s.waitForEvent('closed', 3000)).toBe(true);
    expect(await s.waitForEnd(2000)).toBe(true);
  });

  it('closes the stream for members when the room is archived or made premium, but not for staff on archive', async () => {
    const room = await makeRoom(ctx);
    const member = await stream(room.slug, ctx.cookies.free);
    const staff = await stream(room.slug, ctx.cookies.moderator);
    await send(ctx, 'POST', `/api/staff/rooms/${room.id}/archive`, ctx.cookies.admin);
    expect(await member.waitForEvent('closed', 3000)).toBe(true);
    await settle(400);
    expect(staff.events('closed')).toHaveLength(0);
    staff.close();
    const room2 = await makeRoom(ctx);
    const m2 = await stream(room2.slug, ctx.cookies.free);
    await send(ctx, 'PATCH', `/api/staff/rooms/${room2.id}`, ctx.cookies.admin, { access: 'premium' });
    expect(await m2.waitForEvent('closed', 3000)).toBe(true);
  });

  it('ends open streams when the server shuts down, so it can close cleanly', async () => {
    const own = await setup({ CHAT_STREAM_RECHECK_MS: '60000' });
    const addr = await own.app.listen({ port: 0, host: '127.0.0.1' });
    const room = await makeRoom(own);
    const s = await openStream(addr, room.slug, own.cookies.free);
    expect(s.status).toBe(200);
    const closed = await Promise.race([own.app.close().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 4000))]);
    expect(closed).toBe(true);
    expect(await s.waitForEnd(2000)).toBe(true);
  });
});
