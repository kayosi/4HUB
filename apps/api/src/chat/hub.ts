import type { ChatMessage } from './serialize.js';

export type ChatEventType = 'message.created' | 'message.updated' | 'message.deleted';
export interface ChatEvent { type: ChatEventType; message: ChatMessage }

export interface Connection {
  userId: string;
  roomId: string;
  send(event: string, data: unknown, id?: number): void;
  end(): void;
}

/**
 * In-process publish/subscribe for live room updates. Deliberately simple: one API instance, no extra infrastructure.
 * Scaling to several instances means replacing publish() with a shared bus (e.g. PostgreSQL LISTEN/NOTIFY or Redis);
 * routes only ever call add/remove/publish, so that swap stays local to this file.
 */
export class ChatHub {
  private rooms = new Map<string, Set<Connection>>();
  private perUser = new Map<string, number>();

  add(c: Connection): void {
    let set = this.rooms.get(c.roomId);
    if (!set) this.rooms.set(c.roomId, (set = new Set()));
    set.add(c);
    this.perUser.set(c.userId, (this.perUser.get(c.userId) ?? 0) + 1);
  }

  remove(c: Connection): void {
    const set = this.rooms.get(c.roomId);
    if (!set?.delete(c)) return;
    if (set.size === 0) this.rooms.delete(c.roomId);
    const n = (this.perUser.get(c.userId) ?? 1) - 1;
    if (n <= 0) this.perUser.delete(c.userId); else this.perUser.set(c.userId, n);
  }

  streamsFor(userId: string): number { return this.perUser.get(userId) ?? 0; }
  size(): number { return [...this.rooms.values()].reduce((n, s) => n + s.size, 0); }

  publish(roomId: string, e: ChatEvent): void {
    for (const c of this.rooms.get(roomId) ?? []) {
      try { c.send(e.type, e.message, e.message.seq); } catch { /* a broken connection must not affect the others */ }
    }
  }

  /** Ends every stream so the server can shut down; browsers reconnect on their own. */
  closeAll(): void {
    for (const set of [...this.rooms.values()]) for (const c of [...set]) { try { c.end(); } catch { /* already gone */ } }
  }
}
