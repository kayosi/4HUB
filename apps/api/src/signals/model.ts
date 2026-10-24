export const DIRECTIONS = ['buy', 'sell'] as const;
export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export const VISIBILITIES = ['free', 'premium'] as const;
export const STATUSES = ['active', 'closed'] as const;
export const RESULTS = ['tp_hit', 'sl_hit', 'breakeven', 'cancelled'] as const;
export const REACTIONS = ['like', 'fire', 'target'] as const;
export const UPDATE_KINDS = ['created', 'edited', 'sl_moved', 'tp_updated', 'note', 'closed'] as const;
export const TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'] as const;

export type Direction = (typeof DIRECTIONS)[number];
export type RiskLevel = (typeof RISK_LEVELS)[number];
export type Visibility = (typeof VISIBILITIES)[number];
export type SignalStatus = (typeof STATUSES)[number];
export type SignalResult = (typeof RESULTS)[number];
export type ReactionType = (typeof REACTIONS)[number];
export type UpdateKind = (typeof UPDATE_KINDS)[number];

export const MAX_IMAGES_PER_SIGNAL = 5;

export interface SignalRow {
  id: string;
  asset: string;
  direction: Direction;
  timeframe: string;
  entry: number;
  stop_loss: number;
  take_profit_1: number | null;
  take_profit_2: number | null;
  take_profit_3: number | null;
  risk_level: RiskLevel;
  analysis: string;
  teaser: string;
  visibility: Visibility;
  status: SignalStatus;
  result: SignalResult | null;
  tp_level: number | null;
  pips: number | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}

export interface ImageRow {
  id: string;
  signal_id: string;
  storage_key: string;
  content_type: string;
  size_bytes: number;
  position: number;
}

export interface UpdateRow {
  id: string;
  signal_id: string;
  kind: UpdateKind;
  message: string;
  changes: Record<string, { from: unknown; to: unknown }>;
  created_at: Date;
}
