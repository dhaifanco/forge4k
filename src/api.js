const j = async (res) => {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('Request failed: ' + res.status));
  return data;
};

export const api = {
  smart: uploadId => fetch('/api/smart',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uploadId})}).then(j),
  recipes: () => fetch('/api/recipes').then(j),
  saveRecipe: value => fetch('/api/recipes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}).then(j),
  deleteRecipe: name => fetch('/api/recipes/'+encodeURIComponent(name),{method:'DELETE'}).then(j),
  queuePause: id => fetch('/api/queue/'+encodeURIComponent(id)+'/pause',{method:'POST'}).then(j),
  queueResume: id => fetch('/api/queue/'+encodeURIComponent(id)+'/resume',{method:'POST'}).then(j),
  compression: id => fetch('/api/queue/'+encodeURIComponent(id)+'/compression',{method:'POST'}).then(j),
  updates: () => fetch('/api/updates').then(j),
  updateAction: (action, body = {}) => fetch('/api/updates/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(j),
  enhancement: () => fetch('/api/enhancement').then(j),
  releaseUpload: id => fetch('/api/uploads/' + encodeURIComponent(id), {method:'DELETE',keepalive:true}).then(j),
  plan: (uploadId, preset, enhance, preview = false) => fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId, preset, enhance, preview }) }).then(j),
  health: () => fetch('/api/health').then(j),
  detect: () => fetch('/api/detect-ffmpeg', { method: 'POST' }).then(j),
  setupFfmpeg: () => fetch('/api/setup-ffmpeg', { method: 'POST' }).then(j),
  presets: () => fetch('/api/presets').then(j),
  analyze: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return fetch('/api/analyze', { method: 'POST', body: fd }).then(j);
  },
  optimize: (uploadId, preset, adv) =>
    fetch('/api/optimize-id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId, preset, adv })
    }).then(j),
  job: (id) => fetch('/api/optimize/' + encodeURIComponent(id)).then(j),
  cancel: (id) => fetch('/api/optimize/' + encodeURIComponent(id) + '/cancel', { method: 'POST' }).then(j),
  gpu: (refresh = false) => fetch('/api/gpu' + (refresh ? '?refresh=1' : '')).then(j),
  gpuStats: () => fetch('/api/gpu/stats').then(j),
  queue: () => fetch('/api/queue').then(j),
  queueJob: (id) => fetch('/api/queue/' + encodeURIComponent(id)).then(j),
  queueCancel: (id) => fetch('/api/queue/' + encodeURIComponent(id) + '/cancel', { method: 'POST' }).then(j),
  queueRetry: (id) => fetch('/api/queue/' + encodeURIComponent(id) + '/retry', { method: 'POST' }).then(j),
  queueRemove: (id) => fetch('/api/queue/' + encodeURIComponent(id), { method: 'DELETE' }).then(j),
  queueClearFinished: () => fetch('/api/queue/clear-finished', { method: 'POST' }).then(j),
  analyzeBatch: (files) => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    return fetch('/api/analyze-batch', { method: 'POST', body: fd }).then(j);
  },
  history: () => fetch('/api/history').then(j),
  deleteHistory: (id) => fetch('/api/history/' + encodeURIComponent(id), { method: 'DELETE' }).then(j),
  clearHistory: () => fetch('/api/history/clear', { method: 'POST' }).then(j),
  settings: () => fetch('/api/settings').then(j),
  saveSettings: (patch) =>
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    }).then(j),
  openFolder: (path) =>
    fetch('/api/open-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path })
    }).then(j)
};

export const fmtBytes = (b) => {
  if (b == null || isNaN(b)) return 'Not available';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = Number(b);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)) + ' ' + units[i];
};

export const fmtDur = (s) => {
  if (s == null || !isFinite(s) || s < 0) return 'Not available';
  const total = Math.round(s), h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
  return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + sec + 's';
};
