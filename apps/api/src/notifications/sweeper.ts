import type { FastifyBaseLogger } from 'fastify';
import type { NotificationService } from './service.js';

/**
 * Runs the subscription expiry sweep on a timer. This is the one piece of time-driven work in the notification system, and it
 * is justified: a subscription lapses by the calendar, with no request or event to hang a notice on (see sweepSubscriptions).
 * It is a plain timer, not a queue or a worker: the sweep is idempotent, cheap, and safe to run on every instance.
 * Returns a function that stops it.
 */
export function startSweeper(service: Pick<NotificationService, 'sweepSubscriptions'>, everyMs: number, log: Pick<FastifyBaseLogger, 'error'>): () => void {
  if (everyMs <= 0) return () => undefined;
  let running = false; // never overlap two sweeps
  const run = () => {
    if (running) return;
    running = true;
    service.sweepSubscriptions().catch((err: unknown) => log.error({ err }, 'subscription notice sweep failed')).finally(() => { running = false; });
  };
  const timer = setInterval(run, everyMs);
  timer.unref();
  const first = setTimeout(run, Math.min(10_000, everyMs)); // catch up shortly after a (re)start
  first.unref();
  return () => { clearInterval(timer); clearTimeout(first); };
}
