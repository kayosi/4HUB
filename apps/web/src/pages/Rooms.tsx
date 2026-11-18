import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useAuth } from '../auth/AuthContext';
import { isStaff } from '../lib/roles';
import { CATEGORIES, type RoomSummary } from '../lib/rooms';
import { Badge, ButtonLink, Spinner } from '../components/ui';
import { EmptyState, ErrorState } from '../components/ui/states';

export function RoomCard({ room }: { room: RoomSummary }) {
  return (
    <article className="card room-card">
      <div className="room-card-head">
        <h3><Link to={`/rooms/${room.slug}`}>{room.name}</Link></h3>
        {room.access === 'premium' && <Badge accent>{room.locked ? '🔒 Premium' : 'Premium'}</Badge>}
      </div>
      <p className="muted clamp">{room.description}</p>
      <div className="row">
        <Link to={`/rooms/${room.slug}`} className="btn btn-secondary btn-sm">{room.locked ? 'Unlock access' : 'Open room'}</Link>
      </div>
    </article>
  );
}

export default function Rooms() {
  const { user } = useAuth();
  const rooms = useAsync(() => api<{ rooms: RoomSummary[] }>('/rooms'), user?.id ?? 'visitor');
  const staff = !!user && isStaff(user.role);

  return (
    <div className="stack">
      <div className="page-head row">
        <div>
          <h1>Community rooms</h1>
          <p className="muted">Join the conversation. Premium rooms are open to subscribers.</p>
        </div>
        {staff && <div className="push"><ButtonLink to="/staff/rooms" variant="secondary" small>Manage rooms</ButtonLink></div>}
      </div>

      {rooms.status === 'loading' && <Spinner label="Loading rooms" />}
      {rooms.status === 'error' && <ErrorState message={rooms.error.message} onRetry={rooms.reload} />}
      {rooms.status === 'ready' && rooms.data.rooms.length === 0 && (
        <EmptyState
          title="No rooms yet"
          message="Community rooms will appear here as soon as they are opened."
          action={staff ? <ButtonLink to="/staff/rooms/new" small>Create the first room</ButtonLink> : undefined}
        />
      )}
      {rooms.status === 'ready' && CATEGORIES.map((c) => {
        const items = rooms.data.rooms.filter((r) => r.category === c.id);
        if (items.length === 0) return null;
        return (
          <section key={c.id} className="stack" aria-labelledby={`cat-${c.id}`}>
            <div><h2 id={`cat-${c.id}`} className="room-cat">{c.label}</h2><p className="muted small">{c.blurb}</p></div>
            <div className="room-grid">{items.map((r) => <RoomCard key={r.id} room={r} />)}</div>
          </section>
        );
      })}
    </div>
  );
}
