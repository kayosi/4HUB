import { describe, expect, it } from 'vitest';
import { createSignal, get, send, setup } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof setup>>;
const detail = async (ctx: Ctx, id: string, cookie?: string) => (await get(ctx, `/api/signals/${id}`, cookie)).json().signal;

describe('reactions', () => {
  it('members can react once per signal, change, and remove their reaction; counts stay accurate', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx, { visibility: 'free' });
    const url = `/api/signals/${sig.id}/reaction`;
    expect((await send(ctx, 'PUT', url, ctx.cookies.free, { type: 'like' })).json().stats.reactions).toMatchObject({ like: 1, fire: 0 });
    await send(ctx, 'PUT', url, ctx.cookies.premium, { type: 'like' });
    expect((await detail(ctx, sig.id, ctx.cookies.free)).stats.reactions.like).toBe(2);

    const changed = await send(ctx, 'PUT', url, ctx.cookies.free, { type: 'fire' });
    expect(changed.json().stats.reactions).toMatchObject({ like: 1, fire: 1 });
    expect((await detail(ctx, sig.id, ctx.cookies.free)).viewer.reaction).toBe('fire');

    const removed = await send(ctx, 'DELETE', url, ctx.cookies.free);
    expect(removed.json().stats.reactions).toMatchObject({ like: 1, fire: 0 });
    expect((await detail(ctx, sig.id, ctx.cookies.free)).viewer.reaction).toBeNull();
  });

  it('rejects visitors, unknown reaction types and premium signals for free members', async () => {
    const ctx = await setup();
    const free = await createSignal(ctx, { visibility: 'free' });
    const prem = await createSignal(ctx, { visibility: 'premium' });
    expect((await send(ctx, 'PUT', `/api/signals/${free.id}/reaction`, undefined, { type: 'like' })).statusCode).toBe(401);
    expect((await send(ctx, 'PUT', `/api/signals/${free.id}/reaction`, ctx.cookies.free, { type: 'rocket' })).statusCode).toBe(400);
    const denied = await send(ctx, 'PUT', `/api/signals/${prem.id}/reaction`, ctx.cookies.free, { type: 'like' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('PREMIUM_REQUIRED');
    expect((await send(ctx, 'PUT', `/api/signals/${prem.id}/reaction`, ctx.cookies.premium, { type: 'like' })).statusCode).toBe(200);
  });
});

describe('comments', () => {
  it('members can comment on free signals; visitors can read but not write', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx, { visibility: 'free' });
    const url = `/api/signals/${sig.id}/comments`;
    expect((await send(ctx, 'POST', url, undefined, { body: 'hi' })).statusCode).toBe(401);
    const posted = await send(ctx, 'POST', url, ctx.cookies.free, { body: '  Nice setup!  ' });
    expect(posted.statusCode).toBe(201);
    const list = await get(ctx, url); // visitor read
    expect(list.statusCode).toBe(200);
    expect(list.json().comments).toHaveLength(1);
    expect(list.json().comments[0]).toMatchObject({ body: 'Nice setup!', author: { displayName: 'free user', badge: null }, mine: false });
    expect((await detail(ctx, sig.id)).stats ?? null).not.toBeNull();
    expect((await detail(ctx, sig.id, ctx.cookies.free)).stats.comments).toBe(1);
  });

  it('never exposes emails or user ids, and marks staff with a badge and own comments with mine', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx, { visibility: 'free' });
    const url = `/api/signals/${sig.id}/comments`;
    await send(ctx, 'POST', url, ctx.cookies.free, { body: 'a' });
    await send(ctx, 'POST', url, ctx.cookies.moderator, { body: 'b' });
    const res = await get(ctx, url, ctx.cookies.free);
    expect(res.body).not.toContain('@example.com');
    expect(res.body).not.toContain(ctx.users.free.id);
    const [a, b] = res.json().comments;
    expect(a).toMatchObject({ mine: true, author: { badge: null } });
    expect(b).toMatchObject({ mine: false, author: { badge: 'moderator' } });
  });

  it('validates comment bodies', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx, { visibility: 'free' });
    const url = `/api/signals/${sig.id}/comments`;
    expect((await send(ctx, 'POST', url, ctx.cookies.free, { body: '   ' })).statusCode).toBe(400);
    expect((await send(ctx, 'POST', url, ctx.cookies.free, { body: 'x'.repeat(1001) })).statusCode).toBe(400);
    expect((await send(ctx, 'POST', url, ctx.cookies.free, {})).statusCode).toBe(400);
  });

  it('premium signal comments are closed to visitors and free members (read and write)', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx, { visibility: 'premium' });
    const url = `/api/signals/${sig.id}/comments`;
    await send(ctx, 'POST', url, ctx.cookies.premium, { body: 'PREMIUM-CHAT' });
    for (const cookie of [undefined, ctx.cookies.free]) {
      const r = await get(ctx, url, cookie);
      expect(r.statusCode).toBe(403);
      expect(r.body).not.toContain('PREMIUM-CHAT');
    }
    expect((await send(ctx, 'POST', url, ctx.cookies.free, { body: 'let me in' })).statusCode).toBe(403);
    expect((await get(ctx, url, ctx.cookies.premium)).json().comments).toHaveLength(1);
  });

  it('authors delete their own; others cannot; moderators and admins can delete any; deleted comments disappear', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx, { visibility: 'free' });
    const url = `/api/signals/${sig.id}/comments`;
    const mk = async (cookie: string, body: string) => (await send(ctx, 'POST', url, cookie, { body })).json().id as string;
    const mine = await mk(ctx.cookies.free, 'mine');
    const other = await mk(ctx.cookies.free, 'other');
    const third = await mk(ctx.cookies.free, 'third');

    expect((await send(ctx, 'DELETE', `/api/comments/${mine}`, undefined)).statusCode).toBe(401);
    expect((await send(ctx, 'DELETE', `/api/comments/${other}`, ctx.cookies.premium)).statusCode).toBe(403);
    expect((await send(ctx, 'DELETE', `/api/comments/${mine}`, ctx.cookies.free)).statusCode).toBe(204);
    expect((await send(ctx, 'DELETE', `/api/comments/${other}`, ctx.cookies.moderator)).statusCode).toBe(204);
    expect((await send(ctx, 'DELETE', `/api/comments/${third}`, ctx.cookies.admin)).statusCode).toBe(204);
    expect((await get(ctx, url)).json().comments).toHaveLength(0);
    expect((await send(ctx, 'DELETE', `/api/comments/${mine}`, ctx.cookies.free)).statusCode).toBe(404); // already deleted
    expect((await send(ctx, 'DELETE', '/api/comments/not-a-uuid', ctx.cookies.free)).statusCode).toBe(404);
    expect((await detail(ctx, sig.id, ctx.cookies.free)).stats.comments).toBe(0);
  });
});

describe('bookmarks', () => {
  it('free members can save free signals, idempotently, list them and remove them', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx, { visibility: 'free' });
    const url = `/api/signals/${sig.id}/bookmark`;
    expect((await send(ctx, 'PUT', url, ctx.cookies.free)).json()).toEqual({ bookmarked: true });
    expect((await send(ctx, 'PUT', url, ctx.cookies.free)).statusCode).toBe(200); // idempotent
    expect((await detail(ctx, sig.id, ctx.cookies.free)).viewer.bookmarked).toBe(true);
    const list = (await get(ctx, '/api/me/bookmarks', ctx.cookies.free)).json().signals;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(sig.id);
    expect((await get(ctx, '/api/me/bookmarks', ctx.cookies.premium)).json().signals).toHaveLength(0); // per-user
    await send(ctx, 'DELETE', url, ctx.cookies.free);
    expect((await get(ctx, '/api/me/bookmarks', ctx.cookies.free)).json().signals).toHaveLength(0);
  });

  it('visitors cannot bookmark and the list requires login', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx, { visibility: 'free' });
    expect((await send(ctx, 'PUT', `/api/signals/${sig.id}/bookmark`)).statusCode).toBe(401);
    expect((await get(ctx, '/api/me/bookmarks')).statusCode).toBe(401);
  });

  it('free members cannot bookmark premium signals; premium members can', async () => {
    const ctx = await setup();
    const prem = await createSignal(ctx, { visibility: 'premium' });
    const url = `/api/signals/${prem.id}/bookmark`;
    expect((await send(ctx, 'PUT', url, ctx.cookies.free)).statusCode).toBe(403);
    expect((await send(ctx, 'PUT', url, ctx.cookies.premium)).statusCode).toBe(200);
  });

  it('a lapsed premium member sees saved premium signals as teasers and can still remove them', async () => {
    const ctx = await setup();
    const prem = await createSignal(ctx, { visibility: 'premium' });
    await send(ctx, 'PUT', `/api/signals/${prem.id}/bookmark`, ctx.cookies.premium);
    await send(ctx, 'POST', `/api/admin/users/${ctx.users.premium.id}/subscription/revoke`, ctx.cookies.admin, { reason: 'test lapse' });
    const res = await get(ctx, '/api/me/bookmarks', ctx.cookies.premium);
    expect(res.json().signals[0]).toMatchObject({ locked: true });
    expect(res.body).not.toContain('SECRET-ANALYSIS');
    expect((await send(ctx, 'DELETE', `/api/signals/${prem.id}/bookmark`, ctx.cookies.premium)).statusCode).toBe(200);
    expect((await get(ctx, '/api/me/bookmarks', ctx.cookies.premium)).json().signals).toHaveLength(0);
  });
});

describe('view counter', () => {
  it('counts each signed-in member once, ignores visitors and locked views', async () => {
    const ctx = await setup();
    const free = await createSignal(ctx, { visibility: 'free' });
    const prem = await createSignal(ctx, { visibility: 'premium' });

    await get(ctx, `/api/signals/${free.id}`); // visitor: not counted
    await get(ctx, `/api/signals/${free.id}`, ctx.cookies.free);
    await get(ctx, `/api/signals/${free.id}`, ctx.cookies.free); // same member again
    const s = await detail(ctx, free.id, ctx.cookies.premium); // second member
    expect(s.stats.views).toBe(2);

    await get(ctx, `/api/signals/${prem.id}`, ctx.cookies.free); // locked view: not counted
    expect((await detail(ctx, prem.id, ctx.cookies.premium)).stats.views).toBe(1);
  });
});

describe('malformed ids', () => {
  it('return 404 instead of crashing', async () => {
    const ctx = await setup();
    for (const url of ['/api/signals/xyz', '/api/signals/xyz/comments']) expect((await get(ctx, url, ctx.cookies.free)).statusCode).toBe(404);
    expect((await send(ctx, 'PUT', '/api/signals/xyz/bookmark', ctx.cookies.free)).statusCode).toBe(404);
  });
});
