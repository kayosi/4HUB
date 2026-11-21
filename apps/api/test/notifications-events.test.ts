import { beforeAll, describe, expect, it } from 'vitest';
import { SECRET, countRows, createSignal, deliver, get, loginCookie, pay, row, seedUser, send, setup, startPayment, type Ctx } from './helpers.js';

interface Note { id: string; category: string; type: string; title: string; body: string; data: Record<string, unknown>; user_id: string; dedupe_key: string | null }
const notes = (ctx: Ctx, userId: string, type?: string) =>
  row<Note>(ctx, `select * from notifications where user_id = $1 ${type ? 'and type = $2' : ''} order by seq`, type ? [userId, type] : [userId]);
const types = async (ctx: Ctx, userId: string) => (await notes(ctx, userId)).map((n) => n.type);
const setPrefs = (ctx: Ctx, userId: string, prefs: Record<string, boolean>) =>
  ctx.db.query('update users set notification_prefs = $2::jsonb where id = $1', [userId, JSON.stringify(prefs)]);
const everything = async (ctx: Ctx) => JSON.stringify(await row(ctx, 'select title, body, data from notifications'));
const DAY = 86_400_000;
const adminSend = (ctx: Ctx, method: 'POST' | 'PATCH', url: string, body?: unknown) => send(ctx, method, url, ctx.cookies.admin, body);

// ------------------------------------------------------------------------------------------------ signals
describe('signal notifications', () => {
  let ctx: Ctx; let optedOut: string;
  beforeAll(async () => {
    ctx = await setup();
    optedOut = (await seedUser(ctx.db, 'free', 'optedout@example.com')).id;
    await setPrefs(ctx, optedOut, { newSignals: false, signalUpdates: false, announcements: false });
  });
  const published = (c: Ctx, userId: string) => notes(c, userId, 'signal.published');

  it('announces a new signal to opted-in members, not to its author or to members who opted out', async () => {
    const sig = await createSignal(ctx); // premium by default
    for (const who of ['free', 'premium', 'moderator'] as const) {
      const [n, ...rest] = await published(ctx, ctx.users[who].id);
      expect(rest, who).toHaveLength(0);
      expect(n).toMatchObject({ category: 'signal', type: 'signal.published', title: 'New signal: XAUUSD Buy', data: { signalId: sig.id, visibility: 'premium' } });
      expect(n!.body).toBe('H1 · Premium signal');
    }
    expect(await published(ctx, ctx.users.admin.id)).toHaveLength(0); // the author knows
    expect(await published(ctx, optedOut)).toHaveLength(0);
  });

  it('says only what the public (locked) view already shows: never entry, stops, targets or analysis', async () => {
    await createSignal(ctx, { asset: 'eurusd', direction: 'sell', entry: 1.1, stopLoss: 1.15, takeProfit1: 1.05, takeProfit2: 1.04, takeProfit3: 1.03 });
    const all = await everything(ctx);
    for (const secret of [String(SECRET.entry), String(SECRET.stopLoss), String(SECRET.tp1), String(SECRET.tp2), String(SECRET.tp3), SECRET.analysis]) expect(all).not.toContain(secret);
    expect((await published(ctx, ctx.users.free.id)).some((n) => n.title === 'New signal: EURUSD Sell')).toBe(true);
  });

  it('labels free signals as free', async () => {
    await createSignal(ctx, { asset: 'gbpusd', visibility: 'free' });
    const n = (await published(ctx, ctx.users.free.id)).find((x) => x.title.includes('GBPUSD'))!;
    expect(n.body).toBe('H1 · Free signal');
  });

  it('tells only people who can see a premium signal about its updates, without the changed values', async () => {
    const sig = await createSignal(ctx, { asset: 'usdjpy' });
    const res = await adminSend(ctx, 'PATCH', `/api/admin/signals/${sig.id}`, { stopLoss: 2345.55, note: 'SECRET-NOTE-TEXT' });
    expect(res.statusCode).toBe(200);
    const get$ = (id: string) => notes(ctx, id, 'signal.updated');
    for (const who of ['premium', 'moderator'] as const) {
      const [n] = await get$(ctx.users[who].id);
      expect(n, who).toMatchObject({ title: 'Signal updated: USDJPY Buy', data: { signalId: sig.id, visibility: 'premium' } });
      expect(n!.body).toBe('There is an update on this premium signal. Open it to see the details.');
    }
    expect(await get$(ctx.users.free.id)).toHaveLength(0); // cannot see the signal, so no update
    expect(await get$(ctx.users.admin.id)).toHaveLength(0);
    expect(await get$(optedOut)).toHaveLength(0);
    const all = await everything(ctx);
    expect(all).not.toContain('SECRET-NOTE-TEXT');
    expect(all).not.toContain('2345.55');
  });

  it('includes the update text for free signals, to every opted-in member', async () => {
    const sig = await createSignal(ctx, { asset: 'audusd', visibility: 'free' });
    const res = await adminSend(ctx, 'PATCH', `/api/admin/signals/${sig.id}`, { stopLoss: 2345.55 });
    const message = (res.json().updates as { message: string }[]).at(-1)!.message;
    for (const who of ['free', 'premium', 'moderator'] as const) {
      const [n] = (await notes(ctx, ctx.users[who].id, 'signal.updated')).filter((x) => (x.data.signalId as string) === sig.id);
      expect(n!.body, who).toBe(message);
    }
  });

  it('notifies for each separate update, and for free-text notes', async () => {
    const sig = await createSignal(ctx, { asset: 'nzdusd', visibility: 'free' });
    await adminSend(ctx, 'POST', `/api/admin/signals/${sig.id}/updates`, { message: 'First note' });
    await adminSend(ctx, 'POST', `/api/admin/signals/${sig.id}/updates`, { message: 'Second note' });
    const bodies = (await notes(ctx, ctx.users.free.id, 'signal.updated')).filter((n) => n.data.signalId === sig.id).map((n) => n.body);
    expect(bodies).toEqual(['First note', 'Second note']);
  });

  it('announces a closure with the result, to the right audience', async () => {
    const prem = await createSignal(ctx, { asset: 'cadjpy' });
    const free = await createSignal(ctx, { asset: 'chfjpy', visibility: 'free' });
    expect((await adminSend(ctx, 'POST', `/api/admin/signals/${prem.id}/close`, { result: 'tp_hit', tpLevel: 2 })).statusCode).toBe(200);
    expect((await adminSend(ctx, 'POST', `/api/admin/signals/${free.id}/close`, { result: 'sl_hit' })).statusCode).toBe(200);
    const closed = (id: string) => notes(ctx, id, 'signal.closed');
    const premClosed = (await closed(ctx.users.premium.id)).find((n) => n.data.signalId === prem.id)!;
    expect(premClosed).toMatchObject({ title: 'Signal closed: CADJPY Buy', body: 'Take profit hit.', data: { result: 'tp_hit' } });
    expect((await closed(ctx.users.free.id)).some((n) => n.data.signalId === prem.id)).toBe(false); // free members never saw this signal's details
    expect((await closed(ctx.users.free.id)).find((n) => n.data.signalId === free.id)).toMatchObject({ body: 'Stop loss hit.' });
    expect(await closed(optedOut)).toHaveLength(0);
  });

  it('respects the two signal preferences independently', async () => {
    const onlyNew = (await seedUser(ctx.db, 'free', 'onlynew@example.com')).id;
    const onlyUpdates = (await seedUser(ctx.db, 'free', 'onlyupdates@example.com')).id;
    await setPrefs(ctx, onlyNew, { newSignals: true, signalUpdates: false, announcements: false });
    await setPrefs(ctx, onlyUpdates, { newSignals: false, signalUpdates: true, announcements: false });
    const sig = await createSignal(ctx, { asset: 'eurgbp', visibility: 'free' });
    await adminSend(ctx, 'PATCH', `/api/admin/signals/${sig.id}`, { stopLoss: 2345.55 });
    expect(await types(ctx, onlyNew)).toEqual(['signal.published']);
    expect(await types(ctx, onlyUpdates)).toEqual(['signal.updated']);
  });

  it('stops premium-signal updates for lapsed members, but not for members still in their grace period', async () => {
    const own = await setup();
    const lapsed = await seedUser(own.db, 'free', 'lapsed@example.com'); const inGrace = await seedUser(own.db, 'free', 'ingrace@example.com');
    const graceDays = own.app.config.SUBSCRIPTION_GRACE_DAYS;
    await own.app.billing.grant(own.users.admin.id, lapsed.id, 'premium_monthly', 1, 'fixture');
    own.clock.advanceDays(graceDays + 2); // lapsed: period and grace both over
    await own.app.billing.grant(own.users.admin.id, inGrace.id, 'premium_monthly', 1, 'fixture');
    own.clock.advanceMs(1.5 * DAY); // inGrace: period over 12h ago, still inside grace
    const sig = await createSignal(own, { asset: 'xagusd' });
    await adminSend(own, 'PATCH', `/api/admin/signals/${sig.id}`, { stopLoss: 2345.55 });
    expect(await notes(own, lapsed.id, 'signal.updated')).toHaveLength(0);
    expect(await notes(own, inGrace.id, 'signal.updated')).toHaveLength(1);
    expect(await notes(own, own.users.premium.id, 'signal.updated')).toHaveLength(1);
    expect(await notes(own, lapsed.id, 'signal.published')).toHaveLength(1); // everyone hears about new signals
  });

  it('never notifies twice when the same event is announced again', async () => {
    const sig = await createSignal(ctx, { asset: 'btcusd' });
    const key = `signal:${sig.id}:published`;
    const recipients = await countRows(ctx, 'notifications', 'dedupe_key = $1', [key]);
    expect(recipients).toBeGreaterThan(0);
    const payload = { signalId: sig.id, asset: 'BTCUSD', direction: 'buy' as const, timeframe: 'H1', visibility: 'premium' as const, actorId: ctx.users.admin.id };
    await ctx.app.events.emit('signal.published', payload);
    await ctx.app.events.emit('signal.published', payload);
    expect(await countRows(ctx, 'notifications', 'dedupe_key = $1', [key])).toBe(recipients);
    expect((await notes(ctx, ctx.users.free.id, 'signal.published')).filter((n) => n.data.signalId === sig.id)).toHaveLength(1);
  });

  it('does not fail publishing when a listener breaks or notification storage is down', async () => {
    ctx.app.events.on('signal.published', () => { throw new Error('another listener broke'); });
    const original = ctx.app.notifications.notifyMany.bind(ctx.app.notifications);
    ctx.app.notifications.notifyMany = async () => { throw new Error('notification storage is down'); };
    const res = await adminSend(ctx, 'POST', '/api/admin/signals', { asset: 'xauusd', direction: 'buy', timeframe: 'H1', entry: 1, stopLoss: 0.5, takeProfit1: 2, riskLevel: 'low', analysis: 'x', teaser: 'y', visibility: 'free' });
    ctx.app.notifications.notifyMany = original;
    expect(res.statusCode).toBe(201);
    expect(await countRows(ctx, 'signals', 'id = $1', [res.json().signal.id])).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------ payments and subscriptions
describe('payment and subscription notifications', () => {
  it('thanks the payer and confirms the activation, with the amount, plan and end date, and tells nobody else', async () => {
    const ctx = await setup();
    const t0 = ctx.clock.now();
    const r = await pay(ctx, ctx.cookies.free);
    const [pay1] = await notes(ctx, ctx.users.free.id, 'payment.succeeded');
    expect(pay1).toMatchObject({ category: 'payment', title: 'Payment received', data: { paymentId: r.id } });
    expect(pay1!.body).toMatch(/^We received KES 1,500\.00 for .+\. Thank you\.$/);
    const [act] = await notes(ctx, ctx.users.free.id, 'subscription.activated');
    expect(act).toMatchObject({ category: 'subscription', data: { tier: 'premium', paymentId: r.id } });
    expect(act!.title).toMatch(/activated$/);
    expect(act!.body).toBe(`Your access runs until ${new Date(t0.getTime() + 30 * DAY).toISOString().slice(0, 10)}.`);
    expect(await notes(ctx, ctx.users.moderator.id, 'payment.succeeded')).toHaveLength(0);
    expect((await notes(ctx, ctx.users.premium.id)).every((n) => n.type === 'subscription.granted')).toBe(true); // only the fixture's grant
  });

  it('notifies once even when the provider redelivers, replays with a new event id, or the customer re-verifies', async () => {
    const ctx = await setup();
    const p = await startPayment(ctx, ctx.cookies.free);
    const evt = ctx.mock.settle(p.reference, 'succeeded', 'evt-1');
    expect((await deliver(ctx, evt)).json().outcome).toBe('applied');
    for (let i = 0; i < 3; i++) expect((await deliver(ctx, evt)).json().outcome).toBe('duplicate');
    ctx.mock.settle(p.reference, 'succeeded', 'evt-2');
    expect((await deliver(ctx, ctx.mock.signedEvent({ id: 'evt-2', type: 'payment.succeeded', reference: p.reference }))).json().outcome).toBe('ignored');
    await send(ctx, 'POST', `/api/billing/payments/${p.id}/verify`, ctx.cookies.free);
    expect(await notes(ctx, ctx.users.free.id, 'payment.succeeded')).toHaveLength(1);
    expect(await notes(ctx, ctx.users.free.id, 'subscription.activated')).toHaveLength(1);
  });

  it('says "renewed" for a renewal, and keeps a separate payment notice for each payment', async () => {
    const ctx = await setup();
    await pay(ctx, ctx.cookies.free);
    await pay(ctx, ctx.cookies.free);
    expect(await types(ctx, ctx.users.free.id)).toEqual(['payment.succeeded', 'subscription.activated', 'payment.succeeded', 'subscription.renewed']);
    const renewed = (await notes(ctx, ctx.users.free.id, 'subscription.renewed'))[0]!;
    expect(renewed.title).toMatch(/renewed$/);
    expect(renewed.body).toMatch(/^Your access now runs until \d{4}-\d{2}-\d{2}\.$/);
  });

  it('reports a failed payment plainly, without internal failure codes, and grants nothing', async () => {
    const ctx = await setup();
    const r = await pay(ctx, ctx.cookies.free, 'premium_monthly', 'failed');
    const [n] = await notes(ctx, ctx.users.free.id);
    expect(await types(ctx, ctx.users.free.id)).toEqual(['payment.failed']);
    expect(n).toMatchObject({ category: 'payment', title: 'Payment failed', data: { paymentId: r.id } });
    expect(n!.body).toMatch(/^Your KES 1,500\.00 payment for .+ could not be completed\. You can try again from the billing page\.$/);
    const p = (await row<{ failure_reason: string | null }>(ctx, 'select failure_reason from payments where id = $1', [r.id]))[0]!;
    if (p.failure_reason) expect(n!.body).not.toContain(p.failure_reason);
  });

  it('does not alarm a customer who cancelled the payment themselves', async () => {
    const ctx = await setup();
    await pay(ctx, ctx.cookies.free, 'premium_monthly', 'cancelled');
    expect(await notes(ctx, ctx.users.free.id)).toHaveLength(0);
  });

  it('explains an amount mismatch without granting access', async () => {
    const ctx = await setup();
    const p = await startPayment(ctx, ctx.cookies.free);
    ctx.mock.settle(p.reference, 'succeeded', 'ignored-evt');
    await deliver(ctx, ctx.mock.signedEvent({ id: 'under-1', type: 'payment.succeeded', reference: p.reference, amountMinor: 100, currency: 'KES' }));
    const [n] = await notes(ctx, ctx.users.free.id, 'payment.failed');
    expect(n!.body).toContain('could not verify the amount');
    expect(n!.body).toContain('no access was granted');
    expect(await notes(ctx, ctx.users.free.id, 'subscription.activated')).toHaveLength(0);
  });

  it('notifies about a full provider refund, once, and about each further partial refund', async () => {
    const ctx = await setup();
    const full = await pay(ctx, ctx.cookies.free);
    const refundEvt = (ref: string, id: string, amount?: number) => ctx.mock.signedEvent({ id, type: 'payment.refunded', reference: ref, ...(amount ? { refundAmountMinor: amount } : {}) });
    expect((await deliver(ctx, refundEvt(full.reference, 'rf-1'))).json().outcome).toBe('applied');
    expect((await deliver(ctx, refundEvt(full.reference, 'rf-1'))).json().outcome).toBe('duplicate');
    const [n, ...more] = await notes(ctx, ctx.users.free.id, 'payment.refunded');
    expect(more).toHaveLength(0);
    expect(n).toMatchObject({ title: 'Payment refunded', data: { paymentId: full.id } });
    expect(n!.body).toContain('KES 1,500.00 was refunded');
    expect(n!.body).toContain('access this payment bought has been removed');

    const own = await setup();
    const part = await pay(own, own.cookies.free);
    await deliver(own, own.mock.signedEvent({ id: 'rf-a', type: 'payment.refunded', reference: part.reference, refundAmountMinor: 50000 }));
    await deliver(own, own.mock.signedEvent({ id: 'rf-b', type: 'payment.refunded', reference: part.reference, refundAmountMinor: 25000 }));
    const partials = await notes(own, own.users.free.id, 'payment.refunded');
    expect(partials.map((p) => p.title)).toEqual(['Partial refund issued', 'Partial refund issued']);
    expect(partials.map((p) => p.body.split(' was refunded')[0])).toEqual(['KES 500.00', 'KES 250.00']);
    expect(partials[0]!.body).not.toContain('removed');
  });

  it('notifies about an administrator-recorded refund', async () => {
    const ctx = await setup();
    const r = await pay(ctx, ctx.cookies.free);
    expect((await adminSend(ctx, 'POST', `/api/admin/payments/${r.id}/refund`, { reason: 'customer request', amountMinor: 100000 })).statusCode).toBe(200);
    const [n] = await notes(ctx, ctx.users.free.id, 'payment.refunded');
    expect(n).toMatchObject({ title: 'Partial refund issued' });
    expect(n!.body).toContain('KES 1,000.00');
    expect(n!.body).not.toContain('customer request'); // internal reasons stay internal
  });

  it('tells a member when an administrator grants access, with the end date, and again for a later grant', async () => {
    const ctx = await setup();
    const [first] = await notes(ctx, ctx.users.premium.id, 'subscription.granted');
    expect(first!.body).toBe(`An administrator gave you ${first!.title.replace('You now have ', '')} access until ${new Date(ctx.clock.now().getTime() + 30 * DAY).toISOString().slice(0, 10)}.`);
    ctx.clock.advanceMs(1000);
    await ctx.app.billing.grant(ctx.users.admin.id, ctx.users.premium.id, 'premium_monthly', 30, 'extension');
    expect(await notes(ctx, ctx.users.premium.id, 'subscription.granted')).toHaveLength(2);
    expect(JSON.stringify(await notes(ctx, ctx.users.premium.id))).not.toContain('extension');
  });

  it('tells a member when their access is revoked, without the administrator\'s reason', async () => {
    const ctx = await setup();
    const res = await adminSend(ctx, 'POST', `/api/admin/users/${ctx.users.premium.id}/subscription/revoke`, { tier: 'premium', reason: 'INTERNAL-ADMIN-REASON chargeback' });
    expect(res.statusCode).toBeLessThan(300);
    const [n] = await notes(ctx, ctx.users.premium.id, 'subscription.revoked');
    expect(n).toMatchObject({ category: 'subscription', title: 'Premium access ended' });
    expect(JSON.stringify(await notes(ctx, ctx.users.premium.id))).not.toContain('INTERNAL-ADMIN-REASON');
    expect(await notes(ctx, ctx.users.free.id)).toHaveLength(0);
  });

  it('does not fail a payment when notifications cannot be stored', async () => {
    const ctx = await setup();
    ctx.app.notifications.create = async () => { throw new Error('notification storage is down'); };
    const r = await pay(ctx, ctx.cookies.free);
    expect(r.res.json().outcome).toBe('applied');
    expect((await get(ctx, '/api/me', ctx.cookies.free)).json().user.access.premium).toBe(true); // access was granted regardless
    expect(await countRows(ctx, 'invoices', 'payment_id = $1', [r.id])).toBe(1);
  });

  it('sends payment and subscription notices regardless of notification preferences', async () => {
    const ctx = await setup();
    await setPrefs(ctx, ctx.users.free.id, { newSignals: false, signalUpdates: false, announcements: false });
    await pay(ctx, ctx.cookies.free);
    expect(await types(ctx, ctx.users.free.id)).toEqual(['payment.succeeded', 'subscription.activated']);
  });
});

// ------------------------------------------------------------------------------------------------ community moderation
describe('community notifications', () => {
  let ctx: Ctx; let author: { id: string; cookie: string }; let bystander: { id: string; cookie: string };
  let n = 0;
  const makeRoom = async (name = 'Gold Talk') => {
    n += 1;
    return (await adminSend(ctx, 'POST', '/api/staff/rooms', { name: `${name} ${n}`, slug: `notif-room-${n}`, description: 'd', category: 'general_discussion' })).json().room as { id: string; slug: string; name: string };
  };
  const say = async (slug: string, cookie: string, body = 'a message') => (await send(ctx, 'POST', `/api/rooms/${slug}/messages`, cookie, { body })).json().message as { id: string };
  const report = (slug: string, id: string, cookie: string) => send(ctx, 'POST', `/api/rooms/${slug}/messages/${id}/report`, cookie, { reason: 'spam' });
  beforeAll(async () => {
    ctx = await setup({ REPORTS_PER_HOUR: '1000', REPORTS_PER_DAY: '1000', CHAT_WRITES_PER_MINUTE: '100000' });
    const a = await seedUser(ctx.db, 'free', 'author@example.com'); author = { id: a.id, cookie: await loginCookie(ctx.app, 'author@example.com') };
    const b = await seedUser(ctx.db, 'free', 'bystander@example.com'); bystander = { id: b.id, cookie: await loginCookie(ctx.app, 'bystander@example.com') };
    for (const id of [a.id, b.id, ctx.users.free.id, ctx.users.premium.id]) await setPrefs(ctx, id, { newSignals: false, signalUpdates: false, announcements: false }); // moderation notices ignore preferences
  });

  it('tells the author a message was hidden, with the room and reason, and tells reporters it was reviewed, but not who reported', async () => {
    const room = await makeRoom();
    const m = await say(room.slug, author.cookie);
    await report(room.slug, m.id, ctx.cookies.free); await report(room.slug, m.id, ctx.cookies.premium);
    ctx.clock.advanceMs(1000);
    expect((await send(ctx, 'POST', `/api/moderation/messages/${m.id}/hide`, ctx.cookies.moderator, { reason: 'Spam link' })).statusCode).toBe(200);

    const [h] = await notes(ctx, author.id, 'community.message_hidden');
    expect(h).toMatchObject({ category: 'community', title: 'A moderator hid your message', data: { roomSlug: room.slug, messageId: m.id } });
    expect(h!.body).toBe(`Your message in ${room.name} was hidden while it is reviewed. Reason: Spam link`);
    expect(h!.body).not.toMatch(/free user|premium user|moderator user/); // neither reporters nor the moderator are named
    for (const who of [ctx.users.free.id, ctx.users.premium.id]) {
      const [r] = await notes(ctx, who, 'community.report_reviewed');
      expect(r).toMatchObject({ title: 'Your report was reviewed', data: { outcome: 'resolved' } });
      expect(r!.body).toContain('took action');
    }
    expect(await notes(ctx, bystander.id)).toHaveLength(0);
    expect(await notes(ctx, ctx.users.moderator.id)).toHaveLength(0); // the actor is not told about their own action
  });

  it('tells the author when a hidden message is restored, and again if it is hidden a second time', async () => {
    const room = await makeRoom();
    const m = await say(room.slug, author.cookie);
    const hide = () => send(ctx, 'POST', `/api/moderation/messages/${m.id}/hide`, ctx.cookies.moderator, { reason: 'Review' });
    await hide(); ctx.clock.advanceMs(1000);
    await send(ctx, 'POST', `/api/moderation/messages/${m.id}/unhide`, ctx.cookies.moderator); ctx.clock.advanceMs(1000);
    await hide();
    const mine = (await notes(ctx, author.id)).filter((x) => x.data.messageId === m.id).map((x) => x.type);
    expect(mine).toEqual(['community.message_hidden', 'community.message_restored', 'community.message_hidden']);
  });

  it('tells the author a message was removed, and tells reporters it was reviewed', async () => {
    const room = await makeRoom();
    const m = await say(room.slug, author.cookie);
    await report(room.slug, m.id, ctx.cookies.free);
    await send(ctx, 'POST', `/api/moderation/messages/${m.id}/remove`, ctx.cookies.admin, { reason: 'Abuse' });
    const [rm] = (await notes(ctx, author.id, 'community.message_removed')).filter((x) => x.data.messageId === m.id);
    expect(rm!.body).toBe(`Your message in ${room.name} was removed. Reason: Abuse`);
    expect((await notes(ctx, ctx.users.free.id, 'community.report_reviewed')).length).toBeGreaterThanOrEqual(1);
  });

  it('tells only the person who filed a report what its outcome was', async () => {
    const room = await makeRoom();
    const m = await say(room.slug, author.cookie);
    const rep = (await report(room.slug, m.id, bystander.cookie)).json().report;
    await report(room.slug, m.id, ctx.cookies.free);
    await send(ctx, 'POST', `/api/moderation/reports/${rep.id}/dismiss`, ctx.cookies.moderator, {});
    const [d] = await notes(ctx, bystander.id, 'community.report_reviewed');
    expect(d).toMatchObject({ data: { outcome: 'dismissed' } });
    expect(d!.body).toBe('A moderator reviewed your report and decided no action was needed.');
    expect((await notes(ctx, ctx.users.free.id, 'community.report_reviewed')).filter((x) => x.dedupe_key !== null && x.dedupe_key.includes(rep.id))).toHaveLength(0);
    expect(await notes(ctx, author.id, 'community.report_reviewed')).toHaveLength(0);
  });

  it('tells a member about a mute and its lifting, and a suspended member sees the notice once the suspension ends', async () => {
    const u = await seedUser(ctx.db, 'free', 'restricted@example.com');
    const cookie = await loginCookie(ctx.app, 'restricted@example.com');
    const mute = (await adminSend(ctx, 'POST', `/api/admin/users/${u.id}/restrictions`, { type: 'muted', reason: 'Posting spam', durationHours: 24 })).json().restriction;
    const [m] = await notes(ctx, u.id, 'community.restricted');
    expect(m).toMatchObject({ title: 'You have been muted', data: { restrictionType: 'muted' } });
    expect(m!.body).toMatch(/^You cannot post messages until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\. Reason: Posting spam$/);
    await adminSend(ctx, 'POST', `/api/admin/restrictions/${mute.id}/lift`, {});
    expect((await notes(ctx, u.id, 'community.restriction_lifted'))[0]).toMatchObject({ title: 'Your mute was lifted', body: 'You can post messages again.' });

    const susp = (await adminSend(ctx, 'POST', `/api/admin/users/${u.id}/restrictions`, { type: 'suspended', reason: 'Harassment' })).json().restriction;
    expect((await notes(ctx, u.id, 'community.restricted')).at(-1)).toMatchObject({ title: 'Your account has been suspended' });
    expect((await get(ctx, '/api/notifications', cookie)).statusCode).toBe(403); // suspended: nothing readable
    await adminSend(ctx, 'POST', `/api/admin/restrictions/${susp.id}/lift`, {});
    const feed = (await get(ctx, '/api/notifications', cookie)).json();
    expect(feed.notifications.map((x: { type: string }) => x.type)).toEqual(['community.restriction_lifted', 'community.restricted', 'community.restriction_lifted', 'community.restricted']);
  });
});

// ------------------------------------------------------------------------------------------------ subscription expiry (time-driven)
describe('subscription lifecycle notices', () => {
  const sweep = async (c: Ctx) => (await send(c, 'POST', '/api/admin/notifications/sweep', c.cookies.admin)).json() as { expiring: number; grace: number; expired: number };
  const lifecycle = async (c: Ctx, userId: string) => (await notes(c, userId)).map((x) => x.type).filter((t) => /expir|grace/.test(t));
  const graceDays = (c: Ctx) => c.app.config.SUBSCRIPTION_GRACE_DAYS;

  it('is an administrator-only trigger', async () => {
    const c = await setup();
    expect((await send(c, 'POST', '/api/admin/notifications/sweep')).statusCode).toBe(401);
    for (const who of ['free', 'premium', 'moderator'] as const) expect((await send(c, 'POST', '/api/admin/notifications/sweep', c.cookies[who])).statusCode, who).toBe(403);
  });

  it('sends nothing while a subscription is far from its end, or for members without one', async () => {
    const c = await setup();
    expect(await sweep(c)).toEqual({ expiring: 0, grace: 0, expired: 0 });
    c.clock.advanceDays(26); // 4 days left: outside the 3-day reminder window
    expect(await sweep(c)).toEqual({ expiring: 0, grace: 0, expired: 0 });
  });

  it('reminds shortly before the end, then at grace, then at expiry, each exactly once however often it runs', async () => {
    const c = await setup();
    const end = new Date(c.clock.now().getTime() + 30 * DAY).toISOString().slice(0, 10);
    c.clock.advanceDays(28);
    expect(await sweep(c)).toEqual({ expiring: 1, grace: 0, expired: 0 });
    expect(await sweep(c)).toEqual({ expiring: 0, grace: 0, expired: 0 }); // idempotent
    const [soon] = await notes(c, c.users.premium.id, 'subscription.expiring');
    expect(soon).toMatchObject({ category: 'subscription', data: { tier: 'premium' } });
    expect(soon!.body).toBe(`Your ${soon!.title.replace(' ends soon', '')} expires on ${end}. Renew to keep your access.`);

    c.clock.advanceMs(2.5 * DAY); // period over, inside grace
    expect(await sweep(c)).toEqual({ expiring: 0, grace: 1, expired: 0 });
    expect(await sweep(c)).toEqual({ expiring: 0, grace: 0, expired: 0 });
    expect((await notes(c, c.users.premium.id, 'subscription.grace'))[0]!.body).toContain(`Your period ended on ${end}. You keep access until`);

    c.clock.advanceDays(graceDays(c) + 1); // grace over
    expect(await sweep(c)).toEqual({ expiring: 0, grace: 0, expired: 1 });
    expect(await sweep(c)).toEqual({ expiring: 0, grace: 0, expired: 0 });
    expect(await lifecycle(c, c.users.premium.id)).toEqual(['subscription.expiring', 'subscription.grace', 'subscription.expired']);
    expect(await lifecycle(c, c.users.free.id)).toEqual([]);
  });

  it('does not announce subscriptions that lapsed long ago (switching this on must not message history)', async () => {
    const c = await setup();
    c.clock.advanceDays(30 + graceDays(c) + 8);
    expect(await sweep(c)).toEqual({ expiring: 0, grace: 0, expired: 0 });
    expect(await lifecycle(c, c.users.premium.id)).toEqual([]);
  });

  it('does not announce a cancelled subscription that ended more than a week ago, even though it is inside the search range', async () => {
    const c = await setup();
    await c.db.query('update subscriptions set cancel_at_period_end = true where user_id = $1', [c.users.premium.id]);
    c.clock.advanceDays(30 + 8); // no grace for a cancelled subscription: it ended 8 days ago
    expect(await sweep(c)).toEqual({ expiring: 0, grace: 0, expired: 0 });
    const recent = await setup();
    await recent.db.query('update subscriptions set cancel_at_period_end = true where user_id = $1', [recent.users.premium.id]);
    recent.clock.advanceDays(30 + 6); // ...whereas one that ended 6 days ago is still news
    expect(await sweep(recent)).toEqual({ expiring: 0, grace: 0, expired: 1 });
  });

  it('says the member chose the ending when they cancelled, and goes straight to "expired" (no grace)', async () => {
    const c = await setup();
    await c.db.query('update subscriptions set cancel_at_period_end = true where user_id = $1', [c.users.premium.id]);
    c.clock.advanceDays(28);
    await sweep(c);
    expect((await notes(c, c.users.premium.id, 'subscription.expiring'))[0]!.body).toContain('as you chose');
    c.clock.advanceDays(2.5);
    expect(await sweep(c)).toEqual({ expiring: 0, grace: 0, expired: 1 });
  });

  it('sends a new reminder for the next period after a renewal, and none for the old one', async () => {
    const c = await setup();
    c.clock.advanceDays(28);
    await sweep(c);
    await pay(c, c.cookies.premium); // renews: stacks 30 days onto the current end
    expect(await sweep(c)).toEqual({ expiring: 0, grace: 0, expired: 0 }); // far from the new end
    c.clock.advanceDays(30);
    expect(await sweep(c)).toEqual({ expiring: 1, grace: 0, expired: 0 });
    expect(await lifecycle(c, c.users.premium.id)).toEqual(['subscription.expiring', 'subscription.expiring']);
  });

  it('ignores subscriptions that were revoked', async () => {
    const c = await setup();
    await adminSend(c, 'POST', `/api/admin/users/${c.users.premium.id}/subscription/revoke`, { tier: 'premium', reason: 'fixture reason' });
    c.clock.advanceDays(28);
    expect(await sweep(c)).toEqual({ expiring: 0, grace: 0, expired: 0 });
  });

  it('can be run by the service directly, and reports what it created', async () => {
    const c = await setup();
    c.clock.advanceDays(28);
    expect(await c.app.notifications.sweepSubscriptions()).toEqual({ expiring: 1, grace: 0, expired: 0 });
  });
});
