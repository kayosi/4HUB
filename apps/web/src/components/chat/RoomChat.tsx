import { useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ApiError } from '../../lib/api';
import { useAuth } from '../../auth/AuthContext';
import { charCount, formatMessageTime, MAX_MESSAGE_CHARS, useRoomChat, uuid, type ChatMessage, type LiveState, type Muted } from '../../lib/chat';
import { REPORT_REASONS, untilText, type ReportReason } from '../../lib/moderation';
import type { Role } from '../../lib/roles';
import { Badge, Button, ButtonLink, Spinner } from '../ui';
import { ErrorState } from '../ui/states';

const LIVE_LABEL: Record<LiveState, string> = { connecting: 'Connecting…', live: 'Live', reconnecting: 'Reconnecting…', offline: 'Offline' };
/** A mute that has already run out no longer counts, even if the page was loaded while it was active. */
const activeMute = (m: Muted | null): Muted | null => (m && (!m.expiresAt || new Date(m.expiresAt).getTime() > Date.now()) ? m : null);
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');

interface ItemProps {
  m: ChatMessage;
  own: boolean;
  viewerRole: Role | null;
  /** A muted member can still read, report and delete their own messages, but not edit. */
  muted: boolean;
  onEdit: (id: string, body: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onReport: (id: string, reason: ReportReason, details: string) => Promise<void>;
  onModerate: (id: string, action: 'hide' | 'unhide' | 'remove', reason?: string) => Promise<void>;
}
type Mode = 'view' | 'edit' | 'confirm' | 'report' | 'hide' | 'remove';

/** Mirrors the server's rank rule for the buttons shown; the server still decides. */
const canModerate = (viewer: Role | null, authorIsStaff: boolean) => viewer === 'admin' || (viewer === 'moderator' && !authorIsStaff);

function MessageItem({ m, own, viewerRole, muted, onEdit, onDelete, onReport, onModerate }: ItemProps) {
  const [mode, setMode] = useState<Mode>('view');
  const [draft, setDraft] = useState(m.body ?? '');
  const [reportReason, setReportReason] = useState<ReportReason>('spam');
  const [details, setDetails] = useState('');
  const [modReason, setModReason] = useState('');
  const [reported, setReported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (fn: () => Promise<void>, after: () => void = () => setMode('view')) => {
    setBusy(true);
    setError('');
    try { await fn(); after(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const trimmed = draft.trim();
  const canSave = trimmed.length > 0 && trimmed !== m.body && charCount(trimmed) <= MAX_MESSAGE_CHARS;
  const mod = m.moderation ?? null;
  const name = m.author.displayName;
  const staff = canModerate(viewerRole, m.author.isStaff) && !own;

  const submitReport = (e: FormEvent) => {
    e.preventDefault();
    if (reportReason === 'other' && details.trim().length < 5) { setError('Please describe the problem (at least 5 characters).'); return; }
    void run(async () => {
      try { await onReport(m.id, reportReason, details.trim()); } catch (err) {
        if (err instanceof ApiError && err.code === 'ALREADY_REPORTED') { setReported(true); setMode('view'); return; }
        throw err;
      }
    }, () => { setReported(true); setMode('view'); setDetails(''); });
  };
  const submitModeration = (e: FormEvent) => {
    e.preventDefault();
    if (modReason.trim().length < 3) { setError('Give a short reason. The author will see it.'); return; }
    void run(() => onModerate(m.id, mode === 'hide' ? 'hide' : 'remove', modReason.trim()), () => { setMode('view'); setModReason(''); });
  };

  // What replaces the text when a message is not shown. Moderator actions are stated plainly, to the author most of all.
  const placeholder = (() => {
    if (mod?.state === 'removed') return own ? 'Your message was removed by a moderator.' : 'This message was removed by a moderator.';
    if (mod?.state === 'hidden') return own ? 'Your message was hidden by a moderator while it is reviewed.' : 'This message was hidden by a moderator.';
    return m.deleted ? 'This message was deleted' : null;
  })();

  return (
    <article className="chat-msg" data-own={own ? 'true' : undefined} data-moderated={mod ? mod.state : undefined} aria-label={`Message from ${name}`}>
      <header className="chat-msg-head">
        <strong className="chat-author">{name}</strong>
        {m.author.isStaff && <Badge accent>Staff</Badge>}
        <time className="muted small" dateTime={m.createdAt} title={new Date(m.createdAt).toLocaleString()}>{formatMessageTime(m.createdAt)}</time>
        {m.editedAt && !m.deleted && !mod && <span className="muted small">(edited)</span>}
      </header>

      {placeholder ? (
        <>
          <p className="chat-body chat-deleted">{placeholder}</p>
          {mod?.reason && <p className="small muted chat-reason">Reason: {mod.reason}</p>}
          {mod?.state === 'hidden' && staff && (
            <div className="row chat-actions">
              <Button small variant="secondary" loading={busy} aria-label={`Restore message from ${name}`} onClick={() => run(() => onModerate(m.id, 'unhide'), () => undefined)}>Restore</Button>
              <Button small variant="ghost" aria-label={`Remove message from ${name}`} onClick={() => { setError(''); setMode('remove'); }}>Remove</Button>
            </div>
          )}
        </>
      ) : mode === 'edit' ? (
        <div className="stack">
          <textarea className="input chat-edit" aria-label="Edit message" value={draft} rows={3} autoFocus
            onChange={(e) => setDraft(e.target.value)} />
          <div className="row">
            <Button small loading={busy} disabled={!canSave} onClick={() => run(() => onEdit(m.id, trimmed))}>Save</Button>
            <Button small variant="ghost" disabled={busy} onClick={() => { setMode('view'); setDraft(m.body ?? ''); setError(''); }}>Cancel</Button>
          </div>
        </div>
      ) : (
        // Rendered as a React text node: always escaped, never parsed as HTML or turned into links.
        <p className="chat-body">{m.body}</p>
      )}

      {mode === 'confirm' && (
        <div className="row chat-confirm" role="group" aria-label="Confirm delete">
          <span className="small">Delete this message?</span>
          <Button small variant="secondary" loading={busy} onClick={() => run(() => onDelete(m.id))}>Yes, delete</Button>
          <Button small variant="ghost" disabled={busy} onClick={() => { setMode('view'); setError(''); }}>Cancel</Button>
        </div>
      )}

      {mode === 'report' && (
        <form className="chat-form stack" onSubmit={submitReport} aria-label={`Report message from ${name}`}>
          <label className="small" htmlFor={`rr-${m.id}`}>Why are you reporting this message?</label>
          <select id={`rr-${m.id}`} className="input" value={reportReason} onChange={(e) => setReportReason(e.target.value as ReportReason)}>
            {REPORT_REASONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          <textarea className="input" aria-label="Report details" rows={2} maxLength={500} value={details} placeholder={reportReason === 'other' ? 'Describe the problem' : 'Add details (optional)'}
            onChange={(e) => setDetails(e.target.value)} />
          <div className="row">
            <Button small type="submit" loading={busy}>Send report</Button>
            <Button small type="button" variant="ghost" disabled={busy} onClick={() => { setMode('view'); setError(''); }}>Cancel</Button>
          </div>
        </form>
      )}

      {(mode === 'hide' || mode === 'remove') && (
        <form className="chat-form stack" onSubmit={submitModeration} aria-label={`${mode === 'hide' ? 'Hide' : 'Remove'} message from ${name}`}>
          <label className="small" htmlFor={`mr-${m.id}`}>Reason (the author will see this)</label>
          <input id={`mr-${m.id}`} className="input" value={modReason} maxLength={200} onChange={(e) => setModReason(e.target.value)} autoFocus />
          <p className="muted small">{mode === 'hide' ? 'Hidden messages can be restored later.' : 'Removing permanently deletes the message text. This cannot be undone.'}</p>
          <div className="row">
            <Button small type="submit" loading={busy}>{mode === 'hide' ? 'Hide message' : 'Remove message'}</Button>
            <Button small type="button" variant="ghost" disabled={busy} onClick={() => { setMode('view'); setError(''); }}>Cancel</Button>
          </div>
        </form>
      )}

      {error && <p className="field-error" role="alert">{error}</p>}
      {reported && mode === 'view' && <p className="small muted" role="status">Report sent. Thank you. A moderator will review it.</p>}

      {!placeholder && mode === 'view' && (
        <div className="row chat-actions">
          {own && !muted && <Button small variant="ghost" aria-label={`Edit message from ${name}`} onClick={() => { setDraft(m.body ?? ''); setMode('edit'); }}>Edit</Button>}
          {own && <Button small variant="ghost" aria-label={`Delete message from ${name}`} onClick={() => setMode('confirm')}>Delete</Button>}
          {!own && viewerRole && !reported && <Button small variant="ghost" aria-label={`Report message from ${name}`} onClick={() => { setError(''); setMode('report'); }}>Report</Button>}
          {staff && <Button small variant="ghost" aria-label={`Hide message from ${name}`} onClick={() => { setError(''); setMode('hide'); }}>Hide</Button>}
          {staff && <Button small variant="ghost" aria-label={`Remove message from ${name}`} onClick={() => { setError(''); setMode('remove'); }}>Remove</Button>}
        </div>
      )}
    </article>
  );
}

function Composer({ onSend }: { onSend: (body: string, clientId: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The same id is reused when the user retries the same text, so a send that actually reached the server cannot post twice.
  const attempt = useRef<{ id: string; text: string } | null>(null);
  const trimmed = text.trim();
  const len = charCount(trimmed);
  const tooLong = len > MAX_MESSAGE_CHARS;

  const submit = async () => {
    if (!trimmed || tooLong || busy) return;
    const clientId = attempt.current?.text === trimmed ? attempt.current.id : uuid();
    attempt.current = { id: clientId, text: trimmed };
    setBusy(true);
    setError('');
    try { await onSend(trimmed, clientId); setText(''); attempt.current = null; } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
  };

  return (
    <form className="chat-compose" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {error && <p className="field-error" role="alert">{error} Your message is still here. Press Send to try again.</p>}
      <div className="chat-compose-row">
        <textarea className="input chat-input" aria-label="Message" placeholder="Write a message…" rows={2} value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
        <Button type="submit" loading={busy} disabled={!trimmed || tooLong}>Send</Button>
      </div>
      <div className="row small">
        <span className="muted">Enter to send · Shift+Enter for a new line</span>
        {len > MAX_MESSAGE_CHARS * 0.8 && <span className={tooLong ? 'field-error push' : 'muted push'} role={tooLong ? 'alert' : undefined}>{len}/{MAX_MESSAGE_CHARS}</span>}
      </div>
    </form>
  );
}

export default function RoomChat({ slug, archived = false }: { slug: string; archived?: boolean }) {
  const { user } = useAuth();
  const chat = useRoomChat(slug);
  const location = useLocation();
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const lastId = useRef<string | null>(null);
  const restore = useRef<{ height: number; top: number } | null>(null);
  const firstId = chat.messages[0]?.id;
  const last = chat.messages[chat.messages.length - 1];

  // Keep the newest message in view when the reader is at the bottom (or just sent something); never yank them while reading history.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || !last) return;
    if (lastId.current !== last.id) {
      if (lastId.current === null || atBottom.current || last.author.id === user?.id) el.scrollTop = el.scrollHeight;
      lastId.current = last.id;
    }
  }, [last, user?.id]);
  // After older messages are prepended, keep the reader looking at the same message.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && restore.current) { el.scrollTop = el.scrollHeight - restore.current.height + restore.current.top; restore.current = null; }
  }, [firstId]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottom.current = near;
    setShowJump(!near);
  };
  const loadOlder = async () => {
    const el = listRef.current;
    if (el) restore.current = { height: el.scrollHeight, top: el.scrollTop };
    await chat.loadOlder();
  };

  if (chat.phase === 'loading') return <section className="card chat"><Spinner label="Loading messages" /></section>;
  if (chat.phase === 'error') return <section className="card chat"><ErrorState message={chat.error} onRetry={chat.reload} /></section>;
  if (chat.phase === 'denied') {
    const s = chat.deniedStatus;
    return (
      <section className="card chat">
        <div className="state" role="alert">
          <div className="state-icon" aria-hidden="true">🔒</div>
          {s === 401 && <><h2>Your session has ended</h2><p className="muted">Log in again to keep chatting.</p><Link className="btn btn-primary" to="/login" state={{ from: location.pathname }}>Log in</Link></>}
          {s === 403 && <><h2>Premium access required</h2><p className="muted">Your plan no longer includes this room.</p><ButtonLink to="/pricing">View premium plans</ButtonLink></>}
          {s !== 401 && s !== 403 && <><h2>This room is no longer available</h2><ButtonLink to="/rooms" variant="secondary">Back to rooms</ButtonLink></>}
        </div>
      </section>
    );
  }

  const readOnly = archived || chat.readOnly;
  const muted = activeMute(chat.muted ?? user?.restrictions?.muted ?? null);
  return (
    <section className="card chat" aria-label="Conversation">
      <header className="chat-head">
        <h2>Conversation</h2>
        <span className="chat-live" data-state={chat.live} role="status">{LIVE_LABEL[chat.live]}</span>
      </header>
      <div className="chat-list-wrap">
        <div className="chat-list" ref={listRef} onScroll={onScroll} role="log" aria-label="Messages" aria-live="polite" aria-relevant="additions">
          {chat.hasMore && (
            <div className="chat-older">
              <Button small variant="secondary" loading={chat.loadingOlder} onClick={loadOlder}>Load older messages</Button>
              {chat.olderError && <p className="field-error" role="alert">{chat.olderError}</p>}
            </div>
          )}
          {chat.messages.length === 0 && <p className="muted chat-empty">No messages yet. Start the conversation.</p>}
          {chat.messages.map((m) => (
            <MessageItem key={m.id} m={m} own={m.author.id === user?.id} viewerRole={user?.role ?? null} muted={!!muted}
              onEdit={chat.edit} onDelete={chat.remove} onReport={chat.report} onModerate={chat.moderate} />
          ))}
        </div>
        {showJump && <button type="button" className="btn btn-secondary btn-sm chat-jump" aria-label="Jump to latest messages"
          onClick={() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }}>↓ Latest</button>}
      </div>
      {readOnly
        ? <p className="chat-readonly muted" role="note">This room is archived and read-only.</p>
        : muted
          ? <p className="chat-readonly" role="note"><strong>You cannot post messages {untilText(muted.expiresAt)}.</strong> Reason: {muted.reason}</p>
          : <Composer onSend={chat.send} />}
    </section>
  );
}
