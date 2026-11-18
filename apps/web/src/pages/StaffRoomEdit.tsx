import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { CATEGORIES, type RoomAccess, type RoomCategory, type StaffRoom } from '../lib/rooms';
import { Alert, Button, Card, Field, Spinner } from '../components/ui';
import { ErrorState, NotFoundState } from '../components/ui/states';

function RoomForm({ initial }: { initial?: StaffRoom }) {
  const navigate = useNavigate();
  const [category, setCategory] = useState<RoomCategory>(initial?.category ?? 'general_discussion');
  const [access, setAccess] = useState<RoomAccess>(initial?.access ?? 'public');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const forcedPremium = category === 'premium_community';

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '');
    const body: Record<string, unknown> = {
      name: text('name'), description: text('description'), guidelines: text('guidelines'),
      category, access: forcedPremium ? 'premium' : access, sortOrder: Number(text('sortOrder') || 0),
    };
    if (!initial && text('slug').trim()) body.slug = text('slug').trim();
    setBusy(true);
    setError('');
    setFields({});
    try {
      await api(initial ? `/staff/rooms/${initial.id}` : '/staff/rooms', { method: initial ? 'PATCH' : 'POST', body });
      navigate('/staff/rooms');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the room.');
      if (err instanceof ApiError && err.details) setFields(err.details);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit} noValidate aria-label={initial ? 'Edit room' : 'New room'}>
      {error && <Alert>{error}</Alert>}
      <Card>
        <div className="stack">
          <Field label="Name" name="name" defaultValue={initial?.name} maxLength={80} required error={fields.name} />
          {!initial && <Field label="URL name" name="slug" maxLength={60} hint="Optional. Lowercase letters, numbers and hyphens. Cannot be changed later." error={fields.slug} />}
          <Field label="Description" name="description" defaultValue={initial?.description} maxLength={300} required hint="Shown to everyone in the room list, including locked rooms." error={fields.description} />
          <div className="form-grid">
            <div className="field">
              <label htmlFor="room-category">Category</label>
              <select id="room-category" className="input" value={category} onChange={(e) => setCategory(e.target.value as RoomCategory)}>
                {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
              {fields.category && <span className="field-error" role="alert">{fields.category}</span>}
            </div>
            <div className="field">
              <label htmlFor="room-access">Access</label>
              <select id="room-access" className="input" value={forcedPremium ? 'premium' : access} disabled={forcedPremium} onChange={(e) => setAccess(e.target.value as RoomAccess)}>
                <option value="public">Public: open to everyone</option><option value="premium">Premium: subscribers only</option>
              </select>
              {forcedPremium && <span className="field-hint">Premium community rooms are always premium.</span>}
              {fields.access && <span className="field-error" role="alert">{fields.access}</span>}
            </div>
            <Field label="Sort order" name="sortOrder" type="number" min={0} max={1000} defaultValue={initial?.sortOrder ?? 0} error={fields.sortOrder} />
          </div>
          <div className="field">
            <label htmlFor="room-guidelines">Guidelines</label>
            <textarea id="room-guidelines" name="guidelines" className="input" defaultValue={initial?.guidelines} maxLength={2000} rows={5} />
            <span className="field-hint">Shown only to people who can enter the room.</span>
            {fields.guidelines && <span className="field-error" role="alert">{fields.guidelines}</span>}
          </div>
        </div>
      </Card>
      <div className="row">
        <Button type="submit" loading={busy}>{initial ? 'Save changes' : 'Create room'}</Button>
        <Button type="button" variant="ghost" onClick={() => navigate('/staff/rooms')}>Cancel</Button>
      </div>
    </form>
  );
}

export default function StaffRoomEdit() {
  const { id } = useParams();
  const room = useAsync(() => (id ? api<{ room: StaffRoom }>(`/staff/rooms/${id}`) : Promise.resolve(null)), id ?? 'new');

  if (!id) return <div className="stack"><div className="page-head"><h1>New room</h1></div><RoomForm /></div>;
  if (room.status === 'loading') return <Spinner label="Loading room" />;
  if (room.status === 'error') return room.error instanceof ApiError && room.error.status === 404 ? <NotFoundState /> : <ErrorState message={room.error.message} onRetry={room.reload} />;
  return <div className="stack"><div className="page-head"><h1>Edit room</h1></div><RoomForm initial={room.data!.room} /></div>;
}
