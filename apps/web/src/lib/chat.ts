import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';

export const MAX_MESSAGE_CHARS = 2000;
const PAGE_SIZE = 30;
const STREAM_RETRY_MS = 5000;

export interface ChatMessage {
  id: string;
  seq: number;
  roomId: string;
  author: { id: string; displayName: string; isStaff: boolean };
  /** null for a deleted message: the content no longer exists. */
  body: string | null;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  /** Set when a moderator hid (reversible) or removed the message. The reason is only sent to its author and to staff. */
  moderation?: { state: 'hidden' | 'removed'; reason: string | null } | null;
}
interface Page { messages: ChatMessage[]; hasMore: boolean; nextBefore: number | null }

// ---------------------------------------------------------------------------------------------------------------- pure helpers
const bySeq = (a: ChatMessage, b: ChatMessage) => a.seq - b.seq;

/** Adds a message, or replaces it if its id is already present (so a message seen twice, e.g. response + live event, shows once). */
export function insertMessage(list: ChatMessage[], m: ChatMessage): ChatMessage[] {
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) return list.map((x, j) => (j === i ? m : x));
  const next = [...list, m];
  return list[list.length - 1] && m.seq < list[list.length - 1]!.seq ? next.sort(bySeq) : next;
}

/**
 * Applies an edit/delete. Messages that are not loaded are ignored: inserting an old message out of the blue would put a gap
 * in the list that the "load older" cursor would then silently skip over.
 */
export const replaceMessage = (list: ChatMessage[], m: ChatMessage): ChatMessage[] => list.map((x) => (x.id === m.id ? m : x));

export interface ChatList { messages: ChatMessage[]; hasMore: boolean }

/** Merges the newest page (fetched after a reconnect) into what is already on screen. */
export function applyLatest(cur: ChatList, page: Page): ChatList {
  if (cur.messages.length === 0) return { messages: page.messages, hasMore: page.hasMore };
  const pageMin = page.messages[0]?.seq ?? Number.POSITIVE_INFINITY;
  const curMin = cur.messages[0]!.seq;
  const curMax = cur.messages[cur.messages.length - 1]!.seq;
  // More arrived while away than one page holds: keep only the latest page rather than show a hole. "Load older" refills it.
  if (page.hasMore && curMax < pageMin) return { messages: page.messages, hasMore: true };
  let merged = cur.messages;
  for (const m of page.messages) merged = insertMessage(merged, m);
  return { messages: merged, hasMore: pageMin < curMin ? page.hasMore : cur.hasMore };
}

/** RFC 4122 v4 id for idempotent sends. randomUUID only exists in secure contexts, so fall back to getRandomValues. */
export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function formatMessageTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export const charCount = (s: string) => Array.from(s).length;

// ---------------------------------------------------------------------------------------------------------------- hook
export type ChatPhase = 'loading' | 'ready' | 'error' | 'denied';
export type LiveState = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface Muted { reason: string; expiresAt: string | null }
interface State extends ChatList { phase: ChatPhase; error: string; deniedStatus: number | null; readOnly: boolean; muted: Muted | null }
const initial: State = { phase: 'loading', messages: [], hasMore: false, error: '', deniedStatus: null, readOnly: false, muted: null };
const isAccessError = (e: unknown): e is ApiError => e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 404);

/**
 * Loads a room's message history and keeps it live.
 *
 * Connection handling: history is loaded over plain HTTP; live updates arrive over Server-Sent Events. The browser reconnects the
 * stream by itself after an interruption, and every time it (re)opens we fetch the newest page and merge it, so anything missed
 * while disconnected (new, edited or deleted messages) is recovered. Events and responses are merged by message id, so
 * duplicates are impossible. If the server refuses or ends the stream, we ask the API why: access problems become an
 * access-denied state, anything else is retried.
 */
export function useRoomChat(slug: string) {
  const [state, setState] = useState<State>(initial);
  const [live, setLive] = useState<LiveState>('connecting');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState('');
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => { messagesRef.current = state.messages; }, [state.messages]);

  const path = `/rooms/${encodeURIComponent(slug)}/messages`;
  const fetchPage = useCallback((before?: number) => api<Page>(`${path}?limit=${PAGE_SIZE}${before ? `&before=${before}` : ''}`), [path]);
  const deny = useCallback((e: ApiError) => setState((s) => ({ ...s, phase: 'denied', deniedStatus: e.status })), []);

  // Initial load (and retry).
  useEffect(() => {
    let active = true;
    fetchPage().then(
      (p) => active && setState((s) => ({ ...s, phase: 'ready', messages: p.messages, hasMore: p.hasMore, error: '' })),
      (e: unknown) => {
        if (!active) return;
        if (isAccessError(e)) deny(e);
        else setState((s) => ({ ...s, phase: 'error', error: e instanceof Error ? e.message : 'Could not load messages.' }));
      },
    );
    return () => { active = false; };
  }, [fetchPage, deny, loadAttempt]);

  const reload = useCallback(() => { setState(initial); setLive('connecting'); setLoadAttempt((n) => n + 1); }, []);

  /** Fetch the newest page and merge it. Returns false if the room can no longer be read; transient failures are ignored. */
  const resync = useCallback(async (): Promise<boolean> => {
    try {
      const p = await fetchPage();
      setState((s) => (s.phase === 'ready' ? { ...s, ...applyLatest(s, p) } : s));
      return true;
    } catch (e) {
      if (isAccessError(e)) { deny(e); return false; }
      return true;
    }
  }, [fetchPage, deny]);

  // Live updates.
  const ready = state.phase === 'ready';
  useEffect(() => {
    if (!ready) return;
    if (typeof EventSource === 'undefined') return;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const es = new EventSource(`/api/rooms/${encodeURIComponent(slug)}/stream`, { withCredentials: true });

    const gaveUp = () => {
      setLive('offline');
      // The browser stops retrying after a refusal or a non-stream response. Find out why; if it is not an access problem, try again later.
      void resync().then((ok) => { if (ok) retry = setTimeout(() => setStreamAttempt((n) => n + 1), STREAM_RETRY_MS); });
    };
    es.onopen = () => { setLive('live'); void resync(); };
    es.onerror = () => { if (es.readyState === 2 /* CLOSED */) gaveUp(); else setLive('reconnecting'); };
    for (const type of ['message.created', 'message.updated', 'message.deleted'] as const) {
      es.addEventListener(type, (ev) => {
        let m: ChatMessage;
        try { m = JSON.parse((ev as MessageEvent<string>).data) as ChatMessage; } catch { return; }
        setState((s) => ({ ...s, messages: type === 'message.created' ? insertMessage(s.messages, m) : replaceMessage(s.messages, m) }));
      });
    }
    es.addEventListener('closed', () => { es.close(); gaveUp(); }); // the server ended the stream (access changed)
    const onOnline = () => { void resync(); };
    window.addEventListener('online', onOnline);
    return () => { es.close(); clearTimeout(retry); window.removeEventListener('online', onOnline); };
  }, [ready, slug, streamAttempt, resync]);

  const loadOlder = useCallback(async () => {
    const first = messagesRef.current[0];
    if (!first) return;
    setLoadingOlder(true);
    setOlderError('');
    try {
      const p = await fetchPage(first.seq);
      setState((s) => ({ ...s, messages: p.messages.reduce(insertMessage, s.messages), hasMore: p.hasMore }));
    } catch (e) {
      if (isAccessError(e)) deny(e); else setOlderError(e instanceof Error ? e.message : 'Could not load older messages.');
    } finally {
      setLoadingOlder(false);
    }
  }, [fetchPage, deny]);

  /**
   * Runs a write. Losing access (401, or 403 PREMIUM_REQUIRED) flips the whole chat into its denied state, an archived room makes it
   * read-only, and a mute switches the composer off while reading carries on. Other refusals are left to the caller to display.
   */
  const write = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ROOM_ARCHIVED') setState((s) => ({ ...s, readOnly: true }));
      else if (e instanceof ApiError && e.code === 'ACCOUNT_RESTRICTED') {
        const d = e.details as unknown as { reason?: string; expiresAt?: string | null } | undefined;
        setState((s) => ({ ...s, muted: { reason: d?.reason ?? e.message, expiresAt: d?.expiresAt ?? null } }));
      } else if (e instanceof ApiError && (e.status === 401 || (e.status === 403 && e.code === 'PREMIUM_REQUIRED'))) deny(e);
      throw e;
    }
  }, [deny]);

  const send = useCallback((body: string, clientId: string) => write(async () => {
    const { message } = await api<{ message: ChatMessage }>(path, { method: 'POST', body: { body, clientId } });
    setState((s) => ({ ...s, messages: insertMessage(s.messages, message) }));
  }), [path, write]);

  const edit = useCallback((id: string, body: string) => write(async () => {
    const { message } = await api<{ message: ChatMessage }>(`${path}/${id}`, { method: 'PATCH', body: { body } });
    setState((s) => ({ ...s, messages: replaceMessage(s.messages, message) }));
  }), [path, write]);

  const remove = useCallback((id: string) => write(async () => {
    const { message } = await api<{ message: ChatMessage }>(`${path}/${id}`, { method: 'DELETE' });
    setState((s) => ({ ...s, messages: replaceMessage(s.messages, message) }));
  }), [path, write]);

  // Without EventSource support there are no live updates; history and sending still work.
  const liveState: LiveState = typeof EventSource === 'undefined' ? 'offline' : live;
  const report = useCallback((id: string, reason: string, details: string) => write(async () => {
    await api(`${path}/${id}/report`, { method: 'POST', body: details ? { reason, details } : { reason } });
  }), [path, write]);

  /** Staff only (enforced by the server). Hiding and removing need a reason, which the author is shown. */
  const moderate = useCallback((id: string, action: 'hide' | 'unhide' | 'remove', reason?: string) => write(async () => {
    const { message } = await api<{ message: ChatMessage }>(`/moderation/messages/${id}/${action}`, { method: 'POST', ...(reason ? { body: { reason } } : {}) });
    setState((s) => ({ ...s, messages: replaceMessage(s.messages, message) }));
  }), [write]);

  return { ...state, live: liveState, loadingOlder, olderError, loadOlder, reload, send, edit, remove, report, moderate };
}
