import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ApiError } from '../../lib/api';
import { useAuth } from '../../auth/AuthContext';
import { isStaff } from '../../lib/roles';
import { charCount, formatMessageTime, MAX_MESSAGE_CHARS, useRoomChat, uuid, type ChatMessage, type LiveState } from '../../lib/chat';
import { Badge, Button, ButtonLink, Spinner } from '../ui';
import { ErrorState } from '../ui/states';

const LIVE_LABEL: Record<LiveState, string> = { connecting: 'Connecting…', live: 'Live', reconnecting: 'Reconnecting…', offline: 'Offline' };
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');

function MessageItem({ m, own, canDelete, onEdit, onDelete }: {
  m: ChatMessage; own: boolean; canDelete: boolean;
  onEdit: (id: string, body: string) => Promise<void>; onDelete: (id: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm'>('view');
  const [draft, setDraft] = useState(m.body ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try { await fn(); setMode('view'); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const trimmed = draft.trim();
  const canSave = trimmed.length > 0 && trimmed !== m.body && charCount(trimmed) <= MAX_MESSAGE_CHARS;

  return (
    <article className="chat-msg" data-own={own ? 'true' : undefined} aria-label={`Message from ${m.author.displayName}`}>
      <header className="chat-msg-head">
        <strong className="chat-author">{m.author.displayName}</strong>
        {m.author.isStaff && <Badge accent>Staff</Badge>}
        <time className="muted small" dateTime={m.createdAt} title={new Date(m.createdAt).toLocaleString()}>{formatMessageTime(m.createdAt)}</time>
        {m.editedAt && !m.deleted && <span className="muted small">(edited)</span>}
      </header>

      {m.deleted ? (
        <p className="chat-body chat-deleted">This message was deleted</p>
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
      {error && <p className="field-error" role="alert">{error}</p>}

      {!m.deleted && mode === 'view' && (own || canDelete) && (
        <div className="row chat-actions">
          {own && <Button small variant="ghost" aria-label={`Edit message from ${m.author.displayName}`} onClick={() => { setDraft(m.body ?? ''); setMode('edit'); }}>Edit</Button>}
          {canDelete && <Button small variant="ghost" aria-label={`Delete message from ${m.author.displayName}`} onClick={() => setMode('confirm')}>Delete</Button>}
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

  const staff = !!user && isStaff(user.role);
  const readOnly = archived || chat.readOnly;
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
            <MessageItem key={m.id} m={m} own={m.author.id === user?.id} canDelete={m.author.id === user?.id || staff}
              onEdit={chat.edit} onDelete={chat.remove} />
          ))}
        </div>
        {showJump && <button type="button" className="btn btn-secondary btn-sm chat-jump" aria-label="Jump to latest messages"
          onClick={() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }}>↓ Latest</button>}
      </div>
      {readOnly
        ? <p className="chat-readonly muted" role="note">This room is archived and read-only.</p>
        : <Composer onSend={chat.send} />}
    </section>
  );
}
