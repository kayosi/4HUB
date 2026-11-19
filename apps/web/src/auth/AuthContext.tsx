import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, SUSPENDED_EVENT } from '../lib/api';
import type { UserRestrictions } from '../lib/moderation';
import type { Role } from '../lib/roles';

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  createdAt: string;
  country: string | null;
  tradingExperience: 'beginner' | 'intermediate' | 'advanced' | 'professional' | null;
  preferredAssets: string[];
  notificationPrefs: { newSignals: boolean; signalUpdates: boolean; announcements: boolean };
  /** Resolved by the server from the subscription; the UI only uses it to decide what to show. */
  access: { tier: string; premium: boolean };
  /** What is currently limiting this account (a suspended account never gets this far; see `suspension`). */
  restrictions?: Pick<UserRestrictions, 'muted'>;
}

export interface Suspension { message: string; reason: string; expiresAt: string | null }

interface AuthValue {
  user: User | null;
  loading: boolean;
  /** Set when the server says this account is suspended; the app then shows the reason instead of its pages. */
  suspension: Suspension | null;
  login: (email: string, password: string) => Promise<void>;
  register: (displayName: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (u: User) => void;
  /** Re-reads the account from the server (e.g. after a payment, so premium access shows up without a page reload). */
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [suspension, setSuspension] = useState<Suspension | null>(null);

  useEffect(() => {
    const on = (e: Event) => setSuspension((e as CustomEvent<Suspension>).detail);
    window.addEventListener(SUSPENDED_EVENT, on);
    return () => window.removeEventListener(SUSPENDED_EVENT, on);
  }, []);

  useEffect(() => {
    api<{ user: User }>('/me')
      .then((r) => setUser(r.user))
      .catch((e) => {
        // 401 = signed out; 403 ACCOUNT_SUSPENDED is reported through the suspension event.
        if (!(e instanceof ApiError && (e.status === 401 || e.code === 'ACCOUNT_SUSPENDED'))) console.error(e);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setUser((await api<{ user: User }>('/auth/login', { method: 'POST', body: { email, password } })).user);
  }, []);
  const register = useCallback(async (displayName: string, email: string, password: string) => {
    setUser((await api<{ user: User }>('/auth/register', { method: 'POST', body: { displayName, email, password } })).user);
  }, []);
  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setUser(null);
    setSuspension(null);
  }, []);

  const refresh = useCallback(async () => {
    try { setUser((await api<{ user: User }>('/me')).user); } catch { /* keep the current view; the next request will surface real problems */ }
  }, []);

  const value = useMemo(() => ({ user, loading, suspension, login, register, logout, setUser, refresh }), [user, loading, suspension, login, register, logout, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used within AuthProvider');
  return v;
}
