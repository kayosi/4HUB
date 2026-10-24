import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { buildQuery, type Signal } from '../lib/signals';
import { Button, Spinner } from '../components/ui';
import { EmptyState, ErrorState } from '../components/ui/states';
import { SignalCard } from '../components/signals/parts';

interface Page { signals: Signal[]; hasMore: boolean }
const FILTERS = ['asset', 'visibility', 'status', 'from', 'to'] as const;

export default function Signals() {
  const [params, setParams] = useSearchParams();
  const f = Object.fromEntries(FILTERS.map((k) => [k, params.get(k) ?? ''])) as Record<(typeof FILTERS)[number], string>;
  const key = JSON.stringify(f);
  const first = useAsync(() => api<Page>(`/signals${buildQuery({ ...f, limit: 20 })}`), key);
  const assets = useAsync(() => api<{ assets: string[] }>('/signals/assets'));
  const [more, setMore] = useState<{ key: string; items: Signal[]; hasMore: boolean } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };
  const extra = more?.key === key ? more : null;
  const items = first.status === 'ready' ? [...first.data.signals, ...(extra?.items ?? [])] : [];
  const hasMore = first.status === 'ready' && (extra ? extra.hasMore : first.data.hasMore);

  const loadMore = async () => {
    setLoadingMore(true);
    setMoreError(false);
    try {
      const page = await api<Page>(`/signals${buildQuery({ ...f, limit: 20, offset: items.length })}`);
      setMore({ key, items: [...(extra?.items ?? []), ...page.signals], hasMore: page.hasMore });
    } catch {
      setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  };
  const filtered = FILTERS.some((k) => f[k]);

  return (
    <div className="stack">
      <div className="page-head"><h1>Signals</h1><p className="muted">Newest first. Premium setups show a teaser until you upgrade.</p></div>
      <form className="filters" onSubmit={(e) => e.preventDefault()} aria-label="Filter signals">
        <div className="field"><label htmlFor="f-asset">Asset</label>
          <select id="f-asset" className="input" value={f.asset} onChange={(e) => set('asset', e.target.value)}>
            <option value="">All assets</option>
            {assets.status === 'ready' && assets.data.assets.map((a) => <option key={a}>{a}</option>)}
          </select></div>
        <div className="field"><label htmlFor="f-vis">Access</label>
          <select id="f-vis" className="input" value={f.visibility} onChange={(e) => set('visibility', e.target.value)}>
            <option value="">Free &amp; premium</option><option value="free">Free</option><option value="premium">Premium</option>
          </select></div>
        <div className="field"><label htmlFor="f-status">Status</label>
          <select id="f-status" className="input" value={f.status} onChange={(e) => set('status', e.target.value)}>
            <option value="">Active &amp; closed</option><option value="active">Active</option><option value="closed">Closed</option>
          </select></div>
        <div className="field"><label htmlFor="f-from">From</label>
          <input id="f-from" className="input" type="date" value={f.from} onChange={(e) => set('from', e.target.value)} /></div>
        <div className="field"><label htmlFor="f-to">To</label>
          <input id="f-to" className="input" type="date" value={f.to} onChange={(e) => set('to', e.target.value)} /></div>
        {filtered && <Button type="button" variant="ghost" onClick={() => setParams({}, { replace: true })}>Clear filters</Button>}
      </form>

      {first.status === 'loading' && <Spinner label="Loading signals" />}
      {first.status === 'error' && <ErrorState message={first.error.message} onRetry={first.reload} />}
      {first.status === 'ready' && items.length === 0 && (
        <EmptyState title={filtered ? 'No signals match these filters' : 'No signals yet'} message={filtered ? 'Try widening your filters.' : 'New signals will appear here as soon as they are published.'} />
      )}
      {items.length > 0 && (
        <>
          <div className="feed">{items.map((s) => <SignalCard key={s.id} signal={s} />)}</div>
          {moreError && <p className="field-error" role="alert">Could not load more signals.</p>}
          {hasMore && <div className="row" style={{ justifyContent: 'center' }}><Button variant="secondary" loading={loadingMore} onClick={loadMore}>Load more</Button></div>}
        </>
      )}
    </div>
  );
}
