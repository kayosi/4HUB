import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { AuthProvider } from '../auth/AuthContext';
import { applyLatest, charCount, insertMessage, replaceMessage, uuid, type ChatMessage } from '../lib/chat';

// ------------------------------------------------------------------------------------------------ fixtures
const msg = (seq: number, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m${seq}`, seq, roomId: 'r1', author: { id: 'u2', displayName: 'Bob', isStaff: false }, body: `message ${seq}`,
  createdAt: '2026-01-01T10:00:00Z', editedAt: null, deleted: false, ...over,
});
const mine = (seq: number, over: Partial<ChatMessage> = {}) => msg(seq, { author: { id: 'u1', displayName: 'Ada', isStaff: false }, ...over });
const ROOM = { id: 'r1', slug: 'general-chat', name: 'General Chat', description: 'Talk', category: 'general_discussion', access: 'public', locked: false, guidelines: 'Be kind', createdAt: '2026-01-01', updatedAt: '2026-01-01' };

const me = (role: string) => ({ user: {
  id: 'u1', email: 'a@b.co', displayName: 'Ada', role, createdAt: '2026-01-01', country: null, tradingExperience: null, preferredAssets: [],
  notificationPrefs: { newSignals: true, signalUpdates: true, announcements: false }, access: { tier: 'free', premium: false },
} });
type Reply = { status?: number; body?: unknown };
const fail = (status: number, code: string, message = 'x', details?: unknown): Reply => ({ status, body: { error: { code, message, details } } });

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string, public init?: { withCredentials?: boolean }) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, fn: (e: { data: string }) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  close() { this.readyState = 2; }
  // --- test controls
  open() { this.readyState = 1; act(() => this.onopen?.()); }
  emit(type: string, data: unknown) { act(() => this.listeners.get(type)?.forEach((fn) => fn({ data: JSON.stringify(data) }))); }
  drop() { this.readyState = 0; act(() => this.onerror?.()); } // transient: the browser retries by itself
  giveUp() { this.readyState = 2; act(() => this.onerror?.()); } // refused / not a stream: the browser stops
}
const es = () => FakeEventSource.instances[FakeEventSource.instances.length - 1]!;

interface Server { messages: ChatMessage[]; calls: { method: string; url: string; body?: Record<string, unknown> }[]; override?: (url: string, method: string) => Reply | undefined; archived?: boolean }
function startServer(role: string | null, initial: ChatMessage[] = [], extra: Partial<Server> = {}) {
  const server: Server = { messages: [...initial], calls: [], ...extra };
  const spy = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    server.calls.push({ method, url, ...(body ? { body } : {}) });
    const r = ((): Reply => {
      if (url.endsWith('/api/me')) return role ? { body: me(role) } : fail(401, 'UNAUTHENTICATED');
      const o = server.override?.(url, method);
      if (o) return o;
      if (url === '/api/rooms/general-chat') return { body: { room: { ...ROOM, archived: !!server.archived } } };
      const m = url.match(/^\/api\/rooms\/general-chat\/messages(?:\/([^?]+))?(?:\?(.*))?$/);
      if (!m) return fail(404, 'NOT_FOUND');
      const [, id, qs] = m;
      if (method === 'GET') {
        const q = new URLSearchParams(qs);
        const before = Number(q.get('before') ?? Infinity);
        const limit = Number(q.get('limit') ?? 30);
        const older = server.messages.filter((x) => x.seq < before);
        const page = older.slice(-limit);
        return { body: { messages: page, hasMore: older.length > limit, nextBefore: older.length > limit ? page[0]!.seq : null } };
      }
      if (method === 'POST') {
        const created = mine(Math.max(0, ...server.messages.map((x) => x.seq)) + 1, { body: String(body!.body) });
        server.messages.push(created);
        return { status: 201, body: { message: created } };
      }
      const target = server.messages.find((x) => x.id === id)!;
      if (method === 'PATCH') { Object.assign(target, { body: String(body!.body), editedAt: '2026-01-01T11:00:00Z' }); return { body: { message: target } }; }
      Object.assign(target, { body: null, deleted: true });
      return { body: { message: target } };
    })();
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body } as Response;
  });
  vi.stubGlobal('fetch', spy);
  return server;
}
const renderRoom = () => render(<MemoryRouter initialEntries={['/rooms/general-chat']}><AuthProvider><App /></AuthProvider></MemoryRouter>);
const gets = (s: Server) => s.calls.filter((c) => c.method === 'GET' && c.url.includes('/messages'));

beforeEach(() => { FakeEventSource.instances = []; vi.stubGlobal('EventSource', FakeEventSource); });
afterEach(() => vi.unstubAllGlobals());

// ------------------------------------------------------------------------------------------------ pure helpers
describe('message list helpers', () => {
  it('insertMessage appends new messages, keeps order, and never duplicates an id', () => {
    const list = [msg(1), msg(2)];
    expect(insertMessage(list, msg(3)).map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(insertMessage(list, msg(2, { body: 'changed' }))).toHaveLength(2);
    expect(insertMessage(list, msg(2, { body: 'changed' }))[1]!.body).toBe('changed');
    expect(insertMessage([msg(5)], msg(3)).map((m) => m.seq)).toEqual([3, 5]);
  });

  it('replaceMessage ignores messages that are not loaded (no gaps in the list)', () => {
    const list = [msg(10), msg(11)];
    expect(replaceMessage(list, msg(3, { body: 'old edit' }))).toEqual(list);
    expect(replaceMessage(list, msg(11, { body: 'x' }))[1]!.body).toBe('x');
  });

  it('applyLatest merges missed messages and updates, and keeps the cursor state', () => {
    const cur = { messages: [msg(8), msg(9)], hasMore: true };
    const merged = applyLatest(cur, { messages: [msg(9, { body: 'edited' }), msg(10)], hasMore: true, nextBefore: 9 });
    expect(merged.messages.map((m) => [m.seq, m.body])).toEqual([[8, 'message 8'], [9, 'edited'], [10, 'message 10']]);
    expect(merged.hasMore).toBe(true);
  });

  it('applyLatest restarts from the newest page instead of leaving a hole when too much was missed', () => {
    const cur = { messages: [msg(1), msg(2)], hasMore: false };
    const page = { messages: [msg(70), msg(71)], hasMore: true, nextBefore: 70 };
    expect(applyLatest(cur, page)).toEqual({ messages: page.messages, hasMore: true });
  });

  it('applyLatest adopts the page when the screen was empty', () => {
    expect(applyLatest({ messages: [], hasMore: false }, { messages: [msg(1)], hasMore: false, nextBefore: null }).messages).toHaveLength(1);
  });

  it('counts characters like the server (code points) and generates valid ids', () => {
    expect(charCount('😀😀')).toBe(2);
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

// ------------------------------------------------------------------------------------------------ access
describe('chat access states', () => {
  it('invites visitors to log in and loads no messages and no stream', async () => {
    const s = startServer(null);
    renderRoom();
    expect(await screen.findByText(/Log in to read and join the conversation/)).toBeInTheDocument();
    expect(gets(s)).toHaveLength(0);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('shows a session-ended state if the session is lost while the room is open', async () => {
    startServer('free', [], { override: (url) => (url.includes('/messages') ? fail(401, 'UNAUTHENTICATED') : undefined) });
    renderRoom();
    expect(await screen.findByRole('heading', { name: 'Your session has ended' })).toBeInTheDocument();
  });

  it('shows the premium-required state when the plan no longer covers the room', async () => {
    startServer('free', [], { override: (url) => (url.includes('/messages') ? fail(403, 'PREMIUM_REQUIRED') : undefined) });
    renderRoom();
    expect(await screen.findByRole('heading', { name: 'Premium access required' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View premium plans' })).toHaveAttribute('href', '/pricing');
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('shows loading, then a retryable error state', async () => {
    let first = true;
    startServer('free', [mine(1)], { override: (url) => { if (url.includes('/messages') && first) { first = false; return fail(500, 'INTERNAL', 'Boom'); } } });
    renderRoom();
    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('message 1')).toBeInTheDocument();
  });

  it('shows an empty state for a room with no messages', async () => {
    startServer('free');
    renderRoom();
    expect(await screen.findByText('No messages yet. Start the conversation.')).toBeInTheDocument();
  });

  it('shows a read-only notice instead of a composer in an archived room', async () => {
    startServer('moderator', [msg(1)], { archived: true });
    renderRoom();
    expect(await screen.findByText('This room is archived and read-only.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
  });

  it('switches to read-only if a send is refused because the room was archived meanwhile', async () => {
    startServer('free', [], { override: (url, method) => (method === 'POST' ? fail(409, 'ROOM_ARCHIVED', 'This room is archived and read-only.') : undefined) });
    renderRoom();
    await userEvent.type(await screen.findByRole('textbox', { name: 'Message' }), 'hi{Enter}');
    expect(await screen.findByText('This room is archived and read-only.', { selector: 'p.chat-readonly' })).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------------------------------------ history and rendering
describe('message history', () => {
  it('shows author, time, staff badge, edited marker and deleted tombstones in order', async () => {
    startServer('free', [
      msg(1, { author: { id: 'u3', displayName: 'Mod Mia', isStaff: true } }),
      msg(2, { body: 'second', editedAt: '2026-01-01T10:05:00Z' }),
      msg(3, { body: null, deleted: true }),
    ]);
    const { container } = renderRoom();
    const log = await screen.findByRole('log', { name: 'Messages' });
    expect(within(log).getByText('Mod Mia')).toBeInTheDocument();
    expect(within(log).getByText('Staff')).toBeInTheDocument();
    expect(within(log).getByText('(edited)')).toBeInTheDocument();
    expect(within(log).getByText('This message was deleted')).toBeInTheDocument();
    const times = container.querySelectorAll('time');
    expect(times).toHaveLength(3);
    expect(times[0]!.getAttribute('datetime')).toBe('2026-01-01T10:00:00Z');
    const order = [...log.querySelectorAll('article')].map((a) => a.getAttribute('aria-label'));
    expect(order).toEqual(['Message from Mod Mia', 'Message from Bob', 'Message from Bob']);
  });

  it('renders markup as plain text and never creates elements from message content', async () => {
    const evil = '<img src=x onerror=alert(1)> <b>bold</b> <script>alert(2)</script> javascript:alert(3)';
    startServer('free', [msg(1, { body: evil, author: { id: 'u2', displayName: '<i>Bob</i>', isStaff: false } })]);
    renderRoom();
    const log = await screen.findByRole('log', { name: 'Messages' });
    expect(within(log).getByText(evil)).toBeInTheDocument();
    expect(within(log).getByText('<i>Bob</i>')).toBeInTheDocument();
    for (const tag of ['img', 'b', 'i', 'script', 'a']) expect(log.querySelector(tag)).toBeNull();
  });

  it('loads older messages on demand and keeps them in order', async () => {
    const many = Array.from({ length: 45 }, (_, i) => msg(i + 1));
    const s = startServer('free', many);
    renderRoom();
    expect(await screen.findByText('message 45')).toBeInTheDocument();
    expect(screen.queryByText('message 15')).not.toBeInTheDocument(); // only the newest page
    await userEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
    expect(await screen.findByText('message 1')).toBeInTheDocument();
    expect(gets(s).some((c) => c.url.includes('before=16'))).toBe(true);
    expect(screen.queryByRole('button', { name: 'Load older messages' })).not.toBeInTheDocument();
    const order = [...screen.getByRole('log').querySelectorAll('.chat-body')].map((n) => n.textContent);
    expect(order).toEqual(many.map((m) => m.body));
  });

  it('shows an error if older messages cannot be loaded, and lets the reader retry', async () => {
    const many = Array.from({ length: 40 }, (_, i) => msg(i + 1));
    let fails = true;
    startServer('free', many, { override: (url) => (url.includes('before=') && fails ? fail(500, 'INTERNAL', 'Could not load older') : undefined) });
    renderRoom();
    await userEvent.click(await screen.findByRole('button', { name: 'Load older messages' }));
    expect(await screen.findByText('Could not load older')).toBeInTheDocument();
    fails = false;
    await userEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
    expect(await screen.findByText('message 1')).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------------------------------------ sending
describe('sending messages', () => {
  it('sends on Enter with a client id, shows the message and clears the box; Shift+Enter adds a line', async () => {
    const s = startServer('free');
    renderRoom();
    const box = await screen.findByRole('textbox', { name: 'Message' });
    await userEvent.type(box, 'line one{Shift>}{Enter}{/Shift}line two');
    expect(s.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(box).toHaveValue('line one\nline two');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText(/line one/, { selector: '.chat-body' })).toBeInTheDocument();
    const post = s.calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/rooms/general-chat/messages');
    expect(post.body).toEqual({ body: 'line one\nline two', clientId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(post.body).not.toHaveProperty('author');
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('does not send blank messages, and blocks messages over the limit', async () => {
    const s = startServer('free');
    renderRoom();
    const box = await screen.findByRole('textbox', { name: 'Message' });
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    await userEvent.type(box, '   {Enter}');
    expect(s.calls.some((c) => c.method === 'POST')).toBe(false);
    fireEvent.change(box, { target: { value: 'a'.repeat(2001) } });
    expect(await screen.findByText('2001/2000')).toBeInTheDocument();
    expect(send).toBeDisabled();
    fireEvent.change(box, { target: { value: 'a'.repeat(2000) } });
    expect(send).toBeEnabled();
  });

  it('keeps the text after a failure and retries with the same client id so it cannot post twice', async () => {
    const s = startServer('free');
    // simulate a dropped connection on the first attempt
    const real = globalThis.fetch;
    let dropped = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && !dropped) { dropped = true; throw new TypeError('network down'); }
      return real(url, init);
    }));
    renderRoom();
    const box = await screen.findByRole('textbox', { name: 'Message' });
    await userEvent.type(box, 'important{Enter}');
    expect(await screen.findByText(/Unable to reach the server/)).toBeInTheDocument();
    expect(box).toHaveValue('important');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('important', { selector: '.chat-body' })).toBeInTheDocument();
    expect(s.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('reuses the client id when the same text is retried, and uses a new one for new text', async () => {
    const ids: string[] = [];
    let fails = 2;
    startServer('free', [], { override: (url, method) => (method === 'POST' && fails-- > 0 ? fail(500, 'INTERNAL', 'Server hiccup') : undefined) });
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') ids.push(JSON.parse(init.body as string).clientId);
      return inner(url, init);
    }));
    renderRoom();
    const box = await screen.findByRole('textbox', { name: 'Message' });
    await userEvent.type(box, 'first{Enter}');
    await screen.findByText(/Server hiccup/);
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText(/Server hiccup/);
    expect(ids[1]).toBe(ids[0]);
    await userEvent.type(box, ' changed');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ids).toHaveLength(3));
    expect(ids[2]).not.toBe(ids[0]);
  });

  it('shows the server\'s rate-limit message and keeps the draft', async () => {
    startServer('free', [], { override: (url, method) => (method === 'POST' ? fail(429, 'RATE_LIMITED', 'You are sending messages too quickly. Try again in 12s.') : undefined) });
    renderRoom();
    const box = await screen.findByRole('textbox', { name: 'Message' });
    await userEvent.type(box, 'spam{Enter}');
    expect(await screen.findByText(/too quickly\. Try again in 12s/)).toBeInTheDocument();
    expect(box).toHaveValue('spam');
  });

  it('turns the chat into the premium-required state if access is lost mid-session', async () => {
    startServer('free', [], { override: (url, method) => (method === 'POST' ? fail(403, 'PREMIUM_REQUIRED') : undefined) });
    renderRoom();
    await userEvent.type(await screen.findByRole('textbox', { name: 'Message' }), 'hello{Enter}');
    expect(await screen.findByRole('heading', { name: 'Premium access required' })).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------------------------------------ editing and deleting
describe('editing and deleting', () => {
  it('lets members edit only their own messages', async () => {
    const s = startServer('free', [msg(1), mine(2, { body: 'my words' })]);
    renderRoom();
    await screen.findByText('my words');
    expect(screen.queryByRole('button', { name: 'Edit message from Bob' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete message from Bob' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Edit message from Ada' }));
    const box = screen.getByRole('textbox', { name: 'Edit message' });
    expect(box).toHaveValue('my words');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled(); // unchanged
    await userEvent.clear(box);
    await userEvent.type(box, 'better words');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('better words')).toBeInTheDocument();
    expect(screen.getByText('(edited)')).toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'PATCH')).toMatchObject({ url: '/api/rooms/general-chat/messages/m2', body: { body: 'better words' } });
  });

  it('cancelling an edit changes nothing', async () => {
    const s = startServer('free', [mine(1, { body: 'keep me' })]);
    renderRoom();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit message from Ada' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Edit message' }), ' extra');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('keep me')).toBeInTheDocument();
    expect(s.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('shows an error and keeps the editor open if saving an edit fails', async () => {
    startServer('free', [mine(1, { body: 'orig' })], { override: (url, method) => (method === 'PATCH' ? fail(500, 'INTERNAL', 'Could not save') : undefined) });
    renderRoom();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit message from Ada' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Edit message' }), ' more');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Could not save')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Edit message' })).toHaveValue('orig more');
  });

  it('asks for confirmation before deleting, then shows a tombstone', async () => {
    const s = startServer('free', [mine(1, { body: 'oops' })]);
    renderRoom();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete message from Ada' }));
    expect(s.calls.some((c) => c.method === 'DELETE')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(s.calls.some((c) => c.method === 'DELETE')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Delete message from Ada' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(await screen.findByText('This message was deleted')).toBeInTheDocument();
    expect(screen.queryByText('oops')).not.toBeInTheDocument();
    expect(s.calls.find((c) => c.method === 'DELETE')!.url).toBe('/api/rooms/general-chat/messages/m1');
  });

  it('lets staff delete anyone\'s message but not edit it', async () => {
    startServer('moderator', [msg(1, { body: 'someone else' })]);
    renderRoom();
    await screen.findByText('someone else');
    expect(screen.getByRole('button', { name: 'Delete message from Bob' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit message from Bob' })).not.toBeInTheDocument();
  });
});

// ------------------------------------------------------------------------------------------------ real time
describe('real-time updates', () => {
  it('opens one authenticated stream for the room and closes it on leaving', async () => {
    startServer('free', [msg(1)]);
    const { unmount } = renderRoom();
    await screen.findByText('message 1');
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(es().url).toBe('/api/rooms/general-chat/stream');
    expect(es().init?.withCredentials).toBe(true);
    unmount();
    expect(es().readyState).toBe(2);
  });

  it('shows new, edited and deleted messages as they arrive, without duplicates', async () => {
    startServer('free', [msg(1)]);
    renderRoom();
    await screen.findByText('message 1');
    es().open();
    expect(await screen.findByText('Live')).toBeInTheDocument();

    es().emit('message.created', msg(2, { body: 'fresh news' }));
    expect(await screen.findByText('fresh news')).toBeInTheDocument();
    es().emit('message.created', msg(2, { body: 'fresh news' })); // delivered twice
    expect(screen.getAllByText('fresh news')).toHaveLength(1);

    es().emit('message.updated', msg(2, { body: 'fresher news', editedAt: '2026-01-01T10:30:00Z' }));
    expect(await screen.findByText('fresher news')).toBeInTheDocument();
    expect(screen.queryByText('fresh news')).not.toBeInTheDocument();

    es().emit('message.deleted', msg(2, { body: null, deleted: true }));
    expect(await screen.findByText('This message was deleted')).toBeInTheDocument();
    expect(screen.queryByText('fresher news')).not.toBeInTheDocument();
  });

  it('does not add a message twice when it arrives both from the send response and the stream', async () => {
    startServer('free');
    renderRoom();
    await screen.findByText('No messages yet. Start the conversation.');
    es().open();
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'echo{Enter}');
    await screen.findByText('echo', { selector: '.chat-body' });
    es().emit('message.created', mine(1, { body: 'echo' }));
    expect(screen.getAllByText('echo', { selector: '.chat-body' })).toHaveLength(1);
  });

  it('ignores edits and deletes for messages that are not loaded', async () => {
    startServer('free', [msg(100)]);
    renderRoom();
    await screen.findByText('message 100');
    es().emit('message.updated', msg(3, { body: 'ancient edit' }));
    es().emit('message.deleted', msg(4, { body: null, deleted: true }));
    expect(screen.queryByText('ancient edit')).not.toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(1);
  });

  it('ignores malformed events', async () => {
    startServer('free', [msg(1)]);
    renderRoom();
    await screen.findByText('message 1');
    act(() => { (es() as unknown as { listeners: Map<string, ((e: { data: string }) => void)[]> }).listeners.get('message.created')![0]!({ data: '{not json' }); });
    expect(screen.getAllByRole('article')).toHaveLength(1);
  });

  it('shows the connection state and recovers missed messages after a reconnect', async () => {
    const s = startServer('free', [msg(1)]);
    renderRoom();
    await screen.findByText('message 1');
    es().open();
    expect(await screen.findByText('Live')).toBeInTheDocument();
    const before = gets(s).length;

    es().drop();
    expect(await screen.findByText('Reconnecting…')).toBeInTheDocument();
    // While offline: a new message arrives, and an existing one is edited.
    s.messages.push(msg(2, { body: 'sent while you were away' }));
    Object.assign(s.messages[0]!, { body: 'edited while away', editedAt: '2026-01-01T12:00:00Z' });

    es().open(); // the browser reconnected
    expect(await screen.findByText('sent while you were away')).toBeInTheDocument();
    expect(await screen.findByText('edited while away')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(gets(s).length).toBeGreaterThan(before);
    expect(screen.getAllByRole('article')).toHaveLength(2);
  });

  it('catches up when the browser comes back online', async () => {
    const s = startServer('free', [msg(1)]);
    renderRoom();
    await screen.findByText('message 1');
    s.messages.push(msg(2, { body: 'while the train was in a tunnel' }));
    act(() => { window.dispatchEvent(new Event('online')); });
    expect(await screen.findByText('while the train was in a tunnel')).toBeInTheDocument();
  });

  it('explains access loss when the stream is refused, instead of retrying forever', async () => {
    const s = startServer('free', [msg(1)]);
    renderRoom();
    await screen.findByText('message 1');
    s.override = (url) => (url.includes('/messages') ? fail(403, 'PREMIUM_REQUIRED') : undefined);
    es().giveUp();
    expect(await screen.findByRole('heading', { name: 'Premium access required' })).toBeInTheDocument();
  });

  it('reacts to the server ending the stream because access changed', async () => {
    const s = startServer('free', [msg(1)]);
    renderRoom();
    await screen.findByText('message 1');
    es().open();
    s.override = (url) => (url.includes('/messages') ? fail(404, 'NOT_FOUND') : undefined);
    es().emit('closed', { reason: 'access_revoked' });
    expect(es().readyState).toBe(2);
    expect(await screen.findByRole('heading', { name: 'This room is no longer available' })).toBeInTheDocument();
  });

  it('shows Offline when the stream cannot be established for a non-access reason, and keeps the chat usable', async () => {
    startServer('free', [msg(1)]);
    renderRoom();
    await screen.findByText('message 1');
    es().giveUp();
    expect(await screen.findByText('Offline')).toBeInTheDocument();
    expect(screen.getByText('message 1')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled();
  });
});
