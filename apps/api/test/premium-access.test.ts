import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loginCookie, seedUser, createSignal, get, send, setup, uploadImages, PNG, type Ctx } from './helpers.js';

/** Members in every subscription condition, built with real grants and a moving clock. */
async function population() {
  const ctx = await setup();
  const mk = async (name: string, days?: number) => {
    const u = await seedUser(ctx.db, 'free', `${name}@example.com`);
    if (days) await ctx.app.billing.grant(ctx.users.admin.id, u.id, 'premium_monthly', days, 'fixture');
    return { id: u.id, cookie: await loginCookie(ctx.app, `${name}@example.com`) };
  };
  const active = await mk('active', 30);
  const grace = await mk('grace', 10);
  const expired = await mk('expired', 2);
  const revoked = await mk('revoked', 30);
  const never = await mk('never');
  await send(ctx, 'POST', `/api/admin/users/${revoked.id}/subscription/revoke`, ctx.cookies.admin, { reason: 'fixture' });
  ctx.clock.advanceDays(11); // grace: ended 1 day ago (inside 3-day grace); expired: ended 9 days ago
  return { ctx, active, grace, expired, revoked, never };
}

async function surfaces(ctx: Ctx, signalId: string, imageUrl: string, cookie?: string) {
  const feed = (await get(ctx, '/api/signals', cookie)).json().signals.find((s: { id: string }) => s.id === signalId);
  return {
    feedLocked: feed.locked as boolean,
    detailLocked: (await get(ctx, `/api/signals/${signalId}`, cookie)).json().signal.locked as boolean,
    image: (await get(ctx, imageUrl, cookie)).statusCode,
    comments: (await get(ctx, `/api/signals/${signalId}/comments`, cookie)).statusCode,
    react: (await send(ctx, 'PUT', `/api/signals/${signalId}/reaction`, cookie, { type: 'like' })).statusCode,
    bookmark: (await send(ctx, 'PUT', `/api/signals/${signalId}/bookmark`, cookie)).statusCode,
    memberPremium: (await get(ctx, '/api/member/premium', cookie)).statusCode,
  };
}

const ALLOWED = { feedLocked: false, detailLocked: false, image: 200, comments: 200, react: 200, bookmark: 200, memberPremium: 200 };
const DENIED = { feedLocked: true, detailLocked: true, image: 403, comments: 403, react: 403, bookmark: 403, memberPremium: 403 };

describe('premium access follows subscription state across every protected surface', () => {
  it('FREE, EXPIRED, REVOKED and VISITOR are locked out; ACTIVE and GRACE members and staff get in', async () => {
    const { ctx, active, grace, expired, revoked, never } = await population();
    const sig = await createSignal(ctx);
    const img = (await uploadImages(ctx, sig.id, [{ data: PNG }])).json().signal.images[0].url as string;

    expect(await surfaces(ctx, sig.id, img, never.cookie)).toEqual(DENIED); // FREE USER
    expect(await surfaces(ctx, sig.id, img, expired.cookie)).toEqual(DENIED); // EXPIRED PREMIUM USER
    expect(await surfaces(ctx, sig.id, img, revoked.cookie)).toEqual(DENIED); // revoked
    expect(await surfaces(ctx, sig.id, img, active.cookie)).toEqual(ALLOWED); // ACTIVE PREMIUM USER
    expect(await surfaces(ctx, sig.id, img, grace.cookie)).toEqual(ALLOWED); // inside the grace period
    expect(await surfaces(ctx, sig.id, img, ctx.cookies.admin)).toEqual(ALLOWED); // ADMIN
    expect(await surfaces(ctx, sig.id, img, ctx.cookies.moderator)).toEqual(ALLOWED); // moderator (content staff)

    // visitor: no session at all (401 where a login is required)
    expect(await surfaces(ctx, sig.id, img)).toEqual({ ...DENIED, react: 401, bookmark: 401, memberPremium: 401 });
  });

  it('expired members get nothing premium in any payload, not just a flag', async () => {
    const { ctx, expired } = await population();
    const sig = await createSignal(ctx);
    const res = await get(ctx, `/api/signals/${sig.id}`, expired.cookie);
    expect(res.json().signal).toMatchObject({ locked: true });
    expect(res.body).not.toContain('SECRET-ANALYSIS');
    expect(res.body).not.toContain('2350.55');
  });

  it('admin can still manage content (post, edit, close) and a premium member cannot', async () => {
    const { ctx, active } = await population();
    const sig = await createSignal(ctx);
    expect((await send(ctx, 'PATCH', `/api/admin/signals/${sig.id}`, ctx.cookies.admin, { analysis: 'edited' })).statusCode).toBe(200);
    expect((await send(ctx, 'PATCH', `/api/admin/signals/${sig.id}`, active.cookie, { analysis: 'hax' })).statusCode).toBe(403);
    expect((await send(ctx, 'POST', '/api/admin/signals', active.cookie, {})).statusCode).toBe(403);
  });

  it('a member who loses access keeps their bookmark records but sees them locked; renewing unlocks them again', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    await send(ctx, 'PUT', `/api/signals/${sig.id}/bookmark`, ctx.cookies.premium);
    ctx.clock.advanceDays(40);
    const locked = await get(ctx, '/api/me/bookmarks', ctx.cookies.premium);
    expect(locked.json().signals[0].locked).toBe(true);
    expect(locked.body).not.toContain('SECRET-ANALYSIS');
    await ctx.app.billing.grant(ctx.users.admin.id, ctx.users.premium.id, 'premium_monthly', 30, 'renewal');
    expect((await get(ctx, '/api/me/bookmarks', ctx.cookies.premium)).json().signals[0].locked).toBe(false);
  });
});

describe('one authorization rule (no duplicated premium logic)', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith('.ts') ? [join(dir, f)] : []));
  // Comments are stripped so the guard looks at code, not documentation.
  const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const src = files(join(__dirname, '..', 'src')).map((f) => ({ f: f.replace(/.*\/src\//, ''), text: stripComments(readFileSync(f, 'utf8')) }));
  const hits = (re: RegExp) => src.filter((s) => re.test(s.text)).map((s) => s.f);

  it('premium is not a role anywhere in the source', () => {
    expect(hits(/hasPremiumAccess/)).toEqual([]);
    expect(hits(/role\s*===?\s*'premium'/)).toEqual([]);
    expect(hits(/requireRole\([^)]*'premium'/)).toEqual([]);
  });

  it('capabilities are only ever read inside the central can() function', () => {
    expect(hits(/entitlement\.capabilities|\.capabilities\.includes/)).toEqual(['auth/access.ts']);
  });

  it('every use of the premium capability outside its definition sits inside can() or requireCapability()', () => {
    const definitionFiles = ['billing/tiers.ts', 'auth/access.ts']; // the registry and the rule itself
    const offenders: string[] = [];
    for (const { f, text } of src) {
      if (definitionFiles.includes(f)) continue;
      text.split('\n').forEach((line, i) => {
        if (line.includes("'premium_signals'") && !/\bcan\(|requireCapability\(/.test(line)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('subscription state is evaluated in exactly one place, and only the billing layer calls it', () => {
    expect(hits(/subscriptionState\(/).sort()).toEqual(['billing/service.ts', 'billing/subscriptions.ts']);
    expect(hits(/buildEntitlement\(/).sort()).toEqual(['billing/service.ts', 'billing/subscriptions.ts', 'routes/areas.ts']);
  });
});
