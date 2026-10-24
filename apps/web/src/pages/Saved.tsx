import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { Signal } from '../lib/signals';
import { ButtonLink, Spinner } from '../components/ui';
import { EmptyState, ErrorState } from '../components/ui/states';
import { SignalCard } from '../components/signals/parts';

export default function Saved() {
  const s = useAsync(() => api<{ signals: Signal[] }>('/me/bookmarks'));
  return (
    <div className="stack">
      <div className="page-head"><h1>Saved signals</h1></div>
      {s.status === 'loading' && <Spinner />}
      {s.status === 'error' && <ErrorState message={s.error.message} onRetry={s.reload} />}
      {s.status === 'ready' && (s.data.signals.length === 0
        ? <EmptyState title="Nothing saved yet" message="Use the Save button on a signal to keep it here." action={<ButtonLink to="/signals" variant="secondary">Browse signals</ButtonLink>} />
        : <div className="feed">{s.data.signals.map((x) => <SignalCard key={x.id} signal={x} />)}</div>)}
    </div>
  );
}
