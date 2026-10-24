import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { Alert, Badge, ButtonLink, Card, Spinner } from '../components/ui';
import { SignalCard } from '../components/signals/parts';
import type { Signal } from '../lib/signals';
import { EmptyState, ErrorState } from '../components/ui/states';

interface Overview { greeting: string; role: string; premium: boolean; items: unknown[] }

function LatestSignals() {
  const s = useAsync(() => api<{ signals: Signal[] }>('/signals?limit=3'));
  return (
    <section className="stack" aria-label="Latest signals">
      <div className="row"><h2 style={{ margin: 0 }}>Latest signals</h2><ButtonLink to="/signals" variant="ghost" small>View all →</ButtonLink></div>
      {s.status === 'loading' && <Spinner />}
      {s.status === 'error' && <ErrorState message={s.error.message} onRetry={s.reload} />}
      {s.status === 'ready' && (s.data.signals.length === 0
        ? <EmptyState title="No signals yet" message="New signals will appear here." />
        : <div className="feed">{s.data.signals.map((x) => <SignalCard key={x.id} signal={x} />)}</div>)}
    </section>
  );
}

export function MemberDashboard() {
  const { user } = useAuth();
  const s = useAsync(() => api<Overview>('/member/overview'));
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Welcome, {user?.displayName}</h1>
        <p className="muted">Your member dashboard. <Badge accent>{user?.role}</Badge></p>
      </div>
      {s.status === 'loading' && <Spinner />}
      {s.status === 'error' && <ErrorState message={s.error.message} onRetry={s.reload} />}
      {s.status === 'ready' && (
        <div className="grid grid-2">
          <Card title="Your content">
            {s.data.items.length === 0 ? (
              <EmptyState title="Nothing here yet" message="Content and community features will appear here as they launch." />
            ) : null}
          </Card>
          <Card title="Membership">
            {s.data.premium ? (
              <p>You have premium access.</p>
            ) : (
              <>
                <p className="muted">You are on the free plan. Premium plans will be available soon.</p>
                <ButtonLink to="/pricing" variant="secondary">View plans</ButtonLink>
              </>
            )}
          </Card>
        </div>
      )}
      <LatestSignals />
    </div>
  );
}

interface AdminOverview { usersByRole: Record<string, number> }
interface AdminUsers { users: { id: string; email: string; displayName: string; role: string; createdAt: string }[] }

export function AdminDashboard() {
  const { user: me } = useAuth();
  const [roleError, setRoleError] = useState<string>();
  const overview = useAsync(() => api<AdminOverview>('/admin/overview'));
  const users = useAsync(() => api<AdminUsers>('/admin/users?limit=25'));
  const changeRole = async (id: string, role: string) => {
    setRoleError(undefined);
    try { await api(`/admin/users/${id}/role`, { method: 'PATCH', body: { role } }); users.reload(); overview.reload(); }
    catch (e) { setRoleError(e instanceof Error ? e.message : 'Could not change role'); }
  };
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Admin dashboard</h1>
        <p className="muted">Platform overview.</p>
        <ButtonLink to="/admin/signals/new">Post a signal</ButtonLink>
      </div>
      {overview.status === 'loading' && <Spinner />}
      {overview.status === 'error' && <ErrorState message={overview.error.message} onRetry={overview.reload} />}
      {overview.status === 'ready' && (
        <div className="grid grid-3">
          {['free', 'premium', 'moderator', 'admin'].map((r) => (
            <Card key={r} title={`${r} users`}><div className="stat">{overview.data.usersByRole[r] ?? 0}</div></Card>
          ))}
        </div>
      )}
      <h2>Recent users</h2>
      <p className="muted small">Until payments are added, promote members to premium here.</p>
      {roleError && <Alert>{roleError}</Alert>}
      {users.status === 'loading' && <Spinner />}
      {users.status === 'error' && <ErrorState message={users.error.message} onRetry={users.reload} />}
      {users.status === 'ready' && (users.data.users.length === 0 ? (
        <EmptyState title="No users yet" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Joined</th></tr></thead>
            <tbody>
              {users.data.users.map((u) => (
                <tr key={u.id}>
                  <td>{u.displayName}</td><td>{u.email}</td>
                  <td>
                    {u.id === me?.id ? <Badge>{u.role}</Badge> : (
                      <select className="input" style={{ minHeight: 36, width: 'auto' }} aria-label={`Role for ${u.displayName}`} value={u.role} onChange={(e) => changeRole(u.id, e.target.value)}>
                        {['free', 'premium', 'moderator', 'admin'].map((r) => <option key={r}>{r}</option>)}
                      </select>
                    )}
                  </td>
                  <td>{new Date(u.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
