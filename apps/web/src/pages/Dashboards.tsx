import { useAuth } from '../auth/AuthContext';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { Badge, ButtonLink, Card, Spinner } from '../components/ui';
import { EmptyState, ErrorState } from '../components/ui/states';

interface Overview { greeting: string; role: string; premium: boolean; items: unknown[] }

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
    </div>
  );
}

interface AdminOverview { usersByRole: Record<string, number> }
interface AdminUsers { users: { id: string; email: string; displayName: string; role: string; createdAt: string }[] }

export function AdminDashboard() {
  const overview = useAsync(() => api<AdminOverview>('/admin/overview'));
  const users = useAsync(() => api<AdminUsers>('/admin/users?limit=25'));
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Admin dashboard</h1>
        <p className="muted">Platform overview. Management tools arrive in later releases.</p>
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
                  <td>{u.displayName}</td><td>{u.email}</td><td><Badge>{u.role}</Badge></td>
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
