import { describe, expect, it } from 'vitest';
import { createSignal, get, send, setup, signalPayload, SECRET } from './helpers.js';

const post = (ctx: Awaited<ReturnType<typeof setup>>, cookie: string | undefined, payload: unknown) =>
  send(ctx, 'POST', '/api/admin/signals', cookie, payload);

describe('signal creation', () => {
  it('only admins can publish; visitors get 401, everyone else 403', async () => {
    const ctx = await setup();
    expect((await post(ctx, undefined, signalPayload())).statusCode).toBe(401);
    for (const role of ['free', 'premium', 'moderator'] as const) expect((await post(ctx, ctx.cookies[role], signalPayload())).statusCode, role).toBe(403);
    expect((await post(ctx, ctx.cookies.admin, signalPayload())).statusCode).toBe(201);
  });

  it('stores every structured field, normalises the asset and starts active with a history entry', async () => {
    const ctx = await setup();
    const res = await post(ctx, ctx.cookies.admin, signalPayload({ asset: ' btc/usd ', timeframe: 'H4', riskLevel: 'high', direction: 'sell', entry: 100, stopLoss: 110, takeProfit1: 90, takeProfit2: 80, takeProfit3: 70 }));
    const { signal, updates } = res.json();
    expect(signal).toMatchObject({
      asset: 'BTC/USD', direction: 'sell', timeframe: 'H4', riskLevel: 'high', entry: 100, stopLoss: 110,
      takeProfits: [90, 80, 70], status: 'active', result: null, pips: null, closedAt: null, visibility: 'premium', locked: false,
    });
    expect(signal.createdAt).toBeTruthy();
    expect(signal.updatedAt).toBeTruthy();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ kind: 'created', message: 'BTC/USD Sell published' });
  });

  it('allows optional TP2/TP3 and defaults analysis/teaser', async () => {
    const ctx = await setup();
    const res = await post(ctx, ctx.cookies.admin, { asset: 'EURUSD', direction: 'buy', timeframe: 'M15', entry: 1.1, stopLoss: 1.09, takeProfit1: 1.12, riskLevel: 'low', visibility: 'free' });
    expect(res.statusCode).toBe(201);
    expect(res.json().signal).toMatchObject({ takeProfits: [1.12], analysis: '' });
  });

  it.each([
    ['buy with stop above entry', { stopLoss: 2400 }],
    ['sell with stop below entry', { direction: 'sell' }],
    ['buy with TP below entry', { takeProfit1: 2300 }],
    ['TP2 not beyond TP1', { takeProfit2: 2355 }],
    ['TP3 without TP2', { takeProfit2: null, takeProfit3: 2400 }],
    ['unknown timeframe', { timeframe: 'H7' }],
    ['bad asset', { asset: '!!' }],
    ['negative price', { entry: -1 }],
    ['unknown risk level', { riskLevel: 'extreme' }],
    ['unknown visibility', { visibility: 'vip' }],
    ['analysis too long', { analysis: 'x'.repeat(5001) }],
  ])('rejects %s', async (_name, over) => {
    const ctx = await setup();
    const res = await post(ctx, ctx.cookies.admin, signalPayload(over));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
  });

  it('rejects missing required fields', async () => {
    const ctx = await setup();
    expect((await post(ctx, ctx.cookies.admin, { asset: 'XAUUSD' })).statusCode).toBe(400);
  });
});

describe('editing, updates and history', () => {
  it('moving SL to entry records a readable "breakeven" history entry', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    const res = await send(ctx, 'PATCH', `/api/admin/signals/${sig.id}`, ctx.cookies.admin, { stopLoss: SECRET.entry });
    expect(res.statusCode).toBe(200);
    const { signal, updates } = res.json();
    expect(signal.stopLoss).toBe(SECRET.entry);
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({ kind: 'sl_moved', message: `Stop loss moved to breakeven (${SECRET.entry})`, changes: { stopLoss: { from: SECRET.stopLoss, to: SECRET.entry } } });
  });

  it('a custom note replaces the auto message but the structured change is still recorded', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    const { updates } = (await send(ctx, 'PATCH', `/api/admin/signals/${sig.id}`, ctx.cookies.admin, { stopLoss: 2345, note: 'Locking in some profit' })).json();
    expect(updates[1]).toMatchObject({ kind: 'sl_moved', message: 'Locking in some profit', changes: { stopLoss: { to: 2345 } } });
  });

  it('trailing the stop beyond entry is allowed after publishing', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    expect((await send(ctx, 'PATCH', `/api/admin/signals/${sig.id}`, ctx.cookies.admin, { stopLoss: 2355 })).statusCode).toBe(200);
  });

  it('classifies target edits and mixed edits, and moves updatedAt forward', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    const tp = (await send(ctx, 'PATCH', `/api/admin/signals/${sig.id}`, ctx.cookies.admin, { takeProfit2: 2375 })).json();
    expect(tp.updates[1]).toMatchObject({ kind: 'tp_updated', message: `Take profit 2 moved from ${SECRET.tp2} to 2375` });
    const mixed = (await send(ctx, 'PATCH', `/api/admin/signals/${sig.id}`, ctx.cookies.admin, { riskLevel: 'high', takeProfit3: null })).json();
    expect(mixed.updates[2]).toMatchObject({ kind: 'edited' });
    expect(mixed.updates[2].message).toContain('Take profit 3 removed');
    expect(mixed.updates[2].message).toContain('Risk level changed from medium to high');
    expect(new Date(mixed.signal.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(sig.createdAt as string).getTime());
  });

  it('analysis edits are recorded without copying the text into history', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    const body = (await send(ctx, 'PATCH', `/api/admin/signals/${sig.id}`, ctx.cookies.admin, { analysis: 'NEW-TEXT-123' })).json();
    expect(body.signal.analysis).toBe('NEW-TEXT-123');
    expect(body.updates[1].message).toBe('Analysis updated');
    expect(JSON.stringify(body.updates)).not.toContain('NEW-TEXT-123');
    expect(JSON.stringify(body.updates)).not.toContain('SECRET-ANALYSIS');
  });

  it('rejects empty edits, no-op edits and edits that break level ordering', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    const url = `/api/admin/signals/${sig.id}`;
    expect((await send(ctx, 'PATCH', url, ctx.cookies.admin, {})).statusCode).toBe(400);
    expect((await send(ctx, 'PATCH', url, ctx.cookies.admin, { entry: SECRET.entry })).statusCode).toBe(400);
    expect((await send(ctx, 'PATCH', url, ctx.cookies.admin, { takeProfit1: 2300 })).statusCode).toBe(400);
    expect((await get(ctx, url.replace('/admin', ''), ctx.cookies.admin)).json().updates).toHaveLength(1); // nothing was logged
  });

  it('free-text updates are appended to history without changing fields', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    const res = await send(ctx, 'POST', `/api/admin/signals/${sig.id}/updates`, ctx.cookies.admin, { message: 'Price approaching TP1' });
    expect(res.statusCode).toBe(201);
    expect(res.json().updates[1]).toMatchObject({ kind: 'note', message: 'Price approaching TP1' });
    expect((await send(ctx, 'POST', `/api/admin/signals/${sig.id}/updates`, ctx.cookies.admin, { message: '  ' })).statusCode).toBe(400);
  });

  it('history is shown to authorized members only, in chronological order', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    await send(ctx, 'PATCH', `/api/admin/signals/${sig.id}`, ctx.cookies.admin, { stopLoss: SECRET.entry });
    const premium = (await get(ctx, `/api/signals/${sig.id}`, ctx.cookies.premium)).json();
    expect(premium.updates.map((u: { kind: string }) => u.kind)).toEqual(['created', 'sl_moved']);
    const free = await get(ctx, `/api/signals/${sig.id}`, ctx.cookies.free);
    expect(free.json().updates).toBeNull();
    expect(free.body).not.toContain('breakeven');
  });

  it('only admins can edit, update or close', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    for (const role of ['free', 'premium', 'moderator'] as const) {
      expect((await send(ctx, 'PATCH', `/api/admin/signals/${sig.id}`, ctx.cookies[role], { stopLoss: 1 })).statusCode).toBe(403);
      expect((await send(ctx, 'POST', `/api/admin/signals/${sig.id}/updates`, ctx.cookies[role], { message: 'x' })).statusCode).toBe(403);
      expect((await send(ctx, 'POST', `/api/admin/signals/${sig.id}/close`, ctx.cookies[role], { result: 'breakeven' })).statusCode).toBe(403);
    }
    expect((await send(ctx, 'PATCH', `/api/admin/signals/${sig.id}`, undefined, { stopLoss: 1 })).statusCode).toBe(401);
  });

  it('unknown or malformed ids are 404', async () => {
    const ctx = await setup();
    expect((await send(ctx, 'PATCH', '/api/admin/signals/not-a-uuid', ctx.cookies.admin, { stopLoss: 1 })).statusCode).toBe(404);
    expect((await send(ctx, 'POST', '/api/admin/signals/00000000-0000-4000-8000-000000000000/close', ctx.cookies.admin, { result: 'breakeven' })).statusCode).toBe(404);
  });
});

describe('closing a signal', () => {
  const close = (ctx: Awaited<ReturnType<typeof setup>>, id: string, payload: unknown) =>
    send(ctx, 'POST', `/api/admin/signals/${id}/close`, ctx.cookies.admin, payload);

  it('records TP hit with level, pips, closed timestamp and a history entry', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    const res = await close(ctx, sig.id, { result: 'tp_hit', tpLevel: 2, pips: 215, note: 'Great move' });
    expect(res.statusCode).toBe(200);
    const { signal, updates } = res.json();
    expect(signal).toMatchObject({ status: 'closed', result: 'tp_hit', tpLevel: 2, pips: 215 });
    expect(signal.closedAt).toBeTruthy();
    expect(updates.at(-1)).toMatchObject({ kind: 'closed', message: 'Closed: TP2 hit (+215 pips). Great move' });
  });

  it('records SL hit with negative pips, breakeven and cancelled', async () => {
    const ctx = await setup();
    const a = await createSignal(ctx);
    expect((await close(ctx, a.id, { result: 'sl_hit', pips: -110 })).json().signal).toMatchObject({ result: 'sl_hit', pips: -110 });
    const b = await createSignal(ctx);
    expect((await close(ctx, b.id, { result: 'breakeven' })).json().signal).toMatchObject({ result: 'breakeven', pips: null });
    const c = await createSignal(ctx);
    const res = await close(ctx, c.id, { result: 'cancelled' });
    expect(res.json().signal).toMatchObject({ status: 'closed', result: 'cancelled' });
    expect(res.json().updates.at(-1).message).toBe('Closed: Cancelled');
  });

  it.each([
    ['tp_hit without a level', { result: 'tp_hit' }],
    ['tpLevel with a non-TP result', { result: 'sl_hit', tpLevel: 1 }],
    ['pips on a cancelled signal', { result: 'cancelled', pips: 5 }],
    ['unknown result', { result: 'won' }],
    ['absurd pips', { result: 'tp_hit', tpLevel: 1, pips: 1e9 }],
  ])('rejects %s', async (_n, payload) => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    expect((await close(ctx, sig.id, payload)).statusCode).toBe(400);
  });

  it('cannot record a hit on a take profit the signal does not have', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx, { takeProfit2: null, takeProfit3: null });
    expect((await close(ctx, sig.id, { result: 'tp_hit', tpLevel: 3 })).statusCode).toBe(400);
  });

  it('a closed signal is immutable: no edits, notes or second close', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    await close(ctx, sig.id, { result: 'breakeven' });
    expect((await send(ctx, 'PATCH', `/api/admin/signals/${sig.id}`, ctx.cookies.admin, { stopLoss: 1 })).statusCode).toBe(409);
    expect((await send(ctx, 'POST', `/api/admin/signals/${sig.id}/updates`, ctx.cookies.admin, { message: 'x' })).statusCode).toBe(409);
    expect((await close(ctx, sig.id, { result: 'sl_hit' })).statusCode).toBe(409);
  });

  it('closed premium signals keep their levels locked but show the outcome label (not pips) to free members', async () => {
    const ctx = await setup();
    const sig = await createSignal(ctx);
    await close(ctx, sig.id, { result: 'tp_hit', tpLevel: 1, pips: 987 });
    const res = await get(ctx, `/api/signals/${sig.id}`, ctx.cookies.free);
    expect(res.json().signal).toMatchObject({ locked: true, status: 'closed', result: 'tp_hit' });
    expect(res.body).not.toContain('987');
    expect(res.body).not.toContain(String(SECRET.entry));
  });
});
