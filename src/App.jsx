import React from 'react';
import { HashRouter, Routes, Route, NavLink } from 'react-router-dom';
import Optimizer from './pages/Optimizer.jsx';
import Analyzer from './pages/Analyzer.jsx';
import History from './pages/History.jsx';
import Settings from './pages/Settings.jsx';
import Updates from './pages/Updates.jsx';
import { api } from './api';
import { Icon, Dot } from './ui.jsx';

export default function App() {
  const [health, setHealth] = React.useState(null);
  const [update, setUpdate] = React.useState(null);
  React.useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth({ ok: false }));
    const refresh = () => api.updates().then(setUpdate).catch(() => {});
    refresh(); const timer = setInterval(refresh, 15000); return () => clearInterval(timer);
  }, []);
  const links = [['/', 'film', 'Optimizer'], ['/analyzer', 'scan', 'Video Analyzer'], ['/history', 'history', 'History'], ['/settings', 'sliders', 'Settings'], ['/updates', 'download', 'Updates']];
  return <HashRouter><div className="shell">
    <a className="skip-link" href="#main-content">Skip to workspace</a>
    <aside className="sidebar">
      <div className="brand"><span className="wordmark">Forge<span>.</span></span><span>Video export studio</span></div>
      <div className="nav-caption">Workspace</div>
      <nav aria-label="Main navigation">{links.map(([to, icon, label]) => <NavLink key={to} to={to} end={to === '/'}><Icon name={icon}/><span>{label}</span>{to === '/updates' && ['available', 'ready'].includes(update?.phase) && <span className="notification-dot" aria-label="Update available"/>}</NavLink>)}</nav>
      <div className="sidebar-foot"><div className="engine-status"><Dot ok={health?.ffmpegReady}/><span>{!health ? 'Connecting to engine' : health.ffmpegReady ? 'Export engine ready' : 'Engine needs attention'}</span></div><p>Videos stay on this device.</p><span className="version">{update ? 'Version ' + update.currentVersion : 'Checking version'}</span></div>
    </aside>
    <main className="main" id="main-content"><Routes>
      <Route path="/" element={<Optimizer/>}/><Route path="/analyzer" element={<Analyzer/>}/><Route path="/history" element={<History/>}/><Route path="/settings" element={<Settings/>}/><Route path="/updates" element={<Updates/>}/>
    </Routes></main>
  </div></HashRouter>;
}
