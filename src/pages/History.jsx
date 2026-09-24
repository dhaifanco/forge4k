import React from 'react';
import { api, fmtDur } from '../api';
import { Badge, ErrorBar, Icon } from '../ui.jsx';
export default function History() {
  const [items, setItems] = React.useState(null), [error, setError] = React.useState('');
  const [confirmClear, setConfirmClear] = React.useState(false);
  const load = () => api.history().then(d => setItems(d.items)).catch(e => setError(e.message));
  React.useEffect(() => { load(); }, []);
  async function act(fn) { try { await fn(); await load(); setError(''); } catch (e) { setError(e.message); } }
  return <div className="page"><header className="page-head"><div><div className="eyebrow">Your finished work</div><h1>History</h1><p className="page-sub">Export results and before/after specs, stored on this PC.</p></div>{!!items?.length && <button className="btn" onClick={() => setConfirmClear(true)}>Clear history</button>}</header>
    <ErrorBar>{error}</ErrorBar>
    {confirmClear && <div className="notice"><p>Clear all history records? Your exported videos will stay on disk.</p><div className="btn-row"><button className="btn danger" onClick={() => { act(api.clearHistory); setConfirmClear(false); }}>Clear records</button><button className="btn" onClick={() => setConfirmClear(false)}>Keep history</button></div></div>}
    {items == null ? <div className="loading-state" role="status"><span className="spinner"/>Loading history</div> : !items.length ? <div className="empty-state"><Icon name="history" size={30}/><h2>A record of every export</h2><p>Complete your first video and its results will appear here.</p></div> : items.map(r => <details className="history-record" key={r.id}><summary><Icon name="film"/><div className="history-info"><strong>{r.source?.name || r.output?.name}</strong><span>{r.presetName} · {new Date(r.startedAt).toLocaleString()}</span></div><Badge kind="good">{r.mode}</Badge></summary><div className="history-detail"><p className="field-help">{r.reason}</p>
      {r.beforeSpecs && r.afterSpecs && <table className="cmp-table"><thead><tr><th>Spec</th><th>Source</th><th>Export</th></tr></thead><tbody>{[['Resolution', r.beforeSpecs.video.resolution, r.afterSpecs.video.resolution], ['Frame rate', r.beforeSpecs.video.fps + ' fps', r.afterSpecs.video.fps + ' fps'], ['Codec', r.beforeSpecs.video.codec, r.afterSpecs.video.codec], ['File size', r.beforeSpecs.file.size?.human, r.afterSpecs.file.size?.human]].map(([label,before,after]) => <tr key={label}><th>{label}</th><td>{before}</td><td>{after}</td></tr>)}</tbody></table>}
      <p className="field-help">Processing time: {fmtDur(r.durationMs / 1000)} · {r.validation?.ok ? 'Decode check passed' : 'Validation not recorded'}</p><div className="history-actions">{r.output?.dir && <button className="btn" onClick={() => act(() => api.openFolder(r.output.dir))}>Open export folder</button>}<button className="btn ghost" onClick={() => act(() => api.deleteHistory(r.id))}>Remove record</button></div>
    </div></details>)}
  </div>;
}
