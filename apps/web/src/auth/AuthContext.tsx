import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
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
}

interface AuthValue {
  user: User | null;
  loading: boolean;
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

  useEffect(() => {
    api<{ user: User }>('/me')
      .then((r) => setUser(r.user))
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) console.error(e);
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
  }, []);

  const refresh = useCallback(async () => {
    try { setUser((await api<{ user: User }>('/me')).user); } catch { /* keep the current view; the next request will surface real problems */ }
  }, []);

  const value = useMemo(() => ({ user, loading, login, register, logout, setUser, refresh }), [user, loading, login, register, logout, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used within AuthProvider');
  return v;
}
