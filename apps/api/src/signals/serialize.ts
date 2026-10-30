import { can, type AuthUser } from '../auth/access.js';
import type { ImageRow, SignalRow, UpdateRow } from './model.js';
import type { Stats, Viewer } from './repo.js';

/** The single authorization rule for signal content. Every route that returns signal data goes through this. */
export function canViewFull(signal: Pick<SignalRow, 'visibility'>, user: AuthUser | null): boolean {
  return signal.visibility === 'free' || can(user, 'premium_signals');
}

export const imageUrl = (signalId: string, imageId: string) => `/api/signals/${signalId}/images/${imageId}`;

const DEFAULT_TEASER = 'Premium signal. Upgrade to see the full setup and analysis.';

/**
 * Builds the API shape for a signal. It is a WHITELIST: premium-only values are added only inside the
 * authorized branch, so an unauthorized response physically cannot contain entry, stops, targets,
 * analysis, pips or image references. Nothing is hidden client-side.
 */
export function serializeSignal(
  s: SignalRow,
  opts: { user: AuthUser | null; images?: ImageRow[]; stats?: Stats; viewer?: Viewer },
) {
  const base = {
    id: s.id,
    asset: s.asset,
    direction: s.direction,
    timeframe: s.timeframe,
    status: s.status,
    visibility: s.visibility,
    result: s.result,
    createdAt: s.created_at,
    closedAt: s.closed_at,
  };

  if (!canViewFull(s, opts.user)) {
    return { ...base, locked: true as const, teaser: s.teaser || DEFAULT_TEASER };
  }

  return {
    ...base,
    locked: false as const,
    updatedAt: s.updated_at,
    riskLevel: s.risk_level,
    entry: s.entry,
    stopLoss: s.stop_loss,
    takeProfits: [s.take_profit_1, s.take_profit_2, s.take_profit_3].filter((v): v is number => v !== null),
    tpLevel: s.tp_level,
    pips: s.pips,
    analysis: s.analysis,
    images: (opts.images ?? []).map((i) => ({ id: i.id, url: imageUrl(s.id, i.id) })),
    stats: opts.stats ?? { reactions: { like: 0, fire: 0, target: 0 }, comments: 0, views: 0 },
    viewer: opts.viewer ?? { reaction: null, bookmarked: false },
  };
}

export const serializeUpdate = (u: UpdateRow) => ({
  id: u.id,
  kind: u.kind,
  message: u.message,
  changes: u.changes,
  createdAt: u.created_at,
});
