import React from 'react';
import { api, fmtBytes, fmtDur } from '../api';
import { Card, Badge, DropZone, ErrorBar, Icon, LogViewer } from '../ui.jsx';

export default function Optimizer() {
  const [items, setItems] = React.useState([]), [selectedId, select] = React.useState(null);
  const [presets, setPresets] = React.useState([]), [queue, setQueue] = React.useState([]);
  const [gpu, setGpu] = React.useState(null), [settings, setSettings] = React.useState(null);
  const [phase, setPhase] = React.useState('idle'), [error, setError] = React.useState('');
  const [plan, setPlan] = React.useState(null), [planError, setPlanError] = React.useState('');
  const [encoder, setEncoder] = React.useState('auto'), [previewError, setPreviewError] = React.useState(false);
  const urls = React.useRef(new Set());
  const item = items.find(it => it.uploadId === selectedId) || items[0];
  const selectedPreset = presets.find(p => p.id === item?.preset);
  React.useEffect(() => {
    api.presets().then(d => setPresets(d.presets)).catch(e => setError(e.message));
    api.settings().then(setSettings).catch(e => setError(e.message));
    api.gpu().then(d => setGpu(d.gpu)).catch(() => setGpu({ available: false }));
    return () => { for (const url of urls.current) URL.revokeObjectURL(url); };
  }, []);
  React.useEffect(() => {
    let stopped = false, timer;
    async function poll() {
      try { const d = await api.queue(); if (!stopped) setQueue(d.items); }
      catch (e) { if (!stopped) setError(e.message); }
      if (!stopped) timer = setTimeout(poll, 1200);
    }
    poll(); return () => { stopped = true; clearTimeout(timer); };
  }, []);
  React.useEffect(() => {
    let stale = false; setPlan(null); setPlanError('');
    if (item) api.plan(item.uploadId, item.preset).then(d => { if (!stale) setPlan(d); }).catch(e => { if (!stale) setPlanError(e.message); });
    return () => { stale = true; };
  }, [item?.uploadId, item?.preset]);
  React.useEffect(() => setPreviewError(false), [item?.uploadId]);
  async function onFiles(files) {
    if (files.length > 30) { setError('Add up to 30 videos at a time.'); return; }
    setPhase('analyzing'); setError('');
    try {
      const d = await api.analyzeBatch(files);
      const added = [], failed = [];
      d.items.forEach((it, index) => {
        if (!it.uploadId) { failed.push(it.name + ': ' + it.error); return; }
        const url = URL.createObjectURL(files[index]); urls.current.add(url);
        added.push({ ...it, url, preset: it.recommendation?.presetId || 'tiktok_1080p60' });
      });
      setItems(prev => [...prev, ...added]);
      if (added.length) select(added[0].uploadId);
      setError(failed.join(' '));
    } catch (e) { setError(e.message); }
    finally { setPhase('idle'); }
  }
  function remove(id) {
    const source = items.find(it => it.uploadId === id);
    if (source) { URL.revokeObjectURL(source.url); urls.current.delete(source.url); }
    setItems(prev => prev.filter(it => it.uploadId !== id));
  }
  function preset(value, all = false) { setItems(prev => prev.map(it => all || it.uploadId === item?.uploadId ? { ...it, preset: value } : it)); }
  async function exportAll() {
    if (phase !== 'idle' || !items.length) return;
    setPhase('submitting'); setError('');
    const done = [], failures = [];
    for (const source of items) {
      try { await api.optimize(source.uploadId, source.preset, { encoder }); done.push(source.uploadId); }
      catch (e) { failures.push(source.file.name + ': ' + e.message); }
    }
    for (const id of done) remove(id);
    setError(failures.join(' ')); setPhase('idle');
    api.queue().then(d => setQueue(d.items)).catch(e => setError(e.message));
  }
  async function action(fn) { try { await fn(); setQueue((await api.queue()).items); } catch (e) { setError(e.message); } }
  const active = queue.filter(j => ['waiting', 'processing'].includes(j.state));
  return <div className="page workspace">
    <header className="page-head"><div><div className="eyebrow">Create. Prepare. Publish.</div><h1>Video workspace</h1><p className="page-sub">A clean export starts with a good source.</p></div><div className="header-meta"><Icon name="chip"/><span>{gpu ? gpu.available && (gpu.nvenc?.h264 || gpu.nvenc?.hevc) ? gpu.name : 'CPU processing' : 'Checking hardware'}</span></div></header>
    <ErrorBar>{error}</ErrorBar>
    <div className="workspace-grid">
      <div className="media-column">
        <section className="monitor" aria-label="Source preview">
          <div className="monitor-top"><span><Icon name="film" size={16}/> Source monitor</span><span>{item ? item.video.resolution + ' · ' + item.video.fps + ' fps' : 'No source selected'}</span></div>
          <div className={'monitor-stage' + (!item ? ' is-empty' : '')}>
            {phase === 'analyzing' ? <div className="loading-state" role="status"><span className="spinner"/><strong>Inspecting your videos</strong><span>Reading resolution, frame rate and color.</span></div> : item ? <>
              <video key={item.uploadId} src={item.url} controls preload="metadata" onError={() => setPreviewError(true)} aria-label={'Preview ' + item.file.name}/>
              {previewError && <p className="preview-note">This codec cannot be previewed here. The export engine can still process it.</p>}
            </> : <DropZone multiple onFiles={onFiles}/>}
          </div>
          <div className="monitor-bottom"><span className="truncate">{item ? item.file.name : 'Original footage. No cloud upload.'}</span><span>{item ? fmtDur(item.format.durationSec) : 'Local preview'}</span></div>
        </section>
        <section className="source-section"><div className="section-heading"><h2>Source files <span className="count">{items.length}</span></h2><DropZone multiple compact onFiles={onFiles} busy={phase !== 'idle'}/></div>
          {items.length ? <div className="source-list">{items.map(it => <div key={it.uploadId} className={'source-row' + (it.uploadId === item?.uploadId ? ' selected' : '')}>
            <button className="source-select" onClick={() => select(it.uploadId)} aria-pressed={it.uploadId === item?.uploadId}><span className="source-frame"><Icon name="film"/></span><span className="source-info"><strong>{it.file.name}</strong><span>{it.video.resolution} · {it.video.fps} fps · {it.file.size?.human}</span></span><span className="source-preset">{presets.find(p => p.id === it.preset)?.name}</span></button>
            <button className="icon-button" onClick={() => remove(it.uploadId)} aria-label={'Remove ' + it.file.name}><Icon name="close" size={16}/></button>
          </div>)}</div> : <p className="empty-inline">Add a video to inspect its specs and choose an export.</p>}
        </section>
      </div>
      <aside className="inspector" aria-label="Export settings">
        <div className="inspector-heading"><span className="step-number">01</span><div><h2>Export setup</h2><p>Choose the destination, keep the detail.</p></div></div>
        <div className="inspector-body">
          <label className="field-label" htmlFor="export-preset">Export preset</label><select id="export-preset" value={item?.preset || 'tiktok_1080p60'} disabled={!item} onChange={e => preset(e.target.value)}>
            {[...new Set(presets.map(p => p.group))].map(group => <optgroup key={group} label={group}>{presets.filter(p => p.group === group).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>)}
          </select><p className="field-help">{selectedPreset?.description || 'TikTok and Reels presets prepare a platform-ready file. Master presets keep more of your source.'}</p>
          {items.length > 1 && <button className="text-button" onClick={() => preset(item.preset, true)}>Apply this preset to all {items.length} videos</button>}
          <div className="plan-heading"><span className="step-number">02</span><h3>Before you export</h3></div>
          {item ? <><ErrorBar>{planError}</ErrorBar>{!plan && !planError ? <p role="status" className="muted">Calculating export…</p> : plan && <>
            <table className="plan-table"><thead><tr><th>Spec</th><th>Source</th><th>Export</th></tr></thead><tbody>
              <tr><th>Size</th><td>{item.video.resolution}</td><td>{plan.output.resolution}</td></tr><tr><th>FPS</th><td>{item.video.fps}</td><td>{plan.output.fps}</td></tr><tr><th>Codec</th><td>{item.video.codec?.toUpperCase()}</td><td>{plan.output.codec?.toUpperCase()}</td></tr><tr><th>Color</th><td>{item.video.isHdr ? 'HDR' : 'SDR'}</td><td>{plan.output.color}</td></tr>
            </tbody></table><p className="plan-reason"><Icon name="check" size={16}/><span>{plan.strategy.reason}</span></p>
          </>}</> : <div className="plan-empty"><Icon name="scan" size={24}/><p>Source and export specs will appear here.</p></div>}
          <label className="field-label" htmlFor="encoder">Processing</label><select id="encoder" value={encoder} onChange={e => setEncoder(e.target.value)}><option value="auto">Automatic · GPU when enabled</option><option value="cpu">CPU · software encoding</option></select>
          <div className="destination"><Icon name="folder"/><div><span>Save to</span><strong title={settings?.outDir}>{settings?.outDir || 'Loading output folder'}</strong></div></div>
          <button className="btn primary export-button" disabled={!items.length || phase !== 'idle' || !plan || !!planError} onClick={exportAll}><Icon name="download"/>{phase === 'submitting' ? 'Adding to queue…' : `Export ${items.length || ''} ${items.length === 1 ? 'video' : 'videos'}`}</button>
          <p className="export-note">Platforms apply their own compression. A 4K120 master does not guarantee 4K120 playback online.</p>
        </div>
      </aside>
    </div>
    <Card title="Export queue" right={<span className="muted small">{active.length ? active.length + ' in progress' : 'Ready when you are'}</span>} className="queue-card">
      {!queue.length ? <div className="queue-empty"><Icon name="download"/><div><strong>Your exports will appear here</strong><p>Progress, results and retry controls in one place.</p></div></div> : <>
        {queue.map(job => <QueueRow key={job.id} job={job} action={action}/>)}
        {queue.some(j => !['waiting', 'processing'].includes(j.state)) && <div className="queue-footer"><button className="text-button" onClick={() => action(api.queueClearFinished)}>Clear finished jobs</button></div>}
      </>}
    </Card>
  </div>;
}
function QueueRow({ job, action }) {
  const busy = ['waiting', 'processing'].includes(job.state);
  const kind = job.state === 'completed' ? 'good' : job.state === 'failed' ? 'bad' : job.state === 'cancelled' ? 'warn' : 'info';
  const label = job.state === 'processing' && job.phase === 'validating' ? 'Checking output' : { waiting: 'Queued', processing: 'Exporting', completed: 'Complete', failed: 'Failed', cancelled: 'Cancelled' }[job.state];
  return <div className="queue-row"><div className="queue-row-top"><span className="queue-file-icon"><Icon name={job.state === 'completed' ? 'check' : 'film'}/></span><div className="queue-identity"><strong>{job.sourceName}</strong><span>{job.presetName || 'Preparing export'}{job.accel ? ' · ' + job.accel.toLowerCase() : ''}</span></div><Badge kind={kind}>{label}</Badge>
    <div className="btn-row">{busy ? <button className="btn small-btn" onClick={() => action(() => api.queueCancel(job.id))}>Cancel</button> : <>
      {['failed', 'cancelled'].includes(job.state) && <button className="btn small-btn" onClick={() => action(async () => { const d = await api.queueRetry(job.id); if (!['waiting', 'processing'].includes(d.job?.state)) throw new Error(d.job?.error || 'Cannot retry'); })}>Retry</button>}
      {job.result?.output && <button className="btn small-btn" onClick={() => action(() => api.openFolder(job.result.output.dir))}>Show file</button>}
      <button className="icon-button" aria-label={'Remove job ' + job.sourceName} onClick={() => action(() => api.queueRemove(job.id))}><Icon name="close" size={16}/></button>
    </>}</div></div>
    {job.state === 'processing' && <div className="queue-progress"><progress aria-label={'Export progress for ' + job.sourceName} max="100" value={job.phase === 'validating' ? undefined : job.progress?.pct ?? undefined}/><span>{job.phase === 'validating' ? 'Decoding the output to check for errors' : job.progress?.pct != null ? `${Math.round(job.progress.pct)}% · ${job.progress.speed || 'Calculating speed'}` : 'Preparing media'}</span></div>}
    {job.error && <ErrorBar>{job.error}</ErrorBar>}
    {job.result && <p className="completed-specs">{job.result.afterSpecs?.video.resolution} · {job.result.afterSpecs?.video.fps} fps · {job.result.output.size?.human} · Decode check passed</p>}
    {!!job.logLines?.length && <LogViewer lines={job.logLines}/>}
  </div>;
}
