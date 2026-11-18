/**
 * Sliding-window limiter for chat writes (send, edit, delete), keyed by user id. In-memory by design: it protects a single
 * API instance, matching the live-update hub. Time comes from the injected clock so tests can move it.
 */
export class WriteLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs: number, private readonly now: () => Date) {}

  /** Records an attempt. Returns 0 if allowed, otherwise the number of seconds to wait. */
  take(key: string): number {
    const t = this.now().getTime();
    const recent = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return Math.max(1, Math.ceil((recent[0]! + this.windowMs - t) / 1000));
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.prune(t);
    return 0;
  }

  private prune(t: number): void {
    for (const [k, v] of this.hits) if (v.every((x) => x <= t - this.windowMs)) this.hits.delete(k);
  }
}
