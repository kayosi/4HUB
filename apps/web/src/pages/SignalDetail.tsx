import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { REACTION_LABEL, timeAgo, type Comment, type Detail, type FullSignal, type ReactionType, type Stats } from '../lib/signals';
import { Alert, Badge, Button, Card, Spinner } from '../components/ui';
import { EmptyState, ErrorState, NotFoundState } from '../components/ui/states';
import { DirectionBadge, Levels, LockedPanel, ResultLine, StatusBadge, Timeline } from '../components/signals/parts';

export default function SignalDetail() {
  const { id = '' } = useParams();
  const s = useAsync(() => api<Detail>(`/signals/${id}`), id);
  if (s.status === 'loading') return <Spinner label="Loading signal" />;
  if (s.status === 'error') return s.error instanceof ApiError && s.error.status === 404 ? <NotFoundState /> : <ErrorState message={s.error.message} onRetry={s.reload} />;
  return <DetailView key={id} detail={s.data} />;
}

function DetailView({ detail }: { detail: Detail }) {
  const { user } = useAuth();
  const { signal } = detail;
  if (signal.locked) {
    return (
      <div className="stack">
        <Header signal={signal} />
        <Card><p>{signal.teaser}</p><LockedPanel /></Card>
      </div>
    );
  }
  return <FullView initial={signal} updates={detail.updates ?? []} isAdmin={user?.role === 'admin'} />;
}

function Header({ signal }: { signal: Detail['signal'] }) {
  return (
    <div className="detail-head">
      <h1>{signal.asset}</h1>
      <DirectionBadge direction={signal.direction} />
      <Badge>{signal.timeframe}</Badge>
      <StatusBadge signal={signal} />
      {signal.visibility === 'premium' && <span className="badge badge-premium">Premium</span>}
      <time className="muted small push" dateTime={signal.createdAt}>{new Date(signal.createdAt).toLocaleString()}</time>
    </div>
  );
}

function FullView({ initial, updates, isAdmin }: { initial: FullSignal; updates: Detail['updates'] & object; isAdmin: boolean }) {
  const { user } = useAuth();
  const [signal, setSignal] = useState(initial);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const patch = (stats: Stats | undefined, viewer: Partial<FullSignal['viewer']>) =>
    setSignal((s) => ({ ...s, stats: stats ?? s.stats, viewer: { ...s.viewer, ...viewer } }));

  const react = async (type: ReactionType) => {
    setError(undefined); setBusy(true);
    try {
      const same = signal.viewer.reaction === type;
      const r = await api<{ reaction: ReactionType | null; stats: Stats }>(`/signals/${signal.id}/reaction`, same ? { method: 'DELETE' } : { method: 'PUT', body: { type } });
      patch(r.stats, { reaction: r.reaction });
    } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong'); } finally { setBusy(false); }
  };
  const bookmark = async () => {
    setError(undefined); setBusy(true);
    try {
      const on = !signal.viewer.bookmarked;
      await api(`/signals/${signal.id}/bookmark`, { method: on ? 'PUT' : 'DELETE' });
      patch(undefined, { bookmarked: on });
    } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong'); } finally { setBusy(false); }
  };
  const share = async () => {
    const url = `${window.location.origin}/signals/${signal.id}`;
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { window.prompt('Copy this link', url); }
  };

  return (
    <div className="stack">
      <Header signal={signal} />
      <Card>
        <Levels signal={signal} />
        <ResultLine signal={signal} />
        <p className="muted small" style={{ marginTop: 12 }}>Updated {timeAgo(signal.updatedAt)} · 👁 {signal.stats.views} views</p>
      </Card>

      {signal.images.length > 0 && (
        <Card title="Chart">
          <div className="gallery">
            {signal.images.map((img, i) => (
              <a key={img.id} href={img.url} target="_blank" rel="noreferrer"><img src={img.url} alt={`${signal.asset} chart ${i + 1}`} loading="lazy" /></a>
            ))}
          </div>
        </Card>
      )}

      {signal.analysis && <Card title="Analysis"><p className="analysis">{signal.analysis}</p></Card>}

      <Card title="Update history"><Timeline updates={updates} /></Card>

      <div className="actions" role="group" aria-label="Signal actions">
        {(Object.keys(REACTION_LABEL) as ReactionType[]).map((t) => (
          <Button key={t} variant="secondary" small className="react-btn" aria-pressed={signal.viewer.reaction === t} disabled={!user || busy} onClick={() => react(t)}>
            {REACTION_LABEL[t]} {signal.stats.reactions[t]}
          </Button>
        ))}
        {user && <Button variant="secondary" small aria-pressed={signal.viewer.bookmarked} disabled={busy} onClick={bookmark}>{signal.viewer.bookmarked ? '★ Saved' : '☆ Save'}</Button>}
        {signal.visibility === 'free' && <Button variant="ghost" small onClick={share}>{copied ? 'Link copied' : 'Copy link'}</Button>}
        {isAdmin && <Link className="btn btn-secondary btn-sm push" to={`/admin/signals/${signal.id}/edit`}>Edit / update</Link>}
      </div>
      {!user && <p className="muted small"><Link to="/login">Log in</Link> to react, comment and save signals.</p>}
      {error && <Alert>{error}</Alert>}

      <Comments signalId={signal.id} />
    </div>
  );
}

function Comments({ signalId }: { signalId: string }) {
  const { user } = useAuth();
  const list = useAsync(() => api<{ comments: Comment[] }>(`/signals/${signalId}/comments`), signalId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [text, setText] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return setErr('Write something first');
    setBusy(true); setErr(undefined);
    try { await api(`/signals/${signalId}/comments`, { method: 'POST', body: { body: text } }); setText(''); list.reload(); }
    catch (x) { setErr(x instanceof ApiError ? x.details?.body ?? x.message : 'Could not post comment'); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    try { await api(`/comments/${id}`, { method: 'DELETE' }); list.reload(); } catch (x) { setErr(x instanceof Error ? x.message : 'Could not delete'); }
  };
  const canModerate = user?.role === 'admin' || user?.role === 'moderator';

  return (
    <Card title="Comments">
      {list.status === 'loading' && <Spinner label="Loading comments" />}
      {list.status === 'error' && <ErrorState message={list.error.message} onRetry={list.reload} />}
      {list.status === 'ready' && (list.data.comments.length === 0
        ? <EmptyState title="No comments yet" message="Start the discussion." />
        : list.data.comments.map((c) => (
          <div key={c.id} className="comment">
            <div className="comment-meta">
              <strong>{c.author.displayName}</strong>
              {c.author.badge && <Badge accent>{c.author.badge}</Badge>}
              <time dateTime={c.createdAt}>{timeAgo(c.createdAt)}</time>
              {(c.mine || canModerate) && <Button variant="ghost" small className="push" onClick={() => remove(c.id)} aria-label={`Delete comment by ${c.author.displayName}`}>Delete</Button>}
            </div>
            <p>{c.body}</p>
          </div>
        )))}
      {user ? (
        <form className="stack" onSubmit={submit} noValidate style={{ marginTop: 16 }}>
          <div className="field">
            <label htmlFor="comment">Add a comment</label>
            <textarea id="comment" className="input" value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} aria-invalid={err ? true : undefined} />
            {err && <span className="field-error" role="alert">{err}</span>}
          </div>
          <div><Button type="submit" loading={busy}>Post comment</Button></div>
        </form>
      ) : <p className="muted small" style={{ marginTop: 16 }}><Link to="/login">Log in</Link> to join the discussion.</p>}
    </Card>
  );
}
