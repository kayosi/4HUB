import type { SignalRow, UpdateKind } from './model.js';

type Patch = Record<string, unknown>;
export type Changes = Record<string, { from: unknown; to: unknown }>;

const TRACKED: Record<string, keyof SignalRow> = {
  asset: 'asset', direction: 'direction', timeframe: 'timeframe', entry: 'entry', stopLoss: 'stop_loss',
  takeProfit1: 'take_profit_1', takeProfit2: 'take_profit_2', takeProfit3: 'take_profit_3',
  riskLevel: 'risk_level', visibility: 'visibility', analysis: 'analysis', teaser: 'teaser',
};
const TEXT_FIELDS = new Set(['analysis', 'teaser']);
const LABEL: Record<string, string> = {
  asset: 'Asset', direction: 'Direction', timeframe: 'Timeframe', entry: 'Entry', riskLevel: 'Risk level',
  visibility: 'Visibility',
};

/** Compares a requested patch to the stored row and returns only genuine changes (DB column names -> values). */
export function diff(before: SignalRow, patch: Patch): { changes: Changes; columns: Patch } {
  const changes: Changes = {};
  const columns: Patch = {};
  for (const [key, to] of Object.entries(patch)) {
    const col = TRACKED[key];
    if (!col) continue;
    const from = before[col] ?? null;
    const next = to ?? null;
    if (from === next) continue;
    columns[key] = next;
    // Long free text is not duplicated into history; the message records that it changed.
    changes[key] = TEXT_FIELDS.has(key) ? { from: null, to: null } : { from, to: next };
  }
  return { changes, columns };
}

/** Human-readable summary, e.g. "Stop loss moved to breakeven (2350.5)". */
export function describe(changes: Changes, newEntry: number): { kind: UpdateKind; message: string } {
  const keys = Object.keys(changes);
  const lines: string[] = [];
  for (const k of keys) {
    const { from, to } = changes[k]!;
    if (k === 'stopLoss') lines.push(to === newEntry ? `Stop loss moved to breakeven (${to})` : `Stop loss moved from ${from} to ${to}`);
    else if (/^takeProfit\d$/.test(k)) {
      const n = k.slice(-1);
      lines.push(from === null ? `Take profit ${n} set to ${to}` : to === null ? `Take profit ${n} removed` : `Take profit ${n} moved from ${from} to ${to}`);
    } else if (k === 'analysis') lines.push('Analysis updated');
    else if (k === 'teaser') lines.push('Teaser updated');
    else lines.push(`${LABEL[k] ?? k} changed from ${from} to ${to}`);
  }
  const only = (pred: (k: string) => boolean) => keys.length > 0 && keys.every(pred);
  const kind: UpdateKind = only((k) => k === 'stopLoss') ? 'sl_moved' : only((k) => /^takeProfit\d$/.test(k)) ? 'tp_updated' : 'edited';
  return { kind, message: lines.join('; ') };
}

export function describeClose(result: string, tpLevel: number | undefined, pips: number | undefined): string {
  const label =
    result === 'tp_hit' ? `TP${tpLevel} hit` : result === 'sl_hit' ? 'Stop loss hit' : result === 'breakeven' ? 'Closed at breakeven' : 'Cancelled';
  const p = pips === undefined ? '' : ` (${pips > 0 ? '+' : ''}${pips} pips)`;
  return `Closed: ${label}${p}`;
}

/** Entry/stop/target sanity for the current direction. `strictStop` is used only when first publishing. */
export function levelProblem(
  s: { direction: string; entry: number; stopLoss: number; tps: (number | null | undefined)[] },
  strictStop: boolean,
): string | null {
  const buy = s.direction === 'buy';
  const tps = s.tps.map((t) => t ?? null);
  if (tps[2] !== null && tps[1] === null) return 'Take profit 3 needs take profit 2';
  if (strictStop && (buy ? s.stopLoss >= s.entry : s.stopLoss <= s.entry))
    return buy ? 'For a buy, stop loss must be below entry' : 'For a sell, stop loss must be above entry';
  let prev = s.entry;
  for (let i = 0; i < 3; i++) {
    const t = tps[i];
    if (t === null || t === undefined) continue;
    if (buy ? t <= prev : t >= prev)
      return buy ? `Take profit ${i + 1} must be above ${i === 0 ? 'entry' : `take profit ${i}`}` : `Take profit ${i + 1} must be below ${i === 0 ? 'entry' : `take profit ${i}`}`;
    prev = t;
  }
  return null;
}

const ROW_KEY: Record<string, keyof SignalRow> = {
  asset: 'asset', direction: 'direction', timeframe: 'timeframe', entry: 'entry', stopLoss: 'stop_loss',
  takeProfit1: 'take_profit_1', takeProfit2: 'take_profit_2', takeProfit3: 'take_profit_3',
  riskLevel: 'risk_level', visibility: 'visibility', analysis: 'analysis', teaser: 'teaser',
};

/** The signal as it would look after applying a (camelCase) patch; used to validate before writing. */
export function applyPatch(before: SignalRow, columns: Patch): SignalRow {
  const next = { ...before } as Record<string, unknown>;
  for (const [k, v] of Object.entries(columns)) next[ROW_KEY[k] as string] = v;
  return next as unknown as SignalRow;
}
