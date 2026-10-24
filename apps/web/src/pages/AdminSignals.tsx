import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { RESULT_LABEL, type Detail, type FullSignal, type Result, type UpdateEntry } from '../lib/signals';
import { Alert, Button, Card, Field, Spinner } from '../components/ui';
import { ErrorState, NotFoundState } from '../components/ui/states';
import { SignalForm, type SignalDraft } from '../components/signals/SignalForm';
import { Timeline } from '../components/signals/parts';

const apiMessage = (e: unknown) => {
  if (e instanceof ApiError) return e.details ? Object.values(e.details).join(' · ') : e.message;
  return e instanceof Error ? e.message : 'Something went wrong';
};

async function uploadFiles(id: string, files: File[]) {
  const fd = new FormData();
  files.forEach((f) => fd.append('files', f));
  return api<Detail>(`/admin/signals/${id}/images`, { method: 'POST', body: fd });
}

export function AdminSignalNew() {
  const nav = useNavigate();
  const publish = async (draft: SignalDraft, _note: string, files: File[]) => {
    let id: string;
    try { id = (await api<Detail>('/admin/signals', { method: 'POST', body: draft })).signal.id; }
    catch (e) { throw new Error(apiMessage(e), { cause: e }); }
    if (files.length) {
      try { await uploadFiles(id, files); }
      catch (e) { nav(`/admin/signals/${id}/edit`, { replace: true, state: { notice: `Signal published, but the screenshots failed to upload: ${apiMessage(e)} You can add them below.` } }); return; }
    }
    nav(`/signals/${id}`, { replace: true });
  };
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <div className="page-head"><h1>New signal</h1><p className="muted">Paste a chart, fill the levels, publish.</p></div>
      <SignalForm submitLabel="Publish signal" allowFiles onSubmit={publish} />
    </div>
  );
}

export function AdminSignalEdit() {
  const { id = '' } = useParams();
  const s = useAsync(() => api<Detail>(`/signals/${id}`), id);
  if (s.status === 'loading') return <Spinner />;
  if (s.status === 'error') return s.error instanceof ApiError && s.error.status === 404 ? <NotFoundState /> : <ErrorState message={s.error.message} onRetry={s.reload} />;
  const sig = s.data.signal;
  if (sig.locked) return <ErrorState message="Unable to load this signal." />;
  return <EditView key={id} initial={sig} updates={s.data.updates ?? []} />;
}

function EditView({ initial, updates: initialUpdates }: { initial: FullSignal; updates: UpdateEntry[] }) {
  const loc = useLocation();
  const [signal, setSignal] = useState(initial);
  const [updates, setUpdates] = useState(initialUpdates);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | undefined>(
    (loc.state as { notice?: string } | null)?.notice ? { kind: 'error', text: (loc.state as { notice: string }).notice } : undefined,
  );
  const closed = signal.status === 'closed';
  const apply = (d: Detail, text: string) => {
    if (!d.signal.locked) setSignal(d.signal);
    setUpdates(d.updates ?? []);
    setMsg({ kind: 'success', text });
  };
  const run = async (fn: () => Promise<Detail>, ok: string) => {
    try { apply(await fn(), ok); } catch (e) { setMsg({ kind: 'error', text: apiMessage(e) }); }
  };

  const save = async (d: SignalDraft, note: string) => {
    const before: Record<string, unknown> = {
      asset: signal.asset, direction: signal.direction, timeframe: signal.timeframe, entry: signal.entry, stopLoss: signal.stopLoss,
      takeProfit1: signal.takeProfits[0], takeProfit2: signal.takeProfits[1] ?? null, takeProfit3: signal.takeProfits[2] ?? null,
      riskLevel: signal.riskLevel, analysis: signal.analysis, visibility: signal.visibility,
    };
    const changed = Object.fromEntries(Object.entries(d).filter(([k, v]) => k !== 'teaser' && before[k] !== v));
    if (d.visibility === 'premium' && d.teaser) changed.teaser = d.teaser;
    if (note) changed.note = note;
    if (Object.keys(changed).length === 0) throw new Error('Nothing changed');
    apply(await api<Detail>(`/admin/signals/${signal.id}`, { method: 'PATCH', body: changed }), 'Signal updated.');
  };

  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <div className="page-head">
        <h1>{signal.asset} · {closed ? 'closed' : 'update'}</h1>
        <p><Link to={`/signals/${signal.id}`}>← View signal</Link></p>
      </div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}

      {!closed && (
        <Card title="Quick actions">
          <div className="actions">
            <Button variant="secondary" small onClick={() => run(() => api<Detail>(`/admin/signals/${signal.id}`, { method: 'PATCH', body: { stopLoss: signal.entry } }), 'Stop loss moved to breakeven.')}>Move SL to breakeven</Button>
          </div>
          <PostNote onPost={(message) => run(() => api<Detail>(`/admin/signals/${signal.id}/updates`, { method: 'POST', body: { message } }), 'Update posted.')} />
        </Card>
      )}

      {!closed && (<Card title="Edit details"><SignalForm initial={signal} submitLabel="Save changes" onSubmit={save} /></Card>)}

      {!closed && <ClosePanel signal={signal} onClose={(body) => run(() => api<Detail>(`/admin/signals/${signal.id}/close`, { method: 'POST', body }), 'Signal closed.')} />}

      <Card title="Chart screenshots">
        {signal.images.length === 0 && <p className="muted">No screenshots yet.</p>}
        <div className="previews" style={{ justifyContent: 'flex-start' }}>
          {signal.images.map((img, i) => (
            <div className="preview" key={img.id}>
              <img src={img.url} alt={`Chart ${i + 1}`} />
              <button type="button" aria-label={`Delete chart ${i + 1}`} onClick={() => run(async () => { await api(`/admin/signals/${signal.id}/images/${img.id}`, { method: 'DELETE' }); return api<Detail>(`/signals/${signal.id}`); }, 'Screenshot removed.')}>×</button>
            </div>
          ))}
        </div>
        <label className="btn btn-secondary btn-sm" style={{ marginTop: 12 }}>
          Add screenshots
          <input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ''; if (f.length) void run(() => uploadFiles(signal.id, f), 'Screenshots added.'); }} />
        </label>
      </Card>

      <Card title="History"><Timeline updates={updates} /></Card>
    </div>
  );
}

function PostNote({ onPost }: { onPost: (m: string) => void }) {
  const [text, setText] = useState('');
  const submit = (e: FormEvent) => { e.preventDefault(); if (text.trim()) { onPost(text.trim()); setText(''); } };
  return (
    <form className="row" onSubmit={submit} style={{ marginTop: 12 }}>
      <div style={{ flex: 1, minWidth: 200 }}><Field label="Post an update" value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder="Price approaching TP1…" /></div>
      <Button type="submit" variant="secondary" disabled={!text.trim()} style={{ alignSelf: 'flex-end' }}>Post</Button>
    </form>
  );
}

function ClosePanel({ signal, onClose }: { signal: FullSignal; onClose: (b: Record<string, unknown>) => void }) {
  const [result, setResult] = useState<Result>('tp_hit');
  const [tp, setTp] = useState('1');
  const [pips, setPips] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = pips.trim() === '' ? undefined : Number(pips.replace(',', '.'));
    if (p !== undefined && !Number.isFinite(p)) return setErr('Pips must be a number');
    setErr(undefined);
    onClose({ result, ...(result === 'tp_hit' ? { tpLevel: Number(tp) } : {}), ...(p !== undefined && result !== 'cancelled' ? { pips: p } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
  };
  return (
    <Card title="Close signal & record result">
      <form className="stack" onSubmit={submit} noValidate>
        {err && <Alert>{err}</Alert>}
        <div className="form-grid">
          <div className="field"><label htmlFor="res">Result</label>
            <select id="res" className="input" value={result} onChange={(e) => setResult(e.target.value as Result)}>
              {(Object.keys(RESULT_LABEL) as Result[]).map((r) => <option key={r} value={r}>{RESULT_LABEL[r]}</option>)}
            </select></div>
          {result === 'tp_hit' && (
            <div className="field"><label htmlFor="tp">Which target</label>
              <select id="tp" className="input" value={tp} onChange={(e) => setTp(e.target.value)}>
                {signal.takeProfits.map((_, i) => <option key={i} value={i + 1}>TP{i + 1}</option>)}
              </select></div>
          )}
          {result !== 'cancelled' && <Field label="Pips / points" inputMode="decimal" value={pips} onChange={(e) => setPips(e.target.value)} hint="Negative for a loss" />}
        </div>
        <Field label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
        <div><Button type="submit" variant="secondary">Close signal</Button></div>
      </form>
    </Card>
  );
}
