import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { Badge, ButtonLink } from '../ui';
import { RESULT_LABEL, formatPips, resultTone, type Signal, type UpdateEntry } from '../../lib/signals';

export const DirectionBadge = ({ direction }: { direction: 'buy' | 'sell' }) => (
  <span className={`dir dir-${direction}`}>{direction === 'buy' ? '▲ Buy' : '▼ Sell'}</span>
);

export function StatusBadge({ signal }: { signal: Signal }) {
  if (signal.status === 'active') return <Badge accent>Active</Badge>;
  return <span className={`badge result-${resultTone(signal.result)}`}>{signal.result ? RESULT_LABEL[signal.result] : 'Closed'}</span>;
}

/** Prompt shown instead of premium content. The content itself is never sent by the API. */
export function LockedPanel({ teaser }: { teaser?: string }) {
  const { user } = useAuth();
  return (
    <div className="locked" role="note">
      <div className="locked-icon" aria-hidden="true">🔒</div>
      <div>
        <strong>Premium signal</strong>
        {teaser && <p className="muted">{teaser}</p>}
        <p className="muted small">Entry, stop loss, targets, chart and analysis are available to premium members.</p>
        {user ? (
          <ButtonLink to="/pricing" small>See premium plans</ButtonLink>
        ) : (
          <div className="row">
            <ButtonLink to="/register" small>Create free account</ButtonLink>
            <ButtonLink to="/login" variant="secondary" small>Log in</ButtonLink>
          </div>
        )}
      </div>
    </div>
  );
}

export function Levels({ signal }: { signal: Extract<Signal, { locked: false }> }) {
  const tp = (i: number) => signal.takeProfits[i];
  const hit = signal.result === 'tp_hit' ? signal.tpLevel : null;
  return (
    <dl className="levels">
      <div><dt>Entry</dt><dd>{signal.entry}</dd></div>
      <div><dt>Stop loss</dt><dd className="negative">{signal.stopLoss}</dd></div>
      {[0, 1, 2].map((i) => tp(i) !== undefined && (
        <div key={i}><dt>TP{i + 1}{hit === i + 1 ? ' ✓' : ''}</dt><dd className="positive">{tp(i)}</dd></div>
      ))}
      <div><dt>Risk</dt><dd className="cap">{signal.riskLevel}</dd></div>
    </dl>
  );
}

export function ResultLine({ signal }: { signal: Signal }) {
  if (signal.status !== 'closed' || !signal.result) return null;
  const pips = !signal.locked && signal.pips !== null ? ` · ${formatPips(signal.pips)}` : '';
  return <p className={`result-line ${resultTone(signal.result)}`}>{RESULT_LABEL[signal.result]}{pips}</p>;
}

export function Timeline({ updates }: { updates: UpdateEntry[] }) {
  return (
    <ol className="timeline" aria-label="Signal history">
      {updates.map((u) => (
        <li key={u.id} className={`tl-${u.kind}`}>
          <time dateTime={u.createdAt}>{new Date(u.createdAt).toLocaleString()}</time>
          <p>{u.message}</p>
          {(['stopLoss', 'takeProfit1', 'takeProfit2', 'takeProfit3', 'entry'] as const).map((k) => {
            const c = u.changes[k];
            return c ? <span key={k} className="chip">{k === 'stopLoss' ? 'SL' : k === 'entry' ? 'Entry' : k.replace('takeProfit', 'TP')}: {String(c.from ?? '—')} → {String(c.to ?? '—')}</span> : null;
          })}
        </li>
      ))}
    </ol>
  );
}

export function SignalCard({ signal }: { signal: Signal }) {
  return (
    <article className={`card signal-card${signal.locked ? ' is-locked' : ''}`}>
      <header className="signal-head">
        <h3><Link to={`/signals/${signal.id}`}>{signal.asset}</Link></h3>
        <DirectionBadge direction={signal.direction} />
        <Badge>{signal.timeframe}</Badge>
        <StatusBadge signal={signal} />
        {signal.visibility === 'premium' && <span className="badge badge-premium">Premium</span>}
        <time className="muted small push" dateTime={signal.createdAt}>{new Date(signal.createdAt).toLocaleDateString()}</time>
      </header>
      {signal.locked ? (
        <>
          <p className="muted">{signal.teaser}</p>
          <LockedPanel />
        </>
      ) : (
        <>
          <Levels signal={signal} />
          <ResultLine signal={signal} />
          {signal.images[0] && (
            <img className="thumb" src={signal.images[0].url} alt={`${signal.asset} chart`} loading="lazy" />
          )}
          {signal.analysis && <p className="clamp">{signal.analysis}</p>}
          <footer className="signal-foot muted small">
            <span>👍 {signal.stats.reactions.like + signal.stats.reactions.fire + signal.stats.reactions.target}</span>
            <span>💬 {signal.stats.comments}</span>
            <span>👁 {signal.stats.views}</span>
            <Link to={`/signals/${signal.id}`} className="push">View details →</Link>
          </footer>
        </>
      )}
    </article>
  );
}
