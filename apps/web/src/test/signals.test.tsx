import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { AuthProvider } from '../auth/AuthContext';
import { SignalCard } from '../components/signals/parts';
import { SignalForm } from '../components/signals/SignalForm';
import { buildQuery, timeAgo, type FullSignal, type LockedSignal } from '../lib/signals';

const base = { id: 's1', asset: 'XAUUSD', direction: 'buy' as const, timeframe: 'H1', status: 'active' as const, result: null, createdAt: '2026-03-01T10:00:00Z', closedAt: null };
const locked: LockedSignal = { ...base, locked: true, visibility: 'premium', teaser: 'Gold setup brewing' };
const full: FullSignal = {
  ...base, locked: false, visibility: 'free', updatedAt: '2026-03-01T10:00:00Z', riskLevel: 'medium', entry: 2350.5, stopLoss: 2340, takeProfits: [2360, 2370],
  tpLevel: null, pips: null, analysis: 'Bounce off support', images: [{ id: 'i1', url: '/api/signals/s1/images/i1' }],
  stats: { reactions: { like: 2, fire: 1, target: 0 }, comments: 3, views: 10 }, viewer: { reaction: null, bookmarked: false },
};
/** Mirrors the API: "premium" is a free-role account whose subscription gives it access. */
const me = (kind: string) => ({ user: {
  id: 'u1', email: 'a@b.co', displayName: 'Ada', role: kind === 'premium' ? 'free' : kind, createdAt: '2026-01-01', country: null, tradingExperience: null,
  preferredAssets: [], notificationPrefs: { newSignals: true, signalUpdates: true, announcements: false },
  access: { tier: kind === 'premium' ? 'premium' : 'free', premium: kind !== 'free' },
} });

type Handler = (url: string, init?: RequestInit) => { status?: number; body?: unknown };
function mockFetch(handler: Handler) {
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    const { status = 200, body } = handler(url, init);
    return { ok: status < 400, status, json: async () => body } as Response;
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}
const renderAt = (path: string) => render(<MemoryRouter initialEntries={[path]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
const wrap = (ui: React.ReactElement) => {
  mockFetch(() => ({ status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'x' } } }));
  return render(<MemoryRouter><AuthProvider>{ui}</AuthProvider></MemoryRouter>);
};
const visitor = { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'x' } } };

afterEach(() => vi.unstubAllGlobals());

describe('SignalCard', () => {
  it('locked: shows teaser + upgrade prompt and renders no levels or chart', () => {
    wrap(<SignalCard signal={locked} />);
    expect(screen.getByText('Gold setup brewing')).toBeInTheDocument();
    expect(screen.getByText(/premium signal/i)).toBeInTheDocument();
    expect(screen.queryByText('Entry')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
  it('full: shows levels, chart thumbnail, analysis and engagement counts', () => {
    wrap(<SignalCard signal={full} />);
    expect(screen.getByText('2350.5')).toBeInTheDocument();
    expect(screen.getByText('TP2')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /xauusd chart/i })).toHaveAttribute('src', '/api/signals/s1/images/i1');
    expect(screen.getByText('Bounce off support')).toBeInTheDocument();
    expect(screen.getByText(/💬 3/)).toBeInTheDocument();
  });
  it('closed signals show the result and pips', () => {
    wrap(<SignalCard signal={{ ...full, status: 'closed', result: 'tp_hit', tpLevel: 1, pips: 120 }} />);
    expect(screen.getAllByText(/TP hit/).length).toBeGreaterThan(0);
    expect(screen.getByText(/\+120 pips/)).toBeInTheDocument();
  });
});

describe('signal feed page', () => {
  it('visitors see teasers with a call to action', async () => {
    mockFetch((url) => url.endsWith('/me') ? visitor : url.includes('/assets') ? { body: { assets: ['XAUUSD'] } } : { body: { signals: [locked], hasMore: false } });
    renderAt('/signals');
    expect(await screen.findByText('Gold setup brewing')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /create free account/i }).length).toBeGreaterThan(0);
  });

  it('sends the selected filters to the API', async () => {
    const spy = mockFetch((url) => url.endsWith('/me') ? { body: me('free') } : url.includes('/assets') ? { body: { assets: ['XAUUSD', 'EURUSD'] } } : { body: { signals: [full], hasMore: false } });
    renderAt('/signals');
    await screen.findByText('Bounce off support');
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'closed');
    await userEvent.selectOptions(screen.getByLabelText('Access'), 'premium');
    await waitFor(() => {
      const urls = spy.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes('/signals?') && u.includes('status=closed') && u.includes('visibility=premium'))).toBe(true);
    });
  });

  it('shows an empty state when filters match nothing', async () => {
    mockFetch((url) => url.endsWith('/me') ? visitor : url.includes('/assets') ? { body: { assets: [] } } : { body: { signals: [], hasMore: false } });
    renderAt('/signals?status=closed');
    expect(await screen.findByText(/no signals match these filters/i)).toBeInTheDocument();
  });

  it('shows an error state with retry when loading fails', async () => {
    mockFetch((url) => url.endsWith('/me') ? visitor : url.includes('/assets') ? { body: { assets: [] } } : { status: 500, body: { error: { code: 'INTERNAL', message: 'Boom' } } });
    renderAt('/signals');
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('"Load more" appends the next page', async () => {
    const second = { ...full, id: 's2', asset: 'EURUSD' };
    const spy = mockFetch((url) => {
      if (url.endsWith('/me')) return visitor;
      if (url.includes('/assets')) return { body: { assets: [] } };
      return url.includes('offset=1') ? { body: { signals: [second], hasMore: false } } : { body: { signals: [full], hasMore: true } };
    });
    renderAt('/signals');
    await userEvent.click(await screen.findByRole('button', { name: /load more/i }));
    expect(await screen.findByRole('link', { name: 'EURUSD' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'XAUUSD' })).toBeInTheDocument();
    expect(spy).toHaveBeenCalled();
  });
});

describe('signal detail page', () => {
  const detail = (signal: unknown, updates: unknown = null) => ({ body: { signal, updates } });

  it('locked signal: shows the teaser and unlock prompt and never requests comments', async () => {
    const spy = mockFetch((url) => url.endsWith('/me') ? { body: me('free') } : detail(locked));
    renderAt('/signals/s1');
    expect(await screen.findByText('Gold setup brewing')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /see premium plans/i })).toBeInTheDocument();
    expect(screen.queryByText('Update history')).not.toBeInTheDocument();
    expect(spy.mock.calls.some((c) => String(c[0]).includes('/comments'))).toBe(false);
  });

  it('full signal: shows levels, history and lets a member react', async () => {
    const history = [{ id: 'u1', kind: 'created', message: 'XAUUSD Buy published', changes: {}, createdAt: '2026-03-01T10:00:00Z' }, { id: 'u2', kind: 'sl_moved', message: 'Stop loss moved to breakeven (2350.5)', changes: { stopLoss: { from: 2340, to: 2350.5 } }, createdAt: '2026-03-01T12:00:00Z' }];
    mockFetch((url, init) => {
      if (url.endsWith('/me')) return { body: me('free') };
      if (url.includes('/reaction')) return { body: { reaction: 'fire', stats: { reactions: { like: 2, fire: 2, target: 0 }, comments: 3, views: 10 } } };
      if (url.includes('/comments')) return { body: { comments: [] } };
      void init;
      return detail(full, history);
    });
    renderAt('/signals/s1');
    expect(await screen.findByText('Stop loss moved to breakeven (2350.5)')).toBeInTheDocument();
    expect(screen.getByText('SL: 2340 → 2350.5')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /fire/i }));
    await waitFor(() => expect(within(screen.getByRole('group', { name: /signal actions/i })).getByRole('button', { name: /fire/i })).toHaveAttribute('aria-pressed', 'true'));
  });

  it('visitors cannot react but can read free comments and are asked to log in', async () => {
    mockFetch((url) => url.endsWith('/me') ? visitor : url.includes('/comments')
      ? { body: { comments: [{ id: 'c1', body: 'Nice setup', createdAt: '2026-03-01T10:00:00Z', author: { displayName: 'Bob', badge: null }, mine: false }] } }
      : detail(full, []));
    renderAt('/signals/s1');
    expect(await screen.findByText('Nice setup')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /like/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /copy link/i })).toBeInTheDocument(); // free signal: shareable
    expect(screen.queryByLabelText(/add a comment/i)).not.toBeInTheDocument();
  });

  it('premium signals have no share button', async () => {
    mockFetch((url) => url.endsWith('/me') ? { body: me('premium') } : url.includes('/comments') ? { body: { comments: [] } } : detail({ ...full, visibility: 'premium' }, []));
    renderAt('/signals/s1');
    await screen.findByText('Update history');
    expect(screen.queryByRole('button', { name: /copy link/i })).not.toBeInTheDocument();
  });

  it('shows a not-found page for unknown signals', async () => {
    mockFetch((url) => url.endsWith('/me') ? visitor : { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Signal not found' } } });
    renderAt('/signals/zzz');
    expect(await screen.findByRole('heading', { name: /page not found/i })).toBeInTheDocument();
  });
});

describe('admin area access', () => {
  it('shows the new-signal form to admins', async () => {
    mockFetch((url) => url.endsWith('/me') ? { body: me('admin') } : { body: {} });
    renderAt('/admin/signals/new');
    expect(await screen.findByRole('button', { name: /publish signal/i })).toBeInTheDocument();
  });
  it.each(['free', 'premium', 'moderator'])('denies %s members', async (role) => {
    mockFetch((url) => url.endsWith('/me') ? { body: me(role) } : { body: {} });
    renderAt('/admin/signals/new');
    expect(await screen.findByRole('heading', { name: /access denied/i })).toBeInTheDocument();
  });
});

describe('SignalForm (fast posting)', () => {
  it('blocks submit with a clear message when numbers are invalid and does not call onSubmit', async () => {
    const onSubmit = vi.fn();
    render(<SignalForm submitLabel="Publish" allowFiles onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText('Asset'), 'xauusd');
    await userEvent.type(screen.getByLabelText('Entry'), 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText(/entry must be a number/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits normalised values: uppercase asset, decimal commas, optional targets, direction and visibility', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<SignalForm submitLabel="Publish" allowFiles onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText('Asset'), 'xauusd');
    await userEvent.click(screen.getByRole('button', { name: /sell/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Free' }));
    await userEvent.type(screen.getByLabelText('Entry'), '2350,5');
    await userEvent.type(screen.getByLabelText('Stop loss'), '2360');
    await userEvent.type(screen.getByLabelText('TP1'), '2340');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ asset: 'XAUUSD', direction: 'sell', visibility: 'free', entry: 2350.5, stopLoss: 2360, takeProfit1: 2340, takeProfit2: null, takeProfit3: null, teaser: '' });
  });

  it('only offers a teaser field for premium signals', async () => {
    render(<SignalForm submitLabel="Publish" onSubmit={vi.fn()} />);
    expect(screen.getByLabelText(/teaser/i)).toBeInTheDocument(); // premium by default
    await userEvent.click(screen.getByRole('button', { name: 'Free' }));
    expect(screen.queryByLabelText(/teaser/i)).not.toBeInTheDocument();
  });

  it('surfaces server errors from onSubmit', async () => {
    render(<SignalForm submitLabel="Publish" onSubmit={vi.fn().mockRejectedValue(new Error('For a buy, stop loss must be below entry'))} />);
    await userEvent.type(screen.getByLabelText('Asset'), 'x');
    await userEvent.type(screen.getByLabelText('Entry'), '1');
    await userEvent.type(screen.getByLabelText('Stop loss'), '2');
    await userEvent.type(screen.getByLabelText('TP1'), '3');
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText(/stop loss must be below entry/i)).toBeInTheDocument();
  });
});

describe('helpers', () => {
  it('buildQuery drops empty values', () => expect(buildQuery({ a: 'x', b: '', c: undefined, d: 2 })).toBe('?a=x&d=2'));
  it('timeAgo is relative for recent times', () => {
    const now = Date.parse('2026-03-01T12:00:00Z');
    expect(timeAgo('2026-03-01T11:59:50Z', now)).toBe('just now');
    expect(timeAgo('2026-03-01T11:30:00Z', now)).toBe('30m ago');
    expect(timeAgo('2026-03-01T09:00:00Z', now)).toBe('3h ago');
  });
});
