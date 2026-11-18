import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { AuthProvider } from '../auth/AuthContext';
import { lockedRoomFrom } from '../lib/rooms';
import { ApiError } from '../lib/api';

const room = (over: Record<string, unknown> = {}) => ({
  id: 'r1', slug: 'general-chat', name: 'General Chat', description: 'Talk about anything', category: 'general_discussion', access: 'public', locked: false, ...over,
});
const detail = (over: Record<string, unknown> = {}) => ({ ...room(over), guidelines: 'Be kind and stay on topic', createdAt: '2026-01-01', updatedAt: '2026-01-01' });
const staffRoom = (over: Record<string, unknown> = {}) => ({ ...detail(over), sortOrder: 0, archivedAt: null, ...over });

const me = (role: string) => ({ user: {
  id: 'u1', email: 'a@b.co', displayName: 'Ada', role, createdAt: '2026-01-01', country: null, tradingExperience: null, preferredAssets: [],
  notificationPrefs: { newSignals: true, signalUpdates: true, announcements: false }, access: { tier: 'free', premium: false },
} });
const err = (status: number, code: string, message = 'x', details?: unknown) => ({ status, body: { error: { code, message, details } } });

type Handler = (url: string, init?: RequestInit) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;
function mockFetch(handler: Handler) {
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    const { status = 200, body } = await handler(url, init);
    return { ok: status < 400, status, json: async () => body } as Response;
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}
const renderAt = (path: string) => render(<MemoryRouter initialEntries={[path]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
const as = (role: string | null, rest: Handler): Handler => (url, init) => (url.endsWith('/api/me') ? (role ? { body: me(role) } : err(401, 'UNAUTHENTICATED')) : rest(url, init));

afterEach(() => vi.unstubAllGlobals());

describe('rooms lobby', () => {
  it('groups rooms by category and shows locked premium rooms with an unlock action', async () => {
    mockFetch(as(null, () => ({ body: { rooms: [
      room(),
      room({ id: 'r2', slug: 'gold-views', name: 'Gold Views', category: 'market_analysis', access: 'premium', locked: true }),
    ] } })));
    renderAt('/rooms');
    expect(await screen.findByRole('heading', { name: 'General discussion' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Market analysis' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Trading discussion' })).not.toBeInTheDocument();
    expect(screen.getByText(/🔒 Premium/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Unlock access' })).toHaveAttribute('href', '/rooms/gold-views');
    expect(screen.getByRole('link', { name: 'Open room' })).toHaveAttribute('href', '/rooms/general-chat');
  });

  it('shows a loading state, then an empty state without staff actions for members', async () => {
    mockFetch(as('free', () => ({ body: { rooms: [] } })));
    renderAt('/rooms');
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(await screen.findByText('No rooms yet')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /create the first room/i })).not.toBeInTheDocument();
  });

  it('offers staff a way to create the first room', async () => {
    mockFetch(as('moderator', () => ({ body: { rooms: [] } })));
    renderAt('/rooms');
    expect(await screen.findByRole('link', { name: /create the first room/i })).toHaveAttribute('href', '/staff/rooms/new');
  });

  it('shows an error state and retries', async () => {
    let calls = 0;
    mockFetch(as(null, () => (++calls === 1 ? err(500, 'INTERNAL', 'Boom') : { body: { rooms: [room()] } })));
    renderAt('/rooms');
    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('General Chat')).toBeInTheDocument();
  });
});

describe('room page access states', () => {
  it('shows the room and its guidelines when access is granted', async () => {
    mockFetch(as('free', (url) => ({ body: url.includes('/messages') ? { messages: [], hasMore: false, nextBefore: null } : { room: detail() } })));
    renderAt('/rooms/general-chat');
    expect(await screen.findByRole('heading', { name: 'General Chat' })).toBeInTheDocument();
    expect(screen.getByText('Be kind and stay on topic')).toBeInTheDocument();
    expect(await screen.findByRole('log', { name: 'Messages' })).toBeInTheDocument();
  });

  it('asks visitors to log in for a members-only room and reveals no guidelines', async () => {
    mockFetch(as(null, () => err(401, 'UNAUTHENTICATED', 'Sign in', { room: room({ name: 'Gold Views', access: 'premium', locked: true }) })));
    renderAt('/rooms/gold-views');
    expect(await screen.findByRole('heading', { name: /Gold Views is a members-only room/ })).toBeInTheDocument();
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Log in' })).toBeInTheDocument();
    expect(screen.queryByText(/guidelines/i)).not.toBeInTheDocument();
  });

  it('shows an upgrade prompt to free members of a premium room', async () => {
    mockFetch(as('free', () => err(403, 'PREMIUM_REQUIRED', 'Upgrade', { room: room({ name: 'Gold Views', access: 'premium', locked: true }) })));
    renderAt('/rooms/gold-views');
    expect(await screen.findByRole('heading', { name: /Gold Views is a premium room/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View premium plans' })).toHaveAttribute('href', '/pricing');
    expect(screen.queryByText('Room guidelines')).not.toBeInTheDocument();
  });

  it('shows not-found for unknown or archived rooms', async () => {
    mockFetch(as('free', () => err(404, 'NOT_FOUND', 'Room not found')));
    renderAt('/rooms/nope');
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });

  it('shows a retryable error for server failures', async () => {
    mockFetch(as('free', () => err(500, 'INTERNAL', 'Boom')));
    renderAt('/rooms/general-chat');
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('lockedRoomFrom reads the summary the server attaches to access errors', () => {
    expect(lockedRoomFrom(new ApiError(403, 'PREMIUM_REQUIRED', 'x', { room: room() } as never))?.name).toBe('General Chat');
    expect(lockedRoomFrom(new ApiError(403, 'PREMIUM_REQUIRED', 'x'))).toBeNull();
    expect(lockedRoomFrom(new Error('x'))).toBeNull();
  });
});

describe('staff room management', () => {
  it.each(['free', 'premium'])('denies %s members', async (role) => {
    mockFetch(as(role === 'premium' ? 'free' : role, () => ({ body: { rooms: [] } })));
    renderAt('/staff/rooms');
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
  });

  it('redirects visitors to log in', async () => {
    mockFetch(as(null, () => ({ body: {} })));
    renderAt('/staff/rooms');
    expect(await screen.findByRole('heading', { name: /log in|welcome back|sign in/i })).toBeInTheDocument();
  });

  it('lists rooms for moderators and archives one', async () => {
    const spy = mockFetch(as('moderator', (url, init) => {
      if (init?.method === 'POST') return { body: { room: staffRoom({ archivedAt: '2026-02-01' }) } };
      return { body: { rooms: [staffRoom(), staffRoom({ id: 'r2', name: 'Old Room', archivedAt: '2026-01-05' })] } };
    }));
    renderAt('/staff/rooms');
    expect(await screen.findByText('General Chat')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore Old Room' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Archive General Chat' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/api/staff/rooms/r1/archive', expect.objectContaining({ method: 'POST' })));
    expect(screen.getByRole('button', { name: 'Restore Old Room' })).toBeInTheDocument();
  });

  it('creates a room, forcing premium access for the premium community category', async () => {
    const spy = mockFetch(as('admin', (url, init) => (init?.method === 'POST' ? { status: 201, body: { room: staffRoom() } } : { body: { rooms: [] } })));
    renderAt('/staff/rooms/new');
    await userEvent.type(await screen.findByLabelText('Name'), 'VIP Lounge');
    await userEvent.type(screen.getByLabelText('Description'), 'Subscribers only');
    await userEvent.selectOptions(screen.getByLabelText('Category'), 'premium_community');
    expect(screen.getByLabelText('Access')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Create room' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/api/staff/rooms', expect.objectContaining({ method: 'POST' })));
    const call = spy.mock.calls.find(([, i]) => i?.method === 'POST')!;
    expect(JSON.parse(call[1]!.body as string)).toMatchObject({ name: 'VIP Lounge', category: 'premium_community', access: 'premium', sortOrder: 0 });
  });

  it('shows server validation errors next to the fields', async () => {
    mockFetch(as('moderator', (url, init) => (init?.method === 'POST' ? err(400, 'BAD_REQUEST', 'Validation failed', { name: 'At least 3 characters' }) : { body: { rooms: [] } })));
    renderAt('/staff/rooms/new');
    await userEvent.type(await screen.findByLabelText('Name'), 'ab');
    await userEvent.type(screen.getByLabelText('Description'), 'd');
    await userEvent.click(screen.getByRole('button', { name: 'Create room' }));
    expect(await screen.findByText('At least 3 characters')).toBeInTheDocument();
    expect(screen.getByText('Validation failed')).toBeInTheDocument();
  });

  it('loads an existing room into the edit form and saves changes with PATCH', async () => {
    const spy = mockFetch(as('moderator', (url, init) => (init?.method === 'PATCH' ? { body: { room: staffRoom() } } : url.includes('/staff/rooms/r1') ? { body: { room: staffRoom() } } : { body: { rooms: [] } })));
    renderAt('/staff/rooms/r1/edit');
    const name = await screen.findByLabelText('Name');
    expect(name).toHaveValue('General Chat');
    expect(screen.queryByLabelText('URL name')).not.toBeInTheDocument();
    await userEvent.clear(name);
    await userEvent.type(name, 'Renamed');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/api/staff/rooms/r1', expect.objectContaining({ method: 'PATCH' })));
  });

  it('shows not-found when editing a room that does not exist', async () => {
    mockFetch(as('admin', () => err(404, 'NOT_FOUND', 'Room not found')));
    renderAt('/staff/rooms/zzz/edit');
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });
});
