import { Link, useLocation, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useAuth } from '../auth/AuthContext';
import { categoryLabel, lockedRoomFrom, type RoomDetail as Room } from '../lib/rooms';
import { Badge, ButtonLink, Card, Spinner } from '../components/ui';
import RoomChat from '../components/chat/RoomChat';
import { ErrorState, NotFoundState } from '../components/ui/states';

export default function RoomDetail() {
  const { slug = '' } = useParams();
  const { user } = useAuth();
  const location = useLocation();
  const res = useAsync(() => api<{ room: Room }>(`/rooms/${encodeURIComponent(slug)}`), `${slug}:${user?.id ?? 'visitor'}`);

  if (res.status === 'loading') return <Spinner label="Loading room" />;
  if (res.status === 'error') {
    const e = res.error;
    const locked = lockedRoomFrom(e);
    if (e instanceof ApiError && e.status === 404) return <NotFoundState />;
    if (e instanceof ApiError && e.status === 401) {
      return (
        <div className="state" role="alert">
          <div className="state-icon" aria-hidden="true">🔒</div>
          <h2>{locked ? `${locked.name} is a members-only room` : 'Sign in to continue'}</h2>
          <p className="muted">Log in to see whether your account has access to this room.</p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <Link className="btn btn-primary" to="/login" state={{ from: location.pathname }}>Log in</Link>
            <ButtonLink to="/register" variant="secondary">Create account</ButtonLink>
          </div>
        </div>
      );
    }
    if (e instanceof ApiError && e.status === 403) {
      return (
        <div className="state" role="alert">
          <div className="state-icon" aria-hidden="true">🔒</div>
          <h2>{locked ? `${locked.name} is a premium room` : 'This is a premium room'}</h2>
          <p className="muted">{locked?.description ?? 'Upgrade to a premium plan to join this room.'}</p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <ButtonLink to="/pricing">View premium plans</ButtonLink>
            <ButtonLink to="/rooms" variant="secondary">Back to rooms</ButtonLink>
          </div>
        </div>
      );
    }
    return <ErrorState message={e.message} onRetry={res.reload} />;
  }

  const room = res.data.room;
  return (
    <div className="stack">
      <p className="small"><Link to="/rooms">← All rooms</Link></p>
      <div className="page-head">
        <div className="row"><Badge>{categoryLabel(room.category)}</Badge>{room.access === 'premium' && <Badge accent>Premium</Badge>}</div>
        <h1>{room.name}</h1>
        <p className="muted">{room.description}</p>
      </div>
      <Card title="Room guidelines">
        {room.guidelines ? <p className="analysis">{room.guidelines}</p> : <p className="muted">No guidelines have been set for this room yet.</p>}
      </Card>
      {user
        ? <RoomChat key={room.slug} slug={room.slug} archived={room.archived} />
        : (
          <Card title="Conversation">
            <p className="muted">Log in to read and join the conversation in this room.</p>
            <div className="row">
              <Link className="btn btn-primary" to="/login" state={{ from: location.pathname }}>Log in</Link>
              <ButtonLink to="/register" variant="secondary">Create account</ButtonLink>
            </div>
          </Card>
        )}
    </div>
  );
}

