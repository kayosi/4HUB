import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { AuthProvider } from '../auth/AuthContext';
import { Button } from '../components/ui';
import { EmptyState, ErrorState } from '../components/ui/states';

type Handler = (url: string, init?: RequestInit) => { status?: number; body?: unknown };
function mockFetch(handler: Handler) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const { status = 200, body } = handler(url, init);
    return { ok: status < 400, status, json: async () => body } as Response;
  }));
}
const user = (role: string) => ({ user: { id: '1', email: 'a@b.co', displayName: 'Ada', role, createdAt: '2026-01-01' } });
const renderAt = (path: string) =>
  render(<MemoryRouter initialEntries={[path]}><AuthProvider><App /></AuthProvider></MemoryRouter>);

afterEach(() => vi.unstubAllGlobals());

describe('ui components', () => {
  it('Button shows a busy state and disables itself', () => {
    render(<Button loading>Save</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });
  it('renders empty and error states, retry works', async () => {
    const retry = vi.fn();
    render(<><EmptyState title="Nothing yet" /><ErrorState onRetry={retry} /></>);
    expect(screen.getByText('Nothing yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(retry).toHaveBeenCalled();
  });
});

describe('routing and guards', () => {
  it('shows the landing page to visitors', async () => {
    mockFetch(() => ({ status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'x' } } }));
    renderAt('/');
    expect(await screen.findByRole('heading', { level: 1, name: /calm, professional/i })).toBeInTheDocument();
  });

  it('redirects visitors from /dashboard to login', async () => {
    mockFetch(() => ({ status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'x' } } }));
    renderAt('/dashboard');
    expect(await screen.findByRole('heading', { name: /log in/i })).toBeInTheDocument();
  });

  it('shows access denied on /admin for a non-admin member', async () => {
    mockFetch((url) => (url.endsWith('/me') ? { body: user('free') } : { body: {} }));
    renderAt('/admin');
    expect(await screen.findByRole('heading', { name: /access denied/i })).toBeInTheDocument();
  });

  it('renders the member dashboard empty state for a signed-in member', async () => {
    mockFetch((url) =>
      url.endsWith('/me') ? { body: user('free') } : { body: { greeting: 'Ada', role: 'free', premium: false, items: [] } },
    );
    renderAt('/dashboard');
    expect(await screen.findByText(/nothing here yet/i)).toBeInTheDocument();
  });

  it('shows an error state with retry when the API fails', async () => {
    mockFetch((url) => (url.endsWith('/me') ? { body: user('free') } : { status: 500, body: { error: { code: 'INTERNAL', message: 'Boom' } } }));
    renderAt('/dashboard');
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('validates the login form before calling the API', async () => {
    const fetchSpy = vi.fn();
    mockFetch((url) => {
      fetchSpy(url);
      return { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'x' } } };
    });
    renderAt('/login');
    await screen.findByRole('heading', { name: /log in/i });
    await userEvent.click(screen.getByRole('button', { name: /^log in$/i }));
    expect(await screen.findByText(/valid email/i)).toBeInTheDocument();
    await waitFor(() => expect(fetchSpy).not.toHaveBeenCalledWith('/api/auth/login'));
  });
});
