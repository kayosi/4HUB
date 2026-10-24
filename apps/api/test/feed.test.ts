import { describe, expect, it } from 'vitest';
import { createSignal, get, send, setup, type Ctx } from './helpers.js';

const ids = (res: { json(): { signals: { id: string }[] } }) => res.json().signals.map((s) => s.id);
const setCreated = (ctx: Ctx, id: string, iso: string) => ctx.db.query('update signals set created_at = $2 where id = $1', [id, new Date(iso)]);

async function seed() {
  const ctx = await setup();
  const gold = await createSignal(ctx, { asset: 'XAUUSD', visibility: 'premium' });
  const eur = await createSignal(ctx, { asset: 'EURUSD', direction: 'sell', entry: 1.1, stopLoss: 1.11, takeProfit1: 1.09, takeProfit2: 1.08, takeProfit3: 1.07, visibility: 'free' });
  const btc = await createSignal(ctx, { asset: 'BTCUSD', entry: 60000, stopLoss: 59000, takeProfit1: 61000, takeProfit2: 62000, takeProfit3: 63000, visibility: 'free' });
  await setCreated(ctx, gold.id, '2026-03-01T10:00:00Z');
  await setCreated(ctx, eur.id, '2026-03-05T10:00:00Z');
  await setCreated(ctx, btc.id, '2026-03-10T10:00:00Z');
  await send(ctx, 'POST', `/api/admin/signals/${eur.id}/close`, ctx.cookies.admin, { result: 'sl_hit', pips: -10 });
  return { ctx, gold, eur, btc };
}

describe('signal feed', () => {
  it('lists newest first and is public', async () => {
    const { ctx, gold, eur, btc } = await seed();
    const res = await get(ctx, '/api/signals');
    expect(res.statusCode).toBe(200);
    expect(ids(res)).toEqual([btc.id, eur.id, gold.id]);
  });

  it('shows asset, direction, timeframe, status, risk, analysis and result where authorized', async () => {
    const { ctx, eur } = await seed();
    const s = (await get(ctx, '/api/signals?asset=EURUSD', ctx.cookies.free)).json().signals[0];
    expect(s).toMatchObject({ id: eur.id, asset: 'EURUSD', direction: 'sell', timeframe: 'H1', status: 'closed', riskLevel: 'medium', result: 'sl_hit', pips: -10, locked: false });
    expect(s.analysis).toContain('SECRET-ANALYSIS'); // free signal, so public
  });

  it('filters by asset (case-insensitive)', async () => {
    const { ctx, btc } = await seed();
    expect(ids(await get(ctx, '/api/signals?asset=btcusd'))).toEqual([btc.id]);
    expect(ids(await get(ctx, '/api/signals?asset=NOPE'))).toEqual([]);
  });

  it('filters by free/premium', async () => {
    const { ctx, gold, eur, btc } = await seed();
    expect(ids(await get(ctx, '/api/signals?visibility=premium'))).toEqual([gold.id]);
    expect(ids(await get(ctx, '/api/signals?visibility=free'))).toEqual([btc.id, eur.id]);
  });

  it('filters by active/closed', async () => {
    const { ctx, eur, btc, gold } = await seed();
    expect(ids(await get(ctx, '/api/signals?status=closed'))).toEqual([eur.id]);
    expect(ids(await get(ctx, '/api/signals?status=active'))).toEqual([btc.id, gold.id]);
  });

  it('filters by date range (from inclusive, to exclusive) and combines filters', async () => {
    const { ctx, eur, btc, gold } = await seed();
    expect(ids(await get(ctx, '/api/signals?from=2026-03-05'))).toEqual([btc.id, eur.id]);
    expect(ids(await get(ctx, '/api/signals?to=2026-03-05'))).toEqual([gold.id]);
    expect(ids(await get(ctx, '/api/signals?from=2026-03-02&to=2026-03-09'))).toEqual([eur.id]);
    expect(ids(await get(ctx, '/api/signals?from=2026-03-02&visibility=free&status=active'))).toEqual([btc.id]);
  });

  it('paginates with hasMore', async () => {
    const { ctx, btc, eur, gold } = await seed();
    const p1 = (await get(ctx, '/api/signals?limit=2')).json();
    expect(p1.signals.map((s: { id: string }) => s.id)).toEqual([btc.id, eur.id]);
    expect(p1.hasMore).toBe(true);
    const p2 = (await get(ctx, '/api/signals?limit=2&offset=2')).json();
    expect(p2.signals.map((s: { id: string }) => s.id)).toEqual([gold.id]);
    expect(p2.hasMore).toBe(false);
  });

  it.each(['status=won', 'visibility=vip', 'from=yesterday', 'from=2026-13-45', 'limit=0', 'limit=1000', 'offset=-1', 'asset=%21%21'])('rejects invalid filter %s', async (q) => {
    const ctx = await setup();
    expect((await get(ctx, `/api/signals?${q}`)).statusCode).toBe(400);
  });

  it('exposes the list of assets for the filter dropdown', async () => {
    const { ctx } = await seed();
    expect((await get(ctx, '/api/signals/assets')).json().assets).toEqual(['BTCUSD', 'EURUSD', 'XAUUSD']);
  });

  it('includes per-viewer state and engagement counts only for authorized signals', async () => {
    const { ctx, btc, gold } = await seed();
    await send(ctx, 'PUT', `/api/signals/${btc.id}/reaction`, ctx.cookies.free, { type: 'fire' });
    await send(ctx, 'PUT', `/api/signals/${btc.id}/bookmark`, ctx.cookies.free);
    const list = (await get(ctx, '/api/signals', ctx.cookies.free)).json().signals;
    const b = list.find((s: { id: string }) => s.id === btc.id);
    expect(b.stats.reactions.fire).toBe(1);
    expect(b.viewer).toEqual({ reaction: 'fire', bookmarked: true });
    const g = list.find((s: { id: string }) => s.id === gold.id);
    expect(g).not.toHaveProperty('stats');
    expect(g).not.toHaveProperty('viewer');
  });
});
