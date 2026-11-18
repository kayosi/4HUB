import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { categoryLabel, type StaffRoom } from '../lib/rooms';
import { Alert, Badge, Button, ButtonLink, Spinner } from '../components/ui';
import { EmptyState, ErrorState } from '../components/ui/states';

type Status = 'all' | 'active' | 'archived';

export default function StaffRooms() {
  const [status, setStatus] = useState<Status>('all');
  const rooms = useAsync(() => api<{ rooms: StaffRoom[] }>(`/staff/rooms?status=${status}`), status);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const toggle = async (r: StaffRoom) => {
    setBusy(r.id);
    setError('');
    try {
      await api(`/staff/rooms/${r.id}/${r.archivedAt ? 'restore' : 'archive'}`, { method: 'POST' });
      rooms.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack">
      <div className="page-head row">
        <div><h1>Manage rooms</h1><p className="muted">Create, edit and archive community rooms.</p></div>
        <div className="push"><ButtonLink to="/staff/rooms/new">New room</ButtonLink></div>
      </div>
      <div className="field" style={{ maxWidth: 220 }}>
        <label htmlFor="room-status">Show</label>
        <select id="room-status" className="input" value={status} onChange={(e) => setStatus(e.target.value as Status)}>
          <option value="all">All rooms</option><option value="active">Active</option><option value="archived">Archived</option>
        </select>
      </div>
      {error && <Alert>{error}</Alert>}
      {rooms.status === 'loading' && <Spinner label="Loading rooms" />}
      {rooms.status === 'error' && <ErrorState message={rooms.error.message} onRetry={rooms.reload} />}
      {rooms.status === 'ready' && rooms.data.rooms.length === 0 && (
        <EmptyState title={status === 'all' ? 'No rooms yet' : `No ${status} rooms`} message="Rooms you create will be listed here." />
      )}
      {rooms.status === 'ready' && rooms.data.rooms.length > 0 && (
        <div className="room-grid">
          {rooms.data.rooms.map((r) => (
            <article key={r.id} className="card room-card" data-archived={r.archivedAt ? 'true' : undefined}>
              <div className="room-card-head">
                <h3>{r.name}</h3>
                <div className="row">
                  {r.archivedAt && <Badge>Archived</Badge>}
                  <Badge accent={r.access === 'premium'}>{r.access === 'premium' ? 'Premium' : 'Public'}</Badge>
                </div>
              </div>
              <p className="muted small">{categoryLabel(r.category)} · /rooms/{r.slug}</p>
              <p className="muted clamp">{r.description}</p>
              <div className="row">
                <Link className="btn btn-secondary btn-sm" to={`/staff/rooms/${r.id}/edit`}>Edit</Link>
                <Button variant="ghost" small loading={busy === r.id} onClick={() => toggle(r)} aria-label={`${r.archivedAt ? 'Restore' : 'Archive'} ${r.name}`}>
                  {r.archivedAt ? 'Restore' : 'Archive'}
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
