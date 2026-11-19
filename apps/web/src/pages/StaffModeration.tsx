import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useAuth } from '../auth/AuthContext';
import { reasonLabel, type ReportItem, type ReportList, type ReportStatus } from '../lib/moderation';
import RestrictionControls from '../components/moderation/RestrictionControls';
import { Alert, Badge, Button, Spinner } from '../components/ui';
import { EmptyState, ErrorState } from '../components/ui/states';

const TABS: { id: ReportStatus; label: string }[] = [{ id: 'open', label: 'Open' }, { id: 'resolved', label: 'Resolved' }, { id: 'dismissed', label: 'Dismissed' }];
const PAGE = 20;
type Action = 'hide' | 'remove' | 'resolve' | 'dismiss';
const ACTION_LABEL: Record<Action, string> = { hide: 'Hide message', remove: 'Remove message', resolve: 'Resolve report', dismiss: 'Dismiss report' };

function ReportCard({ r, isAdmin, onDone }: { r: ReportItem; isAdmin: boolean; onDone: (feedback: string) => void }) {
  const [action, setAction] = useState<Action | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const open = r.status === 'open';
  const needsReason = action === 'hide' || action === 'remove';

  const go = async (fn: () => Promise<{ resolvedReports?: number } | void>, feedback: (res: { resolvedReports?: number } | void) => string) => {
    setBusy(true); setError('');
    try { const res = await fn(); setAction(null); setText(''); onDone(feedback(res)); } catch (e) { setError(e instanceof ApiError ? e.message : 'Something went wrong.'); } finally { setBusy(false); }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!action) return;
    const body = text.trim();
    if (needsReason && body.length < 3) { setError('Give a short reason. The author will see it.'); return; }
    if (action === 'hide' || action === 'remove') {
      return go(() => api<{ resolvedReports: number }>(`/moderation/messages/${r.message.id}/${action}`, { method: 'POST', body: { reason: body } }),
        (res) => `Message ${action === 'hide' ? 'hidden' : 'removed'}. ${(res as { resolvedReports: number }).resolvedReports} report(s) resolved.`);
    }
    return go(() => api(`/moderation/reports/${r.id}/${action}`, { method: 'POST', body: body ? { note: body } : {} }), () => `Report ${action === 'resolve' ? 'resolved' : 'dismissed'}.`);
  };
  const restore = () => go(() => api(`/moderation/messages/${r.message.id}/unhide`, { method: 'POST' }), () => 'Message restored.');

  return (
    <article className="card report-card" aria-label={`Report about ${r.reportedUser.displayName}`}>
      <div className="room-card-head">
        <div className="row">
          <Badge accent>{reasonLabel(r.reason)}</Badge>
          {r.status !== 'open' && <Badge>{r.status === 'resolved' ? 'Resolved' : 'Dismissed'}</Badge>}
          {r.message.state !== 'visible' && <Badge>{r.message.state === 'hidden' ? 'Hidden' : 'Removed'}</Badge>}
          {r.message.reportCount > 1 && <span className="small muted">{r.message.reportCount} reports on this message</span>}
        </div>
        <time className="muted small" dateTime={r.createdAt}>{new Date(r.createdAt).toLocaleString()}</time>
      </div>
      <p className="small muted">
        Reported by <strong>{r.reporter.displayName}</strong> in <Link to={`/rooms/${r.room.slug}`}>{r.room.name}</Link> · Author: <strong>{r.reportedUser.displayName}</strong>
        {r.reportedUser.role !== 'free' && <> <Badge>{r.reportedUser.role}</Badge></>}
      </p>
      {r.details && <p className="small"><em>“{r.details}”</em></p>}
      <p className="small muted">Reported message</p>
      <blockquote className="report-quote">{r.message.snapshot}</blockquote>
      {r.message.editedSinceReport && r.message.current !== null && (<><p className="small muted">Edited since the report</p><blockquote className="report-quote">{r.message.current}</blockquote></>)}
      {!open && (
        <p className="small muted">
          {r.status === 'resolved' ? 'Resolved' : 'Dismissed'} by {r.resolvedBy?.displayName ?? 'a moderator'}{r.resolvedAt ? ` on ${new Date(r.resolvedAt).toLocaleString()}` : ''}
          {r.resolution && r.resolution !== 'handled' ? ` (message ${r.resolution})` : ''}{r.resolutionNote ? `. ${r.resolutionNote}` : ''}
        </p>
      )}

      {open && !action && (
        <div className="row">
          {r.message.state === 'visible' && <Button small variant="secondary" onClick={() => { setAction('hide'); setError(''); }}>Hide</Button>}
          {r.message.state === 'hidden' && <Button small variant="secondary" loading={busy} onClick={restore}>Restore</Button>}
          {r.message.state !== 'removed' && <Button small variant="secondary" onClick={() => { setAction('remove'); setError(''); }}>Remove</Button>}
          <Button small variant="ghost" onClick={() => { setAction('resolve'); setError(''); }}>Resolve</Button>
          <Button small variant="ghost" onClick={() => { setAction('dismiss'); setError(''); }}>Dismiss</Button>
        </div>
      )}
      {open && action && (
        <form className="chat-form stack" onSubmit={submit} aria-label={ACTION_LABEL[action]}>
          <label className="small" htmlFor={`ra-${r.id}`}>{needsReason ? 'Reason (the author will see this)' : 'Note (optional)'}</label>
          <input id={`ra-${r.id}`} className="input" value={text} maxLength={needsReason ? 200 : 500} autoFocus onChange={(e) => setText(e.target.value)} />
          {action === 'remove' && <p className="muted small">Removing permanently deletes the message text from the chat. The reported text stays on this report.</p>}
          <div className="row">
            <Button small type="submit" loading={busy}>{ACTION_LABEL[action]}</Button>
            <Button small type="button" variant="ghost" disabled={busy} onClick={() => { setAction(null); setError(''); }}>Cancel</Button>
          </div>
        </form>
      )}
      {error && <Alert>{error}</Alert>}

      {isAdmin && r.reportedUser.role !== 'admin' && (
        <RestrictionControls userId={r.reportedUser.id} name={r.reportedUser.displayName} restrictions={r.reportedUser.restrictions} onChange={onDone} />
      )}
    </article>
  );
}

export default function StaffModeration() {
  const { user } = useAuth();
  const [status, setStatus] = useState<ReportStatus>('open');
  const [limit, setLimit] = useState(PAGE);
  const [feedback, setFeedback] = useState('');
  const list = useAsync(() => api<ReportList>(`/moderation/reports?status=${status}&limit=${limit}`), `${status}:${limit}`);
  const counts = list.status === 'ready' ? list.data.counts : null;
  const done = (message: string) => { if (message) setFeedback(message); list.reload(); };

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Moderation queue</h1>
        <p className="muted">Review reported messages. Every action is recorded in the audit log.</p>
      </div>
      <div className="row" role="tablist" aria-label="Report status">
        {TABS.map((t) => (
          <Button key={t.id} small variant={status === t.id ? 'primary' : 'secondary'} role="tab" aria-selected={status === t.id}
            onClick={() => { setStatus(t.id); setLimit(PAGE); setFeedback(''); }}>
            {t.label}{counts ? ` (${counts[t.id]})` : ''}
          </Button>
        ))}
      </div>
      {feedback && <Alert kind="success">{feedback}</Alert>}
      {list.status === 'loading' && <Spinner label="Loading reports" />}
      {list.status === 'error' && <ErrorState message={list.error.message} onRetry={list.reload} />}
      {list.status === 'ready' && list.data.reports.length === 0 && (
        <EmptyState title={status === 'open' ? 'Nothing to review' : `No ${status} reports`} message={status === 'open' ? 'The queue is clear. New reports will appear here.' : 'Reports will be listed here once they have been closed.'} />
      )}
      {list.status === 'ready' && list.data.reports.map((r) => <ReportCard key={r.id} r={r} isAdmin={user?.role === 'admin'} onDone={done} />)}
      {list.status === 'ready' && counts && list.data.reports.length < counts[status] && (
        <div><Button variant="secondary" onClick={() => setLimit((n) => n + PAGE)}>Load more</Button></div>
      )}
    </div>
  );
}
