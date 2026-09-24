import React from 'react';
import { api, fmtBytes } from '../api';
import { Card, ErrorBar, Badge, Icon } from '../ui.jsx';

export default function Updates() {
  const [state, setState] = React.useState(null), [error, setError] = React.useState(''), [working, setWorking] = React.useState(false);
  const [url, setUrl] = React.useState(''), [auto, setAuto] = React.useState(true), [saved, setSaved] = React.useState(false);
  React.useEffect(() => {
    let stop = false;
    api.updates().then(d => { if (!stop) { setState(d); setUrl(d.feedUrl || ''); setAuto(d.checkOnStart !== false); } }).catch(e => setError(e.message));
    const timer = setInterval(() => api.updates().then(d => { if (!stop) setState(d); }).catch(() => {}), 1000);
    return () => { stop = true; clearInterval(timer); };
  }, []);
  async function run(action, body) { setWorking(true); setError(''); setSaved(false); try { setState(await api.updateAction(action, body)); if (action === 'save') setSaved(true); } catch (e) { setError(e.message); } finally { setWorking(false); } }
  const busy = working || ['checking', 'downloading', 'verifying', 'installing'].includes(state?.phase);
  const labels = { idle: 'Ready to check', checking: 'Checking GitHub Releases', available: 'A new version is available', downloading: 'Downloading your update', verifying: 'Verifying update files', ready: 'Ready to install', current: 'You are up to date', error: 'Update needs attention', installing: 'Opening the installer' };
  return <div className="page"><header className="page-head"><div><div className="eyebrow">Keep your studio current</div><h1>Updates</h1><p className="page-sub">New versions, on your schedule. Your videos and settings stay yours.</p></div></header>
    <ErrorBar>{error || state?.error}</ErrorBar>
    {!state ? <div className="loading-state" role="status"><span className="spinner"/>Loading update settings</div> : <>
      {!state.desktop && <div className="notice">Open the Forge desktop application to download or install updates.</div>}
      <section className="update-overview"><div className="update-emblem"><Icon name="download" size={32}/></div><div><Badge kind={state.phase === 'ready' ? 'good' : 'info'}>Installed version {state.currentVersion}</Badge><h2>{labels[state.phase] || 'Updates'}</h2><p>{state.checkedAt ? 'Last checked ' + new Date(state.checkedAt).toLocaleString() : 'Checks only contact your configured release source.'}</p></div><button className="btn primary" disabled={busy || !state.desktop || !state.feedUrl} onClick={() => run('check')}>{state.phase === 'checking' ? 'Checking…' : 'Check for updates'}</button></section>
      {state.release?.newer && <Card title={'Forge ' + state.release.version} right={<span className="muted">{fmtBytes(state.release.size)}</span>}><p className="release-notes">{state.release.notes || 'No release notes provided.'}</p>
        {state.phase === 'downloading' && <div className="download-progress"><progress max="100" value={state.progress} aria-label="Update download progress"/><span>{state.progress}% downloaded</span><button className="btn" onClick={() => api.updateAction('cancelDownload').catch(e => setError(e.message))}>Cancel download</button></div>}
        <div className="btn-row">{state.phase === 'available' && <button className="btn primary" disabled={busy} onClick={() => run('download')}>Download update</button>}{state.phase === 'ready' && <button className="btn primary" disabled={busy} onClick={() => run('install')}>Close Forge and install</button>}</div>
        <p className="field-help">Finish exports before installing. The Windows installer will guide you through the update.{state.portable ? ' This installs the new version on this PC; your older portable file is kept.' : ''}</p>
      </Card>}
      <div className="grid-2"><Card title="GitHub release channel"><label className="field-label" htmlFor="feed-url">Release manifest URL</label><input id="feed-url" type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://github.com/owner/repo/releases/latest/download/forge-update.json"/><p className="field-help">Everyone using this channel sees the same published releases.</p><label className="check"><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)}/>Check when Forge opens</label><button className="btn" disabled={busy || !state.desktop} onClick={() => run('save', { feedUrl: url, checkOnStart: auto })}>Save update settings</button>{saved && <p className="good-text" role="status">Update settings saved.</p>}</Card>
        <Card title="Update from a file"><div className="offline-copy"><Icon name="folder" size={28}/><h3>Bring the update with you</h3><p>Keep <strong>forge-update.json</strong> and its matching Forge installer in the same folder. Choose the manifest to verify and prepare the update.</p></div><button className="btn" disabled={busy || !state.desktop} onClick={() => run('importFile')}>Choose update file</button><p className="field-help">Works offline. Publisher signature and installer integrity are checked before installation.</p></Card></div>
    </>}
  </div>;
}
