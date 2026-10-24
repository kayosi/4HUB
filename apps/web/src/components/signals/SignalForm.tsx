import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent } from 'react';
import { Alert, Button, Field } from '../ui';
import { TIMEFRAMES, type FullSignal } from '../../lib/signals';

export interface SignalDraft {
  asset: string; direction: 'buy' | 'sell'; timeframe: string; entry: number; stopLoss: number;
  takeProfit1: number; takeProfit2: number | null; takeProfit3: number | null;
  riskLevel: 'low' | 'medium' | 'high'; analysis: string; teaser: string; visibility: 'free' | 'premium';
}

const num = (v: string): number | null => {
  const t = v.trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};
const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));

interface Props {
  initial?: FullSignal;
  submitLabel: string;
  /** Only used when creating: lets the admin attach screenshots in the same step. */
  allowFiles?: boolean;
  onSubmit: (draft: SignalDraft, note: string, files: File[]) => Promise<void>;
}

/** One-screen form designed for speed: paste or drop charts, tab through the numbers, publish. */
export function SignalForm({ initial, submitLabel, allowFiles, onSubmit }: Props) {
  const [direction, setDirection] = useState<'buy' | 'sell'>(initial?.direction ?? 'buy');
  const [visibility, setVisibility] = useState<'free' | 'premium'>(initial?.visibility ?? 'premium');
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const urls = useRef<string[]>([]);

  useEffect(() => () => urls.current.forEach(URL.revokeObjectURL), []);
  const addFiles = (list: File[]) => {
    const imgs = list.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    const next = [...files, ...imgs].slice(0, 5);
    const nextUrls = next.map((f) => URL.createObjectURL(f));
    urls.current.forEach(URL.revokeObjectURL);
    urls.current = nextUrls;
    setFiles(next);
    setPreviews(nextUrls);
  };
  const removeFile = (i: number) => {
    const next = files.filter((_, j) => j !== i);
    const nextUrls = next.map((f) => URL.createObjectURL(f));
    urls.current.forEach(URL.revokeObjectURL);
    urls.current = nextUrls;
    setFiles(next);
    setPreviews(nextUrls);
  };
  const onPaste = (e: ClipboardEvent) => {
    const pasted = Array.from(e.clipboardData.files);
    if (pasted.length) { e.preventDefault(); addFiles(pasted); }
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const g = (k: string) => String(f.get(k) ?? '');
    const draft = {
      asset: g('asset').trim().toUpperCase(), direction, timeframe: g('timeframe'),
      entry: num(g('entry')), stopLoss: num(g('stopLoss')), takeProfit1: num(g('takeProfit1')),
      takeProfit2: num(g('takeProfit2')), takeProfit3: num(g('takeProfit3')),
      riskLevel: g('riskLevel') as SignalDraft['riskLevel'], analysis: g('analysis').trim(),
      teaser: visibility === 'premium' ? g('teaser').trim() : '', visibility,
    };
    if (!draft.asset) return setError('Enter the asset, e.g. XAUUSD');
    for (const [label, v] of [['Entry', draft.entry], ['Stop loss', draft.stopLoss], ['Take profit 1', draft.takeProfit1]] as const)
      if (v === null || Number.isNaN(v)) return setError(`${label} must be a number`);
    if ([draft.takeProfit2, draft.takeProfit3].some((v) => v !== null && Number.isNaN(v))) return setError('Take profits must be numbers');
    setError(undefined);
    setBusy(true);
    try {
      await onSubmit(draft as SignalDraft, g('note').trim(), files);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally { setBusy(false); }
  };

  return (
    <form className="stack" onSubmit={submit} onPaste={onPaste} noValidate>
      {error && <Alert>{error}</Alert>}
      <div className="form-grid">
        <Field label="Asset" name="asset" defaultValue={initial?.asset} placeholder="XAUUSD" autoCapitalize="characters" autoComplete="off" autoFocus={!initial} />
        <div className="field">
          <label htmlFor="tf">Timeframe</label>
          <select id="tf" name="timeframe" className="input" defaultValue={initial?.timeframe ?? 'H1'}>{TIMEFRAMES.map((t) => <option key={t}>{t}</option>)}</select>
        </div>
        <div className="field">
          <label htmlFor="risk">Risk</label>
          <select id="risk" name="riskLevel" className="input" defaultValue={initial?.riskLevel ?? 'medium'}>
            <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
          </select>
        </div>
      </div>

      <div className="seg" role="group" aria-label="Direction">
        <button type="button" className="buy" aria-pressed={direction === 'buy'} onClick={() => setDirection('buy')}>▲ Buy</button>
        <button type="button" className="sell" aria-pressed={direction === 'sell'} onClick={() => setDirection('sell')}>▼ Sell</button>
      </div>

      <div className="form-grid">
        <Field label="Entry" name="entry" inputMode="decimal" defaultValue={str(initial?.entry)} autoComplete="off" />
        <Field label="Stop loss" name="stopLoss" inputMode="decimal" defaultValue={str(initial?.stopLoss)} autoComplete="off" />
        <Field label="TP1" name="takeProfit1" inputMode="decimal" defaultValue={str(initial?.takeProfits[0])} autoComplete="off" />
        <Field label="TP2 (optional)" name="takeProfit2" inputMode="decimal" defaultValue={str(initial?.takeProfits[1])} autoComplete="off" />
        <Field label="TP3 (optional)" name="takeProfit3" inputMode="decimal" defaultValue={str(initial?.takeProfits[2])} autoComplete="off" />
      </div>

      <div className="seg" role="group" aria-label="Visibility">
        <button type="button" className="free" aria-pressed={visibility === 'free'} onClick={() => setVisibility('free')}>Free</button>
        <button type="button" className="premium" aria-pressed={visibility === 'premium'} onClick={() => setVisibility('premium')}>Premium</button>
      </div>

      <div className="field">
        <label htmlFor="analysis">Analysis</label>
        <textarea id="analysis" name="analysis" className="input" defaultValue={initial?.analysis} maxLength={5000} />
      </div>
      {visibility === 'premium' && (
        <Field label="Teaser (shown to free members)" name="teaser" maxLength={280} hint="Leave blank for a generic teaser. Do not include levels." autoComplete="off" />
      )}

      {allowFiles && (
        <div className="dropzone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); addFiles(Array.from(e.dataTransfer.files)); }}>
          <p style={{ margin: 0 }}>Paste a screenshot (Ctrl/⌘+V), drop images here, or{' '}
            <label className="btn btn-secondary btn-sm" style={{ marginLeft: 4 }}>
              Choose files<input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
            </label></p>
          {previews.length > 0 && (
            <div className="previews">
              {previews.map((u, i) => (
                <div className="preview" key={u}>
                  <img src={u} alt={`Selected chart ${i + 1}`} />
                  <button type="button" aria-label={`Remove chart ${i + 1}`} onClick={() => removeFile(i)}>×</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {initial && <Field label="Update note (optional)" name="note" maxLength={300} hint="Shown in the history, e.g. “Moved SL to protect profit”." autoComplete="off" />}
      <div className="sticky-submit"><Button type="submit" block loading={busy}>{submitLabel}</Button></div>
    </form>
  );
}
