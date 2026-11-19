import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { AuthProvider } from '../auth/AuthContext';
import type { ChatMessage } from '../lib/chat';
import type { ReportItem, UserRestrictions } from '../lib/moderation';

// ------------------------------------------------------------------------------------------------ harness
type Reply = { status?: number; body?: unknown };
type Call = { method: string; url: string; body?: Record<string, unknown> };
const fail = (status: number, code: string, message = 'x', details?: unknown): Reply => ({ status, body: { error: { code, message, details } } });
const ROOM = { id: 'r1', slug: 'general-chat', name: 'General Chat', description: 'Talk', category: 'general_discussion', access: 'public', locked: false, guidelines: 'Be kind', archived: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' };

const account = (role: string, restrictions: unknown = { muted: null }) => ({ user: {
  id: 'u1', email: 'a@b.co', displayName: 'Ada', role, createdAt: '2026-01-01', country: null, tradingExperience: null, preferredAssets: [],
  notificationPrefs: { newSignals: true, signalUpdates: true, announcements: false }, access: { tier: 'free', premium: false }, restrictions,
} });
const msg = (seq: number, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m${seq}`, seq, roomId: 'r1', author: { id: 'u2', displayName: 'Bob', isStaff: false }, body: `message ${seq}`,
  createdAt: '2026-01-01T10:00:00Z', editedAt: null, deleted: false, moderation: null, ...over,
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 0; onopen: (() => void) | null = null; onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(t: string, fn: (e: { data: string }) => void) { this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]); }
  close() { this.readyState = 2; }
  emit(type: string, data: unknown) { act(() => this.listeners.get(type)?.forEach((fn) => fn({ data: JSON.stringify(data) }))); }
}

/** `route` answers first; unanswered requests get sensible defaults for /me, the room and its messages. */
function server(role: string | null, opts: { messages?: ChatMessage[]; me?: Reply; route?: (url: string, method: string, body?: Record<string, unknown>) => Reply | undefined } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    calls.push({ method, url, ...(body ? { body } : {}) });
    const r: Reply = (() => {
      const o = opts.route?.(url, method, body);
      if (o) return o;
      if (url.endsWith('/api/me')) return opts.me ?? (role ? { body: account(role) } : fail(401, 'UNAUTHENTICATED'));
      if (url === '/api/rooms/general-chat') return { body: { room: ROOM } };
      if (url.startsWith('/api/rooms/general-chat/messages') && method === 'GET') return { body: { messages: opts.messages ?? [], hasMore: false, nextBefore: null } };
      return fail(404, 'NOT_FOUND');
    })();
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body } as Response;
  }));
  return calls;
}
const renderAt = (path: string) => render(<MemoryRouter initialEntries={[path]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
const room = () => renderAt('/rooms/general-chat');
const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST');

beforeEach(() => { FakeEventSource.instances = []; vi.stubGlobal('EventSource', FakeEventSource); });
afterEach(() => vi.unstubAllGlobals());

// ------------------------------------------------------------------------------------------------ reporting
describe('reporting a message', () => {
  it('offers Report on other people\'s messages only', async () => {
    server('free', { messages: [msg(1), msg(2, { author: { id: 'u1', displayName: 'Ada', isStaff: false }, body: 'mine' })] });
    room();
    await screen.findByText('message 1');
    expect(screen.getByRole('button', { name: 'Report message from Bob' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Report message from Ada' })).not.toBeInTheDocument();
  });

  it('sends the reason and details, then confirms and stops offering Report', async () => {
    const calls = server('free', { messages: [msg(1)], route: (url, method) => (method === 'POST' && url.endsWith('/messages/m1/report') ? { status: 201, body: { report: { id: 'p1', status: 'open', createdAt: 'x' } } } : undefined) });
    room();
    await userEvent.click(await screen.findByRole('button', { name: 'Report message from Bob' }));
    await userEvent.selectOptions(screen.getByRole('combobox'), 'scam');
    await userEvent.type(screen.getByRole('textbox', { name: 'Report details' }), 'Pump group link');
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));
    expect(await screen.findByText(/Report sent\. Thank you/)).toBeInTheDocument();
    expect(posts(calls).find((c) => c.url.endsWith('/report'))).toMatchObject({ url: '/api/rooms/general-chat/messages/m1/report', body: { reason: 'scam', details: 'Pump group link' } });
    expect(screen.queryByRole('button', { name: 'Report message from Bob' })).not.toBeInTheDocument();
  });

  it('asks for a description when the reason is "Something else", without calling the server', async () => {
    const calls = server('free', { messages: [msg(1)] });
    room();
    await userEvent.click(await screen.findByRole('button', { name: 'Report message from Bob' }));
    await userEvent.selectOptions(screen.getByRole('combobox'), 'other');
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));
    expect(await screen.findByText(/Please describe the problem/)).toBeInTheDocument();
    expect(posts(calls)).toHaveLength(0);
  });

  it('treats "already reported" as success', async () => {
    server('free', { messages: [msg(1)], route: (url, method) => (method === 'POST' ? fail(409, 'ALREADY_REPORTED', 'You have already reported this message.') : undefined) });
    room();
    await userEvent.click(await screen.findByRole('button', { name: 'Report message from Bob' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));
    expect(await screen.findByText(/Report sent\. Thank you/)).toBeInTheDocument();
  });

  it('shows the rate-limit message and keeps the form open', async () => {
    server('free', { messages: [msg(1)], route: (url, method) => (method === 'POST' ? fail(429, 'RATE_LIMITED', 'You have sent too many reports recently. Please try again later.') : undefined) });
    room();
    await userEvent.click(await screen.findByRole('button', { name: 'Report message from Bob' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send report' }));
    expect(await screen.findByText(/too many reports recently/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send report' })).toBeInTheDocument();
  });

  it('cancelling closes the form without sending anything', async () => {
    const calls = server('free', { messages: [msg(1)] });
    room();
    await userEvent.click(await screen.findByRole('button', { name: 'Report message from Bob' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Send report' })).not.toBeInTheDocument();
    expect(posts(calls)).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------ moderated messages
describe('moderated messages', () => {
  const hidden = (over: Partial<ChatMessage> = {}) => msg(1, { body: null, moderation: { state: 'hidden', reason: null }, ...over });
  const removed = (over: Partial<ChatMessage> = {}) => msg(1, { body: null, deleted: true, moderation: { state: 'removed', reason: null }, ...over });

  it('tells members plainly that a message was hidden or removed, with no content and no actions', async () => {
    server('free', { messages: [hidden(), removed({ id: 'm2', seq: 2 })] });
    room();
    expect(await screen.findByText('This message was hidden by a moderator.')).toBeInTheDocument();
    expect(screen.getByText('This message was removed by a moderator.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Report message/ })).not.toBeInTheDocument();
    expect(screen.queryByText('message 1')).not.toBeInTheDocument();
  });

  it('tells the author clearly, including the reason', async () => {
    const mine = { author: { id: 'u1', displayName: 'Ada', isStaff: false } };
    server('free', { messages: [hidden({ ...mine, moderation: { state: 'hidden', reason: 'Under review for spam' } }), removed({ ...mine, id: 'm2', seq: 2, moderation: { state: 'removed', reason: 'Harassment' } })] });
    room();
    expect(await screen.findByText('Your message was hidden by a moderator while it is reviewed.')).toBeInTheDocument();
    expect(screen.getByText('Reason: Under review for spam')).toBeInTheDocument();
    expect(screen.getByText('Your message was removed by a moderator.')).toBeInTheDocument();
    expect(screen.getByText('Reason: Harassment')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit message|Delete message/ })).not.toBeInTheDocument(); // hidden messages cannot be changed
  });

  it('keeps ordinary self-deletion wording', async () => {
    server('free', { messages: [msg(1, { body: null, deleted: true })] });
    room();
    expect(await screen.findByText('This message was deleted')).toBeInTheDocument();
  });

  it('updates live when a moderator hides, restores or removes a message', async () => {
    server('free', [msg(1, { body: 'live target' })].length ? { messages: [msg(1, { body: 'live target' })] } : {});
    room();
    await screen.findByText('live target');
    FakeEventSource.instances[0]!.emit('message.updated', msg(1, { body: null, moderation: { state: 'hidden', reason: null } }));
    expect(await screen.findByText('This message was hidden by a moderator.')).toBeInTheDocument();
    expect(screen.queryByText('live target')).not.toBeInTheDocument();
    FakeEventSource.instances[0]!.emit('message.updated', msg(1, { body: 'live target' }));
    expect(await screen.findByText('live target')).toBeInTheDocument();
    FakeEventSource.instances[0]!.emit('message.deleted', msg(1, { body: null, deleted: true, moderation: { state: 'removed', reason: null } }));
    expect(await screen.findByText('This message was removed by a moderator.')).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------------------------------------ staff actions in chat
describe('moderating from the chat (staff)', () => {
  const ok = (state: 'hidden' | 'removed') => (url: string, method: string): Reply | undefined =>
    method === 'POST' && url.includes('/moderation/messages/')
      ? { body: { message: state === 'hidden' ? msg(1, { body: null, moderation: { state: 'hidden', reason: 'Spam link' } }) : msg(1, { body: null, deleted: true, moderation: { state: 'removed', reason: 'Spam link' } }), resolvedReports: 1 } }
      : undefined;

  it('hides a message with a required reason', async () => {
    const calls = server('moderator', { messages: [msg(1, { body: 'spammy' })], route: ok('hidden') });
    room();
    await userEvent.click(await screen.findByRole('button', { name: 'Hide message from Bob' }));
    await userEvent.click(screen.getByRole('button', { name: 'Hide message' }));
    expect(await screen.findByText(/Give a short reason/)).toBeInTheDocument();
    expect(posts(calls)).toHaveLength(0);
    await userEvent.type(screen.getByLabelText(/Reason \(the author will see this\)/), 'Spam link');
    await userEvent.click(screen.getByRole('button', { name: 'Hide message' }));
    expect(await screen.findByText('This message was hidden by a moderator.')).toBeInTheDocument();
    expect(posts(calls)[0]).toMatchObject({ url: '/api/moderation/messages/m1/hide', body: { reason: 'Spam link' } });
    expect(screen.getByText('Reason: Spam link')).toBeInTheDocument(); // staff see the reason
  });

  it('removes a message, warning that it is permanent', async () => {
    const calls = server('admin', { messages: [msg(1, { body: 'awful' })], route: ok('removed') });
    room();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove message from Bob' }));
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Reason/), 'Spam link');
    await userEvent.click(screen.getByRole('button', { name: 'Remove message' }));
    expect(await screen.findByText('This message was removed by a moderator.')).toBeInTheDocument();
    expect(posts(calls)[0]).toMatchObject({ url: '/api/moderation/messages/m1/remove', body: { reason: 'Spam link' } });
  });

  it('restores a hidden message with one click', async () => {
    const calls = server('moderator', {
      messages: [msg(1, { body: null, moderation: { state: 'hidden', reason: 'Under review' } })],
      route: (url, method) => (method === 'POST' && url.endsWith('/unhide') ? { body: { message: msg(1, { body: 'back again' }) } } : undefined),
    });
    room();
    await userEvent.click(await screen.findByRole('button', { name: 'Restore message from Bob' }));
    expect(await screen.findByText('back again')).toBeInTheDocument();
    expect(posts(calls)[0]!.url).toBe('/api/moderation/messages/m1/unhide');
  });

  it('shows a refusal from the server inline without breaking the chat', async () => {
    server('moderator', { messages: [msg(1, { body: 'peer message' })], route: (url, method) => (method === 'POST' ? fail(403, 'FORBIDDEN', 'You cannot moderate messages from this account') : undefined) });
    room();
    await userEvent.click(await screen.findByRole('button', { name: 'Hide message from Bob' }));
    await userEvent.type(screen.getByLabelText(/Reason/), 'Because');
    await userEvent.click(screen.getByRole('button', { name: 'Hide message' }));
    expect(await screen.findByText('You cannot moderate messages from this account')).toBeInTheDocument();
    expect(screen.getByText('peer message')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Premium access required/ })).not.toBeInTheDocument();
  });

  it('follows the rank rule in the buttons: moderators cannot act on staff authors, administrators can act on moderators', async () => {
    const staffAuthor = { author: { id: 'u3', displayName: 'Mia', isStaff: true } };
    server('moderator', { messages: [msg(1, staffAuthor)] });
    const first = room();
    await screen.findByText('message 1');
    expect(screen.queryByRole('button', { name: 'Hide message from Mia' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Report message from Mia' })).toBeInTheDocument();
    first.unmount();
    server('admin', { messages: [msg(1, staffAuthor)] });
    room();
    expect(await screen.findByRole('button', { name: 'Hide message from Mia' })).toBeInTheDocument();
  });

  it('never shows moderation controls to ordinary members', async () => {
    server('free', { messages: [msg(1)] });
    room();
    await screen.findByText('message 1');
    expect(screen.queryByRole('button', { name: /Hide message|Remove message/ })).not.toBeInTheDocument();
  });
});

// ------------------------------------------------------------------------------------------------ restricted accounts
describe('restricted accounts', () => {
  it('replaces the composer with a clear notice when the member is muted, keeping reading and reporting', async () => {
    const until = new Date(Date.now() + 2 * 86_400_000).toISOString();
    server('free', { messages: [msg(1), msg(2, { author: { id: 'u1', displayName: 'Ada', isStaff: false }, body: 'mine' })], me: { body: account('free', { muted: { type: 'muted', reason: 'Posting spam links', expiresAt: until } }) } });
    room();
    expect(await screen.findByText(/You cannot post messages until/)).toBeInTheDocument();
    expect(screen.getByText(/Posting spam links/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
    expect(screen.getByText('message 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit message from Ada' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete message from Ada' })).toBeInTheDocument(); // may still remove their own words
    expect(screen.getByRole('button', { name: 'Report message from Bob' })).toBeInTheDocument();
  });

  it('says "until an administrator lifts it" for an open-ended mute, and ignores a mute that has run out', async () => {
    server('free', { me: { body: account('free', { muted: { type: 'muted', reason: 'Spam', expiresAt: null } }) } });
    const first = room();
    expect(await screen.findByText(/until an administrator lifts it/)).toBeInTheDocument();
    first.unmount();
    server('free', { me: { body: account('free', { muted: { type: 'muted', reason: 'Spam', expiresAt: new Date(Date.now() - 1000).toISOString() } }) } });
    room();
    expect(await screen.findByRole('textbox', { name: 'Message' })).toBeInTheDocument();
  });

  it('switches to the notice when a send is refused because the member was muted meanwhile', async () => {
    server('free', { route: (url, method) => (method === 'POST' ? fail(403, 'ACCOUNT_RESTRICTED', 'You cannot post messages.', { type: 'muted', reason: 'Too many links', expiresAt: null }) : undefined) });
    room();
    await userEvent.type(await screen.findByRole('textbox', { name: 'Message' }), 'hi{Enter}');
    expect(await screen.findByText(/Too many links/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Premium access required/ })).not.toBeInTheDocument();
  });

  it('shows a suspended account the reason, how long it lasts, and a way to log out', async () => {
    const calls = server(null, { me: fail(403, 'ACCOUNT_SUSPENDED', 'Your account is suspended.', { type: 'suspended', reason: 'Harassment of members', expiresAt: new Date(Date.now() + 86_400_000).toISOString() }),
      route: (url, method) => (url.endsWith('/auth/logout') && method === 'POST' ? { status: 204, body: undefined } : undefined) });
    room();
    expect(await screen.findByRole('heading', { name: 'Your account is suspended' })).toBeInTheDocument();
    expect(screen.getByText(/Harassment of members/)).toBeInTheDocument();
    expect(screen.getByText(/suspended until/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Your account is suspended' })).not.toBeInTheDocument());
    expect(calls.some((c) => c.url === '/api/auth/logout')).toBe(true);
  });

  it('shows the suspension screen if the account is suspended while the app is open', async () => {
    let suspended = false;
    server('free', { messages: [msg(1)], route: (url, method) => (suspended && method === 'POST' ? fail(403, 'ACCOUNT_SUSPENDED', 'Your account is suspended.', { type: 'suspended', reason: 'Fraud', expiresAt: null }) : undefined) });
    room();
    await userEvent.type(await screen.findByRole('textbox', { name: 'Message' }), 'hello');
    suspended = true;
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Your account is suspended' })).toBeInTheDocument();
    expect(screen.getByText(/until an administrator lifts it/)).toBeInTheDocument();
    expect(screen.getByText(/Fraud/)).toBeInTheDocument();
  });

  it('shows a failed sign-in because of a suspension on the form itself, with the reason', async () => {
    server(null, { route: (url, method) => (url.endsWith('/auth/login') && method === 'POST' ? fail(403, 'ACCOUNT_SUSPENDED', 'Your account is suspended until 2026-12-01 10:00 UTC. Reason: Fraud') : undefined) });
    renderAt('/login');
    await userEvent.type(await screen.findByLabelText('Email'), 'a@b.co');
    await userEvent.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await userEvent.click(screen.getByRole('button', { name: /log in/i }));
    expect(await screen.findByText(/Reason: Fraud/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Your account is suspended' })).not.toBeInTheDocument(); // not the full-page screen
  });
});

// ------------------------------------------------------------------------------------------------ the queue page
const NO: UserRestrictions = { muted: null, suspended: null };
const report = (n: number, over: Partial<ReportItem> = {}): ReportItem => ({
  id: `p${n}`, status: 'open', reason: 'spam', details: '', createdAt: '2026-01-02T09:00:00Z', resolution: null, resolutionNote: null, resolvedAt: null, resolvedBy: null,
  reporter: { id: 'u9', displayName: 'Rita' }, reportedUser: { id: 'u2', displayName: 'Bob', role: 'free', restrictions: NO },
  room: { id: 'r1', slug: 'general-chat', name: 'General Chat' },
  message: { id: `m${n}`, state: 'visible', snapshot: `offending text ${n}`, current: `offending text ${n}`, editedSinceReport: false, moderationReason: null, reportCount: 1 }, ...over,
});
const listOf = (reports: ReportItem[], counts = { open: reports.filter((r) => r.status === 'open').length, resolved: 0, dismissed: 0 }) => ({ body: { reports, counts, limit: 20, offset: 0 } });

describe('the moderation queue page', () => {
  it('is for staff only', async () => {
    server('free');
    renderAt('/staff/moderation');
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
  });

  it('sends visitors to log in', async () => {
    server(null);
    renderAt('/staff/moderation');
    expect(await screen.findByRole('heading', { name: /log in|welcome back|sign in/i })).toBeInTheDocument();
  });

  it('shows each open report with what was reported, who reported it and where', async () => {
    server('moderator', { route: (url) => (url.includes('/moderation/reports') ? listOf([
      report(1, { reason: 'scam', details: 'Looks like a pump group', message: { ...report(1).message, reportCount: 3 } }),
      report(2, { message: { ...report(2).message, snapshot: 'what was said', current: 'what it says now', editedSinceReport: true } }),
    ], { open: 2, resolved: 4, dismissed: 1 }) : undefined) });
    renderAt('/staff/moderation');
    const cards = await screen.findAllByRole('article', { name: 'Report about Bob' });
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByText('Scam or fraud')).toBeInTheDocument();
    expect(within(cards[0]!).getByText('Rita')).toBeInTheDocument();
    expect(within(cards[0]!).getByRole('link', { name: 'General Chat' })).toHaveAttribute('href', '/rooms/general-chat');
    expect(within(cards[0]!).getByText('offending text 1')).toBeInTheDocument();
    expect(within(cards[0]!).getByText(/Looks like a pump group/)).toBeInTheDocument();
    expect(within(cards[0]!).getByText('3 reports on this message')).toBeInTheDocument();
    expect(within(cards[1]!).getByText('what was said')).toBeInTheDocument();
    expect(within(cards[1]!).getByText('what it says now')).toBeInTheDocument();
    expect(within(cards[1]!).getByText('Edited since the report')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Open (2)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Resolved (4)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Dismissed (1)' })).toBeInTheDocument();
  });

  it('shows loading, an empty state, and a retryable error', async () => {
    let first = true;
    server('moderator', { route: (url) => { if (url.includes('/moderation/reports')) { if (first) { first = false; return fail(500, 'INTERNAL', 'Boom'); } return listOf([]); } } });
    renderAt('/staff/moderation');
    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Nothing to review')).toBeInTheDocument();
  });

  it('switches tabs and shows who closed a report and why', async () => {
    const calls = server('moderator', { route: (url) => {
      if (!url.includes('/moderation/reports')) return undefined;
      return url.includes('status=dismissed')
        ? listOf([report(5, { status: 'dismissed', resolutionNote: 'Not a violation', resolvedBy: { displayName: 'Mo Derator' }, resolvedAt: '2026-01-03T10:00:00Z' })], { open: 0, resolved: 0, dismissed: 1 })
        : listOf([report(1)], { open: 1, resolved: 0, dismissed: 1 });
    } });
    renderAt('/staff/moderation');
    await screen.findByText('offending text 1');
    await userEvent.click(screen.getByRole('tab', { name: /Dismissed/ }));
    expect(await screen.findByText(/Dismissed by Mo Derator/)).toBeInTheDocument();
    expect(screen.getByText(/Not a violation/)).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('status=dismissed'))).toBe(true);
    expect(screen.queryByRole('button', { name: 'Hide' })).not.toBeInTheDocument(); // closed reports have no actions
  });

  it('hides a message with a reason and reports how many reports that settled', async () => {
    const calls = server('moderator', { route: (url, method) => {
      if (method === 'POST' && url.includes('/moderation/messages/m1/hide')) return { body: { message: {}, resolvedReports: 2 } };
      if (url.includes('/moderation/reports')) return listOf([report(1)]);
    } });
    renderAt('/staff/moderation');
    await userEvent.click(await screen.findByRole('button', { name: 'Hide' }));
    await userEvent.click(screen.getByRole('button', { name: 'Hide message' }));
    expect(await screen.findByText(/Give a short reason/)).toBeInTheDocument();
    expect(posts(calls)).toHaveLength(0);
    await userEvent.type(screen.getByLabelText(/Reason \(the author will see this\)/), 'Spam link');
    await userEvent.click(screen.getByRole('button', { name: 'Hide message' }));
    expect(await screen.findByText('Message hidden. 2 report(s) resolved.')).toBeInTheDocument();
    expect(posts(calls)[0]).toMatchObject({ url: '/api/moderation/messages/m1/hide', body: { reason: 'Spam link' } });
  });

  it('removes a message, resolves with a note, and dismisses a report', async () => {
    const calls = server('admin', { route: (url, method) => {
      if (method === 'POST' && (url.includes('/remove') || url.includes('/resolve') || url.includes('/dismiss'))) return { body: { resolvedReports: 1, report: {} } };
      if (url.includes('/moderation/reports')) return listOf([report(1)]);
    } });
    renderAt('/staff/moderation');
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(screen.getByText(/permanently deletes the message text/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Reason/), 'Abuse');
    await userEvent.click(screen.getByRole('button', { name: 'Remove message' }));
    expect(await screen.findByText('Message removed. 1 report(s) resolved.')).toBeInTheDocument();

    await userEvent.click(await screen.findByRole('button', { name: 'Resolve' }));
    await userEvent.type(screen.getByLabelText('Note (optional)'), 'Warned the member');
    await userEvent.click(screen.getByRole('button', { name: 'Resolve report' }));
    expect(await screen.findByText('Report resolved.')).toBeInTheDocument();

    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss report' }));
    expect(await screen.findByText('Report dismissed.')).toBeInTheDocument();
    const p = posts(calls);
    expect(p[0]).toMatchObject({ url: '/api/moderation/messages/m1/remove', body: { reason: 'Abuse' } });
    expect(p[1]).toMatchObject({ url: '/api/moderation/reports/p1/resolve', body: { note: 'Warned the member' } });
    expect(p[2]).toMatchObject({ url: '/api/moderation/reports/p1/dismiss', body: {} });
  });

  it('restores a hidden message from its report', async () => {
    const calls = server('moderator', { route: (url, method) => {
      if (method === 'POST') return { body: {} };
      if (url.includes('/moderation/reports')) return listOf([report(1, { message: { ...report(1).message, state: 'hidden' } })]);
    } });
    renderAt('/staff/moderation');
    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('Message restored.')).toBeInTheDocument();
    expect(posts(calls)[0]!.url).toBe('/api/moderation/messages/m1/unhide');
    expect(screen.queryByRole('button', { name: 'Hide' })).not.toBeInTheDocument();
  });

  it('shows the server\'s refusal on the card and leaves the report open', async () => {
    server('moderator', { route: (url, method) => {
      if (method === 'POST') return fail(403, 'CONFLICT_OF_INTEREST', 'You cannot close a report that you filed or that is about you. Ask another moderator.');
      if (url.includes('/moderation/reports')) return listOf([report(1)]);
    } });
    renderAt('/staff/moderation');
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss report' }));
    expect(await screen.findByText(/Ask another moderator/)).toBeInTheDocument();
    expect(screen.getByText('offending text 1')).toBeInTheDocument();
  });

  it('loads more reports when there are more than one page', async () => {
    const calls = server('moderator', { route: (url) => (url.includes('/moderation/reports') ? listOf([report(1)], { open: 45, resolved: 0, dismissed: 0 }) : undefined) });
    renderAt('/staff/moderation');
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('limit=40'))).toBe(true));
  });
});

// ------------------------------------------------------------------------------------------------ restricting users (administrators)
describe('restricting accounts', () => {
  it('lets administrators restrict the reported author from the report, with a required reason', async () => {
    const calls = server('admin', { route: (url, method) => {
      if (method === 'POST' && url.includes('/admin/users/u2/restrictions')) return { status: 201, body: { restriction: {} } };
      if (url.includes('/moderation/reports')) return listOf([report(1)]);
    } });
    renderAt('/staff/moderation');
    await userEvent.click(await screen.findByRole('button', { name: 'Restrict Bob' }));
    await userEvent.click(screen.getByRole('button', { name: 'Mute member' }));
    expect(await screen.findByText(/Give a reason/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Restriction'), 'suspended');
    await userEvent.selectOptions(screen.getByLabelText('Duration'), '72');
    await userEvent.type(screen.getByLabelText(/Reason \(the member will see this\)/), 'Repeated harassment');
    await userEvent.click(screen.getByRole('button', { name: 'Suspend account' }));
    expect(await screen.findByText('Bob is now suspended.')).toBeInTheDocument();
    expect(posts(calls)[0]).toMatchObject({ url: '/api/admin/users/u2/restrictions', body: { type: 'suspended', reason: 'Repeated harassment', durationHours: 72 } });
  });

  it('shows what is in force and lifts it', async () => {
    const restrictions: UserRestrictions = { muted: { id: 'x1', type: 'muted', reason: 'Spam links', createdAt: '2026-01-01T00:00:00Z', expiresAt: null }, suspended: null };
    const calls = server('admin', { route: (url, method) => {
      if (method === 'POST' && url.endsWith('/admin/restrictions/x1/lift')) return { body: { restriction: {} } };
      if (url.includes('/moderation/reports')) return listOf([report(1, { reportedUser: { id: 'u2', displayName: 'Bob', role: 'free', restrictions } })]);
    } });
    renderAt('/staff/moderation');
    expect(await screen.findByText('Muted')).toBeInTheDocument();
    expect(screen.getByText(/Spam links/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Lift mute for Bob' }));
    expect(await screen.findByText('Muted lifted for Bob.')).toBeInTheDocument();
    expect(posts(calls)[0]!.url).toBe('/api/admin/restrictions/x1/lift');
  });

  it('shows the API\'s refusal if the restriction is not allowed', async () => {
    server('admin', { route: (url, method) => {
      if (method === 'POST') return fail(409, 'CONFLICT', 'This account already has an active mute. Lift it first to change it.');
      if (url.includes('/moderation/reports')) return listOf([report(1)]);
    } });
    renderAt('/staff/moderation');
    await userEvent.click(await screen.findByRole('button', { name: 'Restrict Bob' }));
    await userEvent.type(screen.getByLabelText(/Reason \(the member will see this\)/), 'Spam again');
    await userEvent.click(screen.getByRole('button', { name: 'Mute member' }));
    expect(await screen.findByText(/already has an active mute/)).toBeInTheDocument();
  });

  it('does not show restriction controls to moderators, or for administrator accounts', async () => {
    server('moderator', { route: (url) => (url.includes('/moderation/reports') ? listOf([report(1)]) : undefined) });
    const first = renderAt('/staff/moderation');
    await screen.findByText('offending text 1');
    expect(screen.queryByRole('button', { name: 'Restrict Bob' })).not.toBeInTheDocument();
    first.unmount();
    server('admin', { route: (url) => (url.includes('/moderation/reports') ? listOf([report(1, { reportedUser: { id: 'u3', displayName: 'Ana', role: 'admin', restrictions: NO } })]) : undefined) });
    renderAt('/staff/moderation');
    await screen.findByText('offending text 1');
    expect(screen.queryByRole('button', { name: 'Restrict Ana' })).not.toBeInTheDocument();
  });

  it('adds restriction controls to the administrator user list, except for administrators', async () => {
    const calls = server('admin', { route: (url, method) => {
      if (url.includes('/admin/overview')) return { body: { usersByRole: { free: 2, moderator: 0, admin: 1 } } };
      if (url.includes('/admin/users?')) return { body: { users: [
        { id: 'u2', email: 'bob@x.co', displayName: 'Bob', role: 'free', premium: false, createdAt: '2026-01-01T00:00:00Z', restrictions: { muted: null, suspended: { id: 's1', type: 'suspended', reason: 'Fraud', createdAt: '2026-01-01T00:00:00Z', expiresAt: null } } },
        { id: 'u3', email: 'ana@x.co', displayName: 'Ana', role: 'admin', premium: false, createdAt: '2026-01-01T00:00:00Z' },
      ] } };
      if (method === 'POST' && url.endsWith('/admin/restrictions/s1/lift')) return { body: { restriction: {} } };
    } });
    renderAt('/admin');
    expect(await screen.findByText('Suspended')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restrict Bob' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restrict Ana' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Lift suspension for Bob' }));
    await waitFor(() => expect(posts(calls).some((c) => c.url === '/api/admin/restrictions/s1/lift')).toBe(true));
  });
});
