import React from 'react';
import { api } from '../api';
import { Card, ErrorBar, Badge, Spec, Icon } from '../ui.jsx';

export default function Settings() {
  const [settings, setSettings] = React.useState(null), [gpu, setGpu] = React.useState(null), [health, setHealth] = React.useState(null);
  const [error, setError] = React.useState(''), [message, setMessage] = React.useState(''), [busy, setBusy] = React.useState(false);
  async function load() {
    try { const [s, h, g] = await Promise.all([api.settings(), api.health(), api.gpu()]); setSettings(s); setHealth(h); setGpu(g); }
    catch (e) { setError(e.message); }
  }
  React.useEffect(() => { load(); }, []);
  async function action(fn, success) { setBusy(true); setError(''); setMessage(''); try { await fn(); await load(); setMessage(success || 'Saved.'); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  function field(key, value) { setSettings(s => ({ ...s, [key]: value })); }
  return <div className="page"><header className="page-head"><div><div className="eyebrow">Make it your workspace</div><h1>Settings</h1><p className="page-sub">Output folders, processing hardware and local storage.</p></div></header><ErrorBar>{error}</ErrorBar>{message && <div className="okbar" role="status">{message}</div>}
    {!settings ? <div className="loading-state" role="status"><span className="spinner"/>Loading preferences</div> : <>
      <div className="grid-2"><Card title="Files and storage"><form className="settings-form" onSubmit={e => { e.preventDefault(); action(() => api.saveSettings({ outDir: settings.outDir, historyLimit: settings.historyLimit }), 'File preferences saved.'); }}>
        <label><span>Export folder</span><input value={settings.outDir} onChange={e => field('outDir', e.target.value)} required/></label>
        <label><span>Keep this many history records</span><input type="number" min="10" max="2000" value={settings.historyLimit} onChange={e => field('historyLimit', Number(e.target.value))}/></label>
        <div className="btn-row"><button className="btn primary" disabled={busy} type="submit">Save preferences</button><button className="btn" type="button" disabled={busy} onClick={() => action(() => api.openFolder(settings.outDir), 'Export folder opened.')}><Icon name="folder" size={17}/>Open export folder</button></div>
      </form><p className="settings-note">History and preferences are stored separately from the application. Installing an update keeps them in place.</p><button className="text-button" disabled={busy} onClick={() => action(() => api.openFolder(settings.dataDir), 'App data folder opened.')}>Open app data folder</button></Card>
      <Card title="Processing hardware"><div className="hardware-heading"><Icon name="chip" size={30}/><div><strong>{gpu?.gpu?.name || 'CPU processing'}</strong><p>{gpu?.gpu?.reason || 'Hardware detection is unavailable'}</p></div></div>
        <div className="spec-grid"><Spec label="H.264 acceleration" value={gpu?.gpu?.nvenc?.h264 ? 'NVIDIA NVENC' : 'CPU'}/><Spec label="HEVC acceleration" value={gpu?.gpu?.nvenc?.hevc ? 'NVIDIA NVENC' : 'CPU'}/><Spec label="Driver" value={gpu?.gpu?.driver}/><Spec label="GPU memory" value={gpu?.stats?.vramTotalMb ? (gpu.stats.vramTotalMb / 1024).toFixed(1) + ' GB' : null}/></div>
        <label className="check"><input type="checkbox" disabled={busy} checked={settings.preferGpu !== false} onChange={e => action(() => api.saveSettings({ preferGpu: e.target.checked }), 'Processing preference saved.')}/>Use NVIDIA GPU when available</label><p className="field-help">CPU encoding is used when a compatible GPU encoder is unavailable. Remux exports do not re-encode the video.</p>
        <button className="btn" disabled={busy} onClick={() => action(() => api.gpu(true), 'Hardware detection refreshed.')}>Refresh hardware</button>
      </Card></div>
      <Card title="Export engine" right={<Badge kind={health?.ffmpegReady ? 'good' : 'warn'}>{health?.ffmpegReady ? 'Ready' : 'Needs attention'}</Badge>}>
        <p className="field-help">The desktop build includes FFmpeg and FFprobe. Custom paths are optional.</p><form className="settings-form" onSubmit={e => { e.preventDefault(); action(() => api.saveSettings({ ffmpegPath: settings.ffmpegPath, ffprobePath: settings.ffprobePath }), 'Engine paths saved.'); }}>
          <div className="grid-2"><label><span>FFmpeg executable</span><input placeholder="Use bundled engine" value={settings.ffmpegPath || ''} onChange={e => field('ffmpegPath', e.target.value)}/></label><label><span>FFprobe executable</span><input placeholder="Use bundled engine" value={settings.ffprobePath || ''} onChange={e => field('ffprobePath', e.target.value)}/></label></div>
          <div className="btn-row"><button className="btn" disabled={busy} type="submit">Save engine paths</button><button className="btn" type="button" disabled={busy} onClick={() => action(api.detect, 'Engine detection complete.')}>Re-detect engine</button></div>
        </form><p className="settings-note">Active engine: {health?.ffmpeg || 'Not found'}</p>
      </Card>
    </>}
  </div>;
}
