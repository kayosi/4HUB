export type Direction = 'buy' | 'sell';
export type Result = 'tp_hit' | 'sl_hit' | 'breakeven' | 'cancelled';
export type ReactionType = 'like' | 'fire' | 'target';
export type UpdateKind = 'created' | 'edited' | 'sl_moved' | 'tp_updated' | 'note' | 'closed';

interface Base {
  id: string;
  asset: string;
  direction: Direction;
  timeframe: string;
  status: 'active' | 'closed';
  visibility: 'free' | 'premium';
  result: Result | null;
  createdAt: string;
  closedAt: string | null;
}
export interface LockedSignal extends Base {
  locked: true;
  teaser: string;
}
export interface Stats {
  reactions: Record<ReactionType, number>;
  comments: number;
  views: number;
}
export interface FullSignal extends Base {
  locked: false;
  updatedAt: string;
  riskLevel: 'low' | 'medium' | 'high';
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  tpLevel: number | null;
  pips: number | null;
  analysis: string;
  images: { id: string; url: string }[];
  stats: Stats;
  viewer: { reaction: ReactionType | null; bookmarked: boolean };
}
export type Signal = LockedSignal | FullSignal;

export interface UpdateEntry {
  id: string;
  kind: UpdateKind;
  message: string;
  changes: Record<string, { from: unknown; to: unknown }>;
  createdAt: string;
}
export interface Detail {
  signal: Signal;
  updates: UpdateEntry[] | null;
}
export interface Comment {
  id: string;
  body: string;
  createdAt: string;
  author: { displayName: string; badge: 'admin' | 'moderator' | null };
  mine: boolean;
}

export const TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'];
export const REACTION_LABEL: Record<ReactionType, string> = { like: '👍 Like', fire: '🔥 Fire', target: '🎯 Target' };
export const RESULT_LABEL: Record<Result, string> = { tp_hit: 'TP hit', sl_hit: 'SL hit', breakeven: 'Breakeven', cancelled: 'Cancelled' };

export const formatPrice = (n: number) => String(n);
export const formatPips = (n: number) => `${n > 0 ? '+' : ''}${n} pips`;
export const resultTone = (r: Result | null) => (r === 'tp_hit' ? 'positive' : r === 'sl_hit' ? 'negative' : 'muted');

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function buildQuery(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}
