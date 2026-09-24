import React from 'react';

export function Icon({ name, size = 20 }) {
  const paths = {
    film: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4m-4 6h4m10-6h4m-4 6h4"/></>,
    scan: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M4 12h16"/></>,
    history: <><path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7M12 7v5l3 2"/></>,
    sliders: <><path d="M4 6h7m4 0h5M4 12h2m4 0h10M4 18h10m4 0h2"/><circle cx="13" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="18" r="2"/></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>,
    upload: <><path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    folder: <path d="M3 7V5h7l2 3h9v12H3V7Z"/>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    play: <path d="m8 4 12 8-12 8V4Z"/>,
    check: <path d="m4 12 5 5L20 6"/>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
    chip: <><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.film}</svg>;
}
export function Card({ title, right, children, className = '' }) { return <section className={'card ' + className}>{(title || right) && <div className="card-head"><h2>{title}</h2>{right}</div>}<div className="card-body">{children}</div></section>; }
export function Spec({ label, value, warn = false, good = false }) { return <div className="spec"><span className="spec-label">{label}</span><span className={'spec-value' + (warn ? ' warn-text' : '') + (good ? ' good-text' : '')}>{value == null || value === '' ? 'Not reported' : value}</span></div>; }
export function Badge({ kind = 'info', children }) { return <span className={'badge badge-' + kind}>{children}</span>; }
export function Dot({ ok, warn }) { return <span className={'dot ' + (ok ? 'dot-ok' : warn ? 'dot-warn' : 'dot-bad')} aria-hidden="true"/>; }
export function ErrorBar({ children }) { return children ? <div className="errorbar" role="alert">{children}</div> : null; }
export function DropZone({ onFile, onFiles, busy, multiple = false, label, sub, compact = false }) {
  const ref = React.useRef(null); const [over, setOver] = React.useState(false);
  function receive(files) { if (busy || !files.length) return; multiple ? onFiles?.(files) : onFile?.(files[0]); }
  return <><input ref={ref} type="file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v" multiple={multiple} hidden onChange={e => { receive(Array.from(e.target.files || [])); e.target.value = ''; }}/>
    <button type="button" disabled={busy} className={compact ? 'btn' : 'dropzone' + (over ? ' over' : '')} onClick={() => ref.current.click()}
      onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); receive(Array.from(e.dataTransfer.files || [])); }}>
      <Icon name={compact ? 'plus' : 'upload'} size={compact ? 18 : 30}/><span className="dz-label">{busy ? 'Reading your videos…' : label || (compact ? 'Add videos' : 'Drop your videos here')}</span>{!compact && <><span className="dz-sub">{sub || 'or click to choose files from your computer'}</span><span className="file-types">MP4 · MOV · M4V</span></>}
    </button></>;
}
export function LogViewer({ lines = [], title = 'Processing details' }) {
  return <details className="logviewer"><summary>{title} <span className="muted">({lines.length} lines)</span></summary><pre className="log-box">{lines.join('\n') || 'No log output yet.'}</pre></details>;
}
export function ProgressPanel({ progress, onCancel }) {
  const pct = progress?.pct;
  return <div><progress max="100" value={pct == null ? undefined : pct} aria-label="Export progress"/><div className="progress-stats"><span>{pct == null ? 'Preparing export' : Math.round(pct) + '%'}</span><span>{progress?.speed ? progress.speed + ' speed' : 'Calculating speed'}</span></div>{onCancel && <button className="btn" onClick={onCancel}>Cancel export</button>}</div>;
}
