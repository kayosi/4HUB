import { describe, expect, it } from 'vitest';
import { get, JPEG, PNG, createSignal, multipart, send, setup, SECRET, uploadImages } from './helpers.js';

const LEAKS = [String(SECRET.entry), String(SECRET.stopLoss), String(SECRET.tp1), String(SECRET.tp2), String(SECRET.tp3), 'SECRET-ANALYSIS'];
const PREMIUM_KEYS = ['entry', 'stopLoss', 'takeProfits', 'analysis', 'images', 'pips', 'riskLevel', 'stats', 'viewer'];

describe('premium signal teasers (server-side protection)', () => {
  it('visitors and free members get a teaser: no levels, analysis, images or other premium keys anywhere in the payload', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    await uploadImages(ctx, sig.id, [{ data: PNG }]);

    for (const cookie of [undefined, ctx.cookies.free]) {
      for (const url of ['/api/signals', `/api/signals/${sig.id}`]) {
        const res = await get(ctx, url, cookie);
        expect(res.statusCode).toBe(200);
        for (const leak of LEAKS) expect(res.body, `${url} leaked ${leak}`).not.toContain(leak);
        const s = url === '/api/signals' ? res.json().signals[0] : res.json().signal;
        expect(s).toMatchObject({ locked: true, asset: 'XAUUSD', direction: 'buy', teaser: SECRET.teaser, visibility: 'premium' });
        for (const k of PREMIUM_KEYS) expect(s, `key ${k}`).not.toHaveProperty(k);
      }
      expect(await get(ctx, `/api/signals/${sig.id}`, cookie).then((r) => r.json().updates)).toBeNull();
    }
  });

  it('uses a generic teaser when the admin did not write one', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx, { teaser: '' });
    const res = await get(ctx, `/api/signals/${sig.id}`);
    expect(res.json().signal.teaser).toMatch(/upgrade/i);
  });

  it('premium members, moderators and admins receive the full signal', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    for (const role of ['premium', 'moderator', 'admin'] as const) {
      const s = (await get(ctx, `/api/signals/${sig.id}`, ctx.cookies[role])).json().signal;
      expect(s).toMatchObject({ locked: false, entry: SECRET.entry, stopLoss: SECRET.stopLoss, takeProfits: [SECRET.tp1, SECRET.tp2, SECRET.tp3], analysis: SECRET.analysis });
    }
  });

  it('free signals are fully visible to everyone, including visitors', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx, { visibility: 'free' });
    const s = (await get(ctx, `/api/signals/${sig.id}`)).json().signal;
    expect(s).toMatchObject({ locked: false, entry: SECRET.entry, analysis: SECRET.analysis });
  });

  it('filtering by premium does not unlock anything for free members', async () => {
    const ctx = await setup();
    await createSignal(ctx);
    const res = await get(ctx, '/api/signals?visibility=premium&status=active&asset=xauusd', ctx.cookies.free);
    expect(res.json().signals).toHaveLength(1);
    for (const leak of LEAKS) expect(res.body).not.toContain(leak);
  });

  it('a signal switched from free to premium becomes locked immediately', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx, { visibility: 'free' });
    expect((await get(ctx, `/api/signals/${sig.id}`)).json().signal.locked).toBe(false);
    await send(ctx, 'PATCH', `/api/admin/signals/${sig.id}`, ctx.cookies.admin, { visibility: 'premium' });
    const after = await get(ctx, `/api/signals/${sig.id}`);
    expect(after.json().signal.locked).toBe(true);
    for (const leak of LEAKS) expect(after.body).not.toContain(leak);
  });

  it('role changes take effect on the very next request', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    expect((await get(ctx, `/api/signals/${sig.id}`, ctx.cookies.free)).json().signal.locked).toBe(true);
    const r = await send(ctx, 'PATCH', `/api/admin/users/${ctx.users.free.id}/role`, ctx.cookies.admin, { role: 'premium' });
    expect(r.statusCode).toBe(200);
    expect((await get(ctx, `/api/signals/${sig.id}`, ctx.cookies.free)).json().signal.locked).toBe(false);
  });
});

describe('chart image protection', () => {
  async function withImage(visibility: 'free' | 'premium') {
    const ctx = await setup();
    const sig = await createSignal(ctx, { visibility });
    const up = await uploadImages(ctx, sig.id, [{ data: PNG }]);
    expect(up.statusCode).toBe(201);
    const img = up.json().signal.images[0] as { id: string; url: string };
    return { ctx, sig, img };
  }

  it('premium images return 403 to visitors and free members, 200 to premium+', async () => {
    const { ctx, img } = await withImage('premium');
    expect((await get(ctx, img.url)).statusCode).toBe(403);
    expect((await get(ctx, img.url, ctx.cookies.free)).statusCode).toBe(403);
    for (const role of ['premium', 'moderator', 'admin'] as const) {
      const res = await get(ctx, img.url, ctx.cookies[role]);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(Buffer.compare(res.rawPayload, PNG)).toBe(0);
    }
  });

  it('sends private, no-store, nosniff headers', async () => {
    const { ctx, img } = await withImage('premium');
    const res = await get(ctx, img.url, ctx.cookies.premium);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('does not reveal whether an image id exists to unauthorized users', async () => {
    const { ctx, sig, img } = await withImage('premium');
    const real = await get(ctx, img.url, ctx.cookies.free);
    const fake = await get(ctx, `/api/signals/${sig.id}/images/00000000-0000-4000-8000-000000000000`, ctx.cookies.free);
    expect(real.statusCode).toBe(403);
    expect(fake.statusCode).toBe(403);
  });

  it('image ids are random uuids and storage keys / file paths never appear in responses', async () => {
    const { ctx, sig, img } = await withImage('premium');
    expect(img.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(img.url).toBe(`/api/signals/${sig.id}/images/${img.id}`);
    const detail = await get(ctx, `/api/signals/${sig.id}`, ctx.cookies.premium);
    for (const file of ctx.storedFiles()) expect(detail.body).not.toContain(file);
  });

  it('files are not reachable through any static/guessable path', async () => {
    const { ctx } = await withImage('premium');
    const key = ctx.storedFiles()[0]!;
    for (const url of [`/uploads/${key}`, `/${key}`, `/api/uploads/${key}`, `/static/${key}`, `/api/signals/images/${key}`]) {
      expect((await get(ctx, url, ctx.cookies.admin)).statusCode, url).toBe(404);
    }
  });

  it('free-signal images are public; switching to premium locks them', async () => {
    const { ctx, sig, img } = await withImage('free');
    expect((await get(ctx, img.url)).statusCode).toBe(200);
    await send(ctx, 'PATCH', `/api/admin/signals/${sig.id}`, ctx.cookies.admin, { visibility: 'premium' });
    expect((await get(ctx, img.url)).statusCode).toBe(403);
  });

  it('a malformed image id or signal id is a 404, never a 500', async () => {
    const { ctx, sig } = await withImage('free');
    expect((await get(ctx, `/api/signals/${sig.id}/images/not-a-uuid`)).statusCode).toBe(404);
    expect((await get(ctx, '/api/signals/not-a-uuid/images/x')).statusCode).toBe(404);
  });
});

describe('image upload validation (admin)', () => {
  it('only admins can upload or delete images', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    const m = multipart([{ data: PNG }]);
    for (const role of ['free', 'premium', 'moderator'] as const) {
      const res = await ctx.app.inject({ method: 'POST', url: `/api/admin/signals/${sig.id}/images`, payload: m.payload, headers: { ...m.headers, cookie: ctx.cookies[role] } });
      expect(res.statusCode, role).toBe(403);
    }
    expect((await ctx.app.inject({ method: 'POST', url: `/api/admin/signals/${sig.id}/images`, payload: m.payload, headers: m.headers })).statusCode).toBe(401);
  });

  it('accepts several images at once (png, jpeg) and detects type from content', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    const res = await uploadImages(ctx, sig.id, [{ data: PNG }, { data: JPEG, name: 'x.jpg', type: 'image/jpeg' }]);
    expect(res.statusCode).toBe(201);
    expect(res.json().signal.images).toHaveLength(2);
    const second = await get(ctx, res.json().signal.images[1].url, ctx.cookies.admin);
    expect(second.headers['content-type']).toBe('image/jpeg');
  });

  it('rejects non-images even when the client claims image/png', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    const res = await uploadImages(ctx, sig.id, [{ data: Buffer.from('<script>alert(1)</script>'), name: 'evil.png', type: 'image/png' }]);
    expect(res.statusCode).toBe(400);
    expect(ctx.storedFiles()).toHaveLength(0);
  });

  it('is all-or-nothing: one bad file in a batch stores nothing', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    const res = await uploadImages(ctx, sig.id, [{ data: PNG }, { data: Buffer.from('not an image at all') }]);
    expect(res.statusCode).toBe(400);
    expect(ctx.storedFiles()).toHaveLength(0);
    expect((await get(ctx, `/api/signals/${sig.id}`, ctx.cookies.admin)).json().signal.images).toHaveLength(0);
  });

  it('enforces the per-signal image limit and the file size limit', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    expect((await uploadImages(ctx, sig.id, Array.from({ length: 5 }, () => ({ data: PNG })))).statusCode).toBe(201);
    expect((await uploadImages(ctx, sig.id, [{ data: PNG }])).statusCode).toBe(400);

    const small = await setup({ MAX_UPLOAD_MB: '0.001' });
    const s2 = await createSignal(small);
    const big = Buffer.concat([PNG, Buffer.alloc(5000)]);
    const res = await uploadImages(small, s2.id, [{ data: big }]);
    expect(res.statusCode).toBe(413);
    expect(small.storedFiles()).toHaveLength(0);
  });

  it('deleting an image removes the file from storage', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    const img = (await uploadImages(ctx, sig.id, [{ data: PNG }])).json().signal.images[0];
    expect(ctx.storedFiles()).toHaveLength(1);
    expect((await send(ctx, 'DELETE', `/api/admin/signals/${sig.id}/images/${img.id}`, ctx.cookies.admin)).statusCode).toBe(204);
    expect(ctx.storedFiles()).toHaveLength(0);
    expect((await get(ctx, img.url, ctx.cookies.admin)).statusCode).toBe(404);
  });
});
