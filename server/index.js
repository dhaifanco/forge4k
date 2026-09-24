'use strict';
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');
const store = require('./store');
const ff = require('./ffmpeg');
const gpu = require('./gpu');
const enhance = require('./enhance');
const studio = require('./studio');
const presets = require('./presets');
const queue = require('./queue');
const { listPresets, decideStrategy, buildArgs, PRESETS, recommendPreset, pickEncoder } = presets;

const app = express();
function route(method, url, ...handlers) {
  app[method](url, ...handlers.map(handler => (req, res, next) => {
    try { Promise.resolve(handler(req, res, next)).catch(next); } catch(error) { next(error); }
  }));
}
app.use((req, res, next) => {
  if (process.env.FORGE_API_TOKEN) {
    const supplied = Buffer.from(String(req.headers['x-forge-token'] || ''));
    const expected = Buffer.from(process.env.FORGE_API_TOKEN);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return res.status(403).json({ error: 'Desktop session required' });
  }
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: '1mb' }));
const uploads = new Map();

const JOBS = queue.JOBS; // V1 job map preserved (same objects the queue manages)
app.get('/api/updates', (req, res) => res.json(app.locals.updater ? app.locals.updater.snapshot() : { desktop: false, currentVersion: require('../package.json').version, phase: 'idle', feedUrl: '' }));
for (const action of ['check', 'download', 'cancelDownload', 'importFile', 'install', 'save']) {
  app.post('/api/updates/' + action, async (req, res) => {
    if (!app.locals.updater) return res.status(400).json({ error: 'Open the desktop application to manage updates.' });
    try { res.json(await app.locals.updater[action](req.body || {})); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
}
app.get('/api/enhancement', (_req, res) => res.json(enhance.status()));
app.get('/api/recipes',(_req,res)=>res.json({items:studio.recipes()}));
route('post','/api/recipes',(req,res)=>res.json({items:studio.saveRecipe(req.body)}));
route('delete','/api/recipes/:name',(req,res)=>res.json({items:studio.deleteRecipe(req.params.name)}));
function stagedPath(id) {
  if(!/^[a-f0-9]{32}(\.[a-z0-9]+)?$/.test(id||''))throw new Error('Import a source video first.');
  const file=path.join(store.UPLOADS_DIR,id);if(!fs.existsSync(file))throw new Error('Source is no longer staged.');return file;
}
route('post','/api/smart',async(req,res)=>{
  const file=stagedPath(req.body.uploadId),raw=await ff.probe(file);
  if(!raw.ok)throw new Error('Could not read source.');
  res.json(await studio.smart(file,ff.normalizeProbe(raw.data,file)));
});
route('get','/api/uploads/:id/video',(req,res)=>res.sendFile(path.resolve(stagedPath(req.params.id))));
route('post','/api/queue/:id/pause',(req,res)=>res.json({ok:studio && queue.pause(req.params.id)}));
route('post','/api/queue/:id/resume',(req,res)=>res.json({ok:queue.resume(req.params.id)}));
route('post','/api/queue/:id/compression',async(req,res)=>{
  const job=queue.getJob(req.params.id);
  if(job?.state!=='completed'||!job.result?.preview)throw new Error('Render a sample first.');
  if(job.compressionBusy)return res.status(409).json({error:'Compression preview is already rendering.'});
  job.compressionBusy=true;
  try{
    const bins=await ff.locateBinaries(),output=job.result.output.path+'.compression.mp4';
    const result=await ff.runBin(bins.ffmpegPath,['-hide_banner','-nostdin','-y','-i',job.result.output.path,'-t','5','-vf','scale=w=720:h=1280:force_original_aspect_ratio=decrease:force_divisible_by=2','-c:v','libx264','-crf','32','-maxrate','1500k','-bufsize','3000k','-c:a','aac','-b:a','96k','-movflags','+faststart',output],{timeoutMs:120000});
    if(result.code!==0)throw new Error('Could not render compression preview.');
    job.compressionPath=output;res.json({url:'/api/queue/'+job.id+'/compression'});
  }finally{job.compressionBusy=false;}
});
route('get','/api/queue/:id/compression',(req,res)=>{const job=queue.getJob(req.params.id);if(!job?.compressionPath||!fs.existsSync(job.compressionPath))return res.status(404).json({error:'Preview not found.'});res.sendFile(path.resolve(job.compressionPath));});
app.delete('/api/uploads/:id', (req,res) => {
  const id=req.params.id;
  if(!/^[a-f0-9]{32}(\.[a-z0-9]+)?$/.test(id)) return res.status(400).json({error:'Invalid staged video.'});
  const input=path.join(store.UPLOADS_DIR,id);
  const owners=[...queue.JOBS.values()].filter(j=>j._payload?.inputPath===input);
  if(owners.length) { for(const job of owners) job._payload.keepInput=false; }
  else if(fs.existsSync(input)) fs.unlinkSync(input);
  uploads.delete(id); res.json({ok:true,retainedByQueue:owners.length>0});
});
app.get('/api/queue/:id/video', (req, res) => {
  const job = queue.getJob(req.params.id);
  if (job?.state !== 'completed' || !job.result?.output || !fs.existsSync(job.result.output.path)) return res.status(404).json({ error: 'Completed video not found.' });
  res.sendFile(path.resolve(job.result.output.path));
});
route('post', '/api/plan', async (req, res) => {
  try {
    const id = String(req.body.uploadId || '');
    if (!/^[a-f0-9]{32}(\.[a-z0-9]+)?$/.test(id)) throw new Error('Import a source video first.');
    const input = path.join(store.UPLOADS_DIR, id);
    const raw = await ff.probe(input);
    if (!raw.ok) throw new Error(raw.error);
    const probe = ff.normalizeProbe(raw.data, input);
    const preset = PRESETS[req.body.preset];
    if (!preset) throw new Error('Choose an export preset.');
    if (enhance.options(req.body.enhance).enabled) {
      const plan = enhance.plan(probe, preset, req.body.enhance, req.body.preview);
      return res.json({ strategy: { reencode: true, reencodeVideo: true, reason: plan.reason }, enhancement: plan,
        output: { resolution: plan.width + 'x' + plan.height, fps: plan.fps, codec: plan.codec, color: plan.color } });
    }
    const strategy = preset.mode==='remux'?decideStrategy(probe,preset):{reencode:true,reencodeVideo:true,reencodeAudio:true,reason:'Encode independently playable sections for resumable export.'};
    const target = preset.target || {};
    const geometry = presets.geometry(probe.video, target);
    const copy = !strategy.reencodeVideo;
    res.json({ strategy, output: { resolution: copy ? probe.video.resolution : geometry.width + 'x' + geometry.height,
      fps: copy ? probe.video.fps : Math.min(probe.video.fps, target.maxFps || Infinity),
      codec: copy ? probe.video.codec : target.vcodec,
      color: copy ? (probe.video.isHdr ? 'HDR preserved' : 'SDR') : target.color === 'sdr' ? 'BT.709 SDR' : probe.video.isHdr ? 'HDR preserved' : 'SDR' } });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

// ---------- health / binaries ----------
route('get', '/api/health', async (req, res) => {
  const bins = await ff.locateBinaries();
  res.json({
    ok: true,
    ffmpegReady: bins.ok,
    ffmpeg: bins.ffmpegPathDisplay || bins.ffmpegPath,
    ffprobe: bins.ffprobePathDisplay || bins.ffprobePath,
    usingPath: Boolean(bins.ffmpegPathIsPath),
    outDir: store.getSettings().outDir,
    platform: process.platform
  });
});

route('post', '/api/detect-ffmpeg', async (req, res) => {
  ff.clearBinCache();
  const bins = await ff.locateBinaries();
  res.json({ ok: bins.ok, ffmpeg: bins.ffmpegPath, ffprobe: bins.ffprobePath });
});

// One-click Windows setup: download gyan.dev essentials build, extract with tar, register in settings.
route('post', '/api/setup-ffmpeg', async (req, res) => {
  if (process.platform !== 'win32') return res.status(400).json({ error: 'Automatic setup is Windows-only; install ffmpeg with your package manager.' });
  const installDir = path.join(process.env.LOCALAPPDATA || store.DATA_DIR, 'ffmpeg');
  const url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
  const zipPath = path.join(store.DATA_DIR, 'ffmpeg-setup.zip');
  const https = require('https');
  const { pipeline } = require('stream');
  const follow = (u, cb) => {
    https.get(u, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return follow(r.headers.location, cb);
      if (r.statusCode !== 200) return cb(new Error('Download failed: HTTP ' + r.statusCode));
      cb(null, r);
    }).on('error', cb);
  };
  try {
    store.ensureDir(store.DATA_DIR);
    await new Promise((resolve, reject) => {
      follow(url, (err, stream) => {
        if (err) return reject(err);
        const out = fs.createWriteStream(zipPath);
        pipeline(stream, out, (e) => (e ? reject(e) : resolve()));
      });
    });
    fs.mkdirSync(installDir, { recursive: true });
    // Windows tar: System32\\tar.exe (bsdtar) handles zip; but a git-bash GNU tar
    // earlier in PATH would shadow it and fail. Prefer System32, fall back to PowerShell.
    const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const ex = await new Promise((resolve) => {
      const { spawn } = require('child_process');
      const useTar = fs.existsSync(systemTar);
      const p = useTar
        ? spawn(systemTar, ['-xf', zipPath, '-C', installDir], { windowsHide: true })
        : spawn('powershell', ['-NoProfile', '-Command', 'Expand-Archive -Force -Path "' + zipPath + '" -DestinationPath "' + installDir + '"'], { windowsHide: true });
      let errOut = '';
      p.stderr.on('data', (d) => { errOut += d; });
      p.on('close', (code) => resolve({ code, errOut }));
      p.on('error', (e) => resolve({ code: -1, errOut: String(e) }));
    });
    try { fs.unlinkSync(zipPath); } catch (e) {}
    if (ex.code !== 0) return res.status(500).json({ error: 'Extraction failed: ' + (ex.errOut || 'tar exit ' + ex.code) });
    // find the bin dir
    let binDir = null;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name === 'bin' && fs.existsSync(path.join(full, 'ffmpeg.exe'))) { binDir = full; return; } walk(full); if (binDir) return; }
      }
    };
    walk(installDir);
    if (!binDir) return res.status(500).json({ error: 'Extracted but ffmpeg.exe not found under ' + installDir });
    store.saveSettings({ ffmpegPath: path.join(binDir, 'ffmpeg.exe'), ffprobePath: path.join(binDir, 'ffprobe.exe') });
    ff.clearBinCache();
    gpu.clearGpuCache();
    const bins = await ff.locateBinaries();
    res.json({ ok: bins.ok, ffmpeg: bins.ffmpegPath, ffprobe: bins.ffprobePath, binDir });
  } catch (e) {
    try { fs.unlinkSync(zipPath); } catch (e2) {}
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- GPU (V2) ----------
route('get', '/api/gpu', async (req, res) => {
  const bins = await ff.locateBinaries();
  const force = req.query.refresh === '1';
  const info = await gpu.detectGpu(bins.ffmpegPath, force);
  const stats = info.available ? await gpu.gpuStats() : null;
  res.json({ gpu: info, stats });
});

route('get', '/api/gpu/stats', async (req, res) => {
  const stats = await gpu.gpuStats();
  res.json({ stats });
});

// ---------- presets ----------
app.get('/api/presets', (req, res) => res.json({ presets: listPresets() }));

// ---------- analyze ----------
const upload = multer({ dest: store.UPLOADS_DIR });

route('post', '/api/analyze', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  // multer stages uploads extension-less; restore the original extension so
  // container detection (and humans) can tell MOV from MP4 downstream
  const origExt = (path.extname(req.file.originalname || '') || '').toLowerCase();
  if (origExt && ['.mp4', '.mov', '.m4v'].includes(origExt)) {
    const newPath = req.file.path + origExt;
    try { fs.renameSync(req.file.path, newPath); req.file.path = newPath; } catch (e) {}
  }
  const raw = await ff.probe(req.file.path);
  if (!raw.ok) {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    return res.status(422).json({ error: raw.error || 'Could not read this file with ffprobe' });
  }
  const p = ff.normalizeProbe(raw.data, req.file.path);
  if (!p.video.width || !p.video.height) { fs.unlinkSync(req.file.path); return res.status(422).json({error:'The input has no usable video stream.'}); }
  p.health = ff.assessHealth(p);
  const bins = await ff.locateBinaries();
  const gpuInfo = await gpu.detectGpu(bins.ffmpegPath);
  p.recommendation = recommendPreset(p, gpuInfo);
  p.uploadId = path.basename(req.file.path); // temp copy reused by /api/optimize-id
  p.file.name = req.file.originalname;
  uploads.set(p.uploadId, req.file.originalname);
  res.json(p);
});

route('post', '/api/analyze-path', async (req, res) => {
  const p = String((req.body || {}).path || '');
  if (!p || !fs.existsSync(p)) return res.status(400).json({ error: 'Path not found: ' + p });
  const raw = await ff.probe(p);
  if (!raw.ok) return res.status(422).json({ error: raw.error || 'Could not read this file' });
  const norm = ff.normalizeProbe(raw.data, p);
  norm.health = ff.assessHealth(norm);
  const bins = await ff.locateBinaries();
  const gpuInfo = await gpu.detectGpu(bins.ffmpegPath);
  norm.recommendation = recommendPreset(norm, gpuInfo);
  res.json(norm);
});

// ---------- optimize (V1 API preserved; V2 routes through the batch queue) ----------
// Two entry points: /api/optimize (multipart upload) and /api/optimize-id (reuse analyze temp file).
route('post', '/api/optimize', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  await startJob(req.file.path, req.body || {}, req.file.originalname || null, res);
});

route('post', '/api/optimize-id', async (req, res) => {
  const body = req.body || {};
  const id = String(body.uploadId || '');
  if (!/^[a-f0-9]{32}(\.[a-z0-9]+)?$/.test(id)) return res.status(400).json({error:'Import a source video first.'});
  const inputPath = path.join(store.UPLOADS_DIR, path.basename(id));
  if (!id || !fs.existsSync(inputPath)) return res.status(400).json({ error: 'Analyzed file no longer staged — drop the file again.' });
  await startJob(inputPath, body, uploads.get(id), res);
});

async function startJob(inputPath, body, originalName, res) {
  try {
    const presetId = String(body.preset || 'remux');
    let adv = {};
    try { adv = typeof body.adv === 'string' ? JSON.parse(body.adv) : (body.adv || {}); } catch (e) {}

    const bins = await ff.locateBinaries();
    if (!bins.ok) {
      try { fs.unlinkSync(inputPath); } catch (e) {}
      return res.status(400).json({ error: 'FFmpeg not found — run setup in Settings first.' });
    }
    const pr = await ff.probe(inputPath);
    if (!pr.ok) {
      try { fs.unlinkSync(inputPath); } catch (e) {}
      return res.status(422).json({ error: 'Could not read source: ' + pr.error });
    }
    const before = ff.normalizeProbe(pr.data, inputPath);

    // Preview payload (V1 shape) so the UI can show the plan instantly; the
    // queue re-derives everything when the job actually runs.
    const presetDef = PRESETS[presetId];
    if (!presetDef) return res.status(400).json({ error: 'Unknown export preset' });
    const gpuInfo = await gpu.detectGpu(bins.ffmpegPath);
    const settings = store.getSettings();
    const useGpu = settings.preferGpu !== false && adv.encoder !== 'cpu';
    const aiPlan = enhance.options(adv.enhance).enabled ? enhance.plan(before, presetDef, adv.enhance, adv.preview) : null;
    if (adv.preview && presetId==='remux') throw new Error('Choose a social or master preset to render a sample.');
    const strategy = aiPlan ? { reencode: true, reencodeVideo: true, reencodeAudio: true, reason: aiPlan.reason } : presetDef.mode==='remux'?decideStrategy(before,presetDef,adv):{reencode:true,reencodeVideo:true,reencodeAudio:true,reason:'Encode independently playable sections for resumable export.'};
    const advPreview = Object.assign({}, adv, presetDef.target ? { target: presetDef.target } : {}, { gpu: useGpu ? gpuInfo : null });
    const argsPreview = buildArgs({
      input: inputPath,
      output: path.join(store.getSettings().tempDirEffective, 'plan-preview.mp4'),
      probe: before, strategy, adv: advPreview
    });
    // Label must respect the same useGpu gate as the real args — never pass the raw
    // detection here, or preferGpu=false would still advertise "GPU ENCODE" (BUG-2).
    const enc = strategy.reencode && strategy.reencodeVideo ? pickEncoder({ probe: before, adv: advPreview, gpu: useGpu ? gpuInfo : null }) : null;
    const accelLabel = !strategy.reencode ? 'LOSSLESS REMUX' : (enc ? (enc.accel === 'gpu' ? 'GPU ENCODE' : 'CPU ENCODE') : 'LOSSLESS REMUX (audio only)');
    const outDir = adv.outDir || settings.outDir;

    const snap = queue.enqueue({
      inputPath,
      sourceName: originalName || before.file.name,
      presetId: presetDef.id,
      adv,
      sourcePath: inputPath,
      keepInput: !!adv.preview || !!adv.keepSource
    });

    res.json({
      jobId: snap.id,
      queueState: snap.state,
      strategy,
      accel: accelLabel,
      encoder: enc ? enc.encoder : 'stream copy',
      args: argsPreview.map((a) => String(a).replace(/\{jobid\}/g, snap.id)),
      before,
      output: { dir: outDir, name: null, pending: true },
      preset: { id: presetDef.id, name: presetDef.name }
    });

    setImmediate(() => queue.pump());
  } catch (e) {
    if (!res.headersSent) res.status(e.status || 400).json({ error: String(e.message || e) });
  }
}

// ---------- queue (V2) ----------
app.get('/api/queue', (req, res) => res.json({ items: queue.listJobs() }));

app.get('/api/queue/:id', (req, res) => {
  const j = queue.getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'Unknown job' });
  res.json(queue.listJobs().find((x) => x.id === req.params.id) || { error: 'Unknown job' });
});

app.post('/api/queue/:id/cancel', (req, res) => {
  const ok = queue.cancel(req.params.id);
  if (!ok) return res.status(400).json({ error: 'Job is not running or queued' });
  res.json({ ok: true });
});

app.post('/api/queue/:id/retry', (req, res) => {
  const j = queue.retry(req.params.id);
  if (!j) return res.status(404).json({ error: 'Unknown job' });
  res.json({ ok: true, job: j });
});

app.delete('/api/queue/:id', (req, res) => {
  const ok = queue.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Unknown job' });
  res.json({ ok: true });
});

app.post('/api/queue/clear-finished', (req, res) => {
  for (const j of queue.listJobs()) {
    if (['completed', 'failed', 'cancelled'].includes(j.state)) queue.remove(j.id);
  }
  res.json({ ok: true });
});

// V1 job endpoints — same shapes, now backed by the queue
app.get('/api/optimize/:id', (req, res) => {
  const job = JOBS.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown job' });
  const { child, _payload, ...safe } = job;
  res.json(safe);
});

app.post('/api/optimize/:id/cancel', (req, res) => {
  const job = JOBS.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown job' });
  const ok = queue.cancel(req.params.id);
  res.json({ ok: true, state: ok ? 'cancelling' : job.state });
});

// ---------- batch analyze (V2) ----------
route('post', '/api/analyze-batch', upload.array('files', 30), async (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files received' });
  const bins = await ff.locateBinaries();
  const gpuInfo = await gpu.detectGpu(bins.ffmpegPath);
  const results = [];
  for (const f of req.files) {
    const origExt = (path.extname(f.originalname || '') || '').toLowerCase();
    if (origExt && ['.mp4', '.mov', '.m4v'].includes(origExt)) {
      try { fs.renameSync(f.path, f.path + origExt); f.path = f.path + origExt; } catch (e) {}
    }
    const raw = await ff.probe(f.path);
    if (!raw.ok) {
      try { fs.unlinkSync(f.path); } catch (e) {}
      results.push({ name: f.originalname, ok: false, error: raw.error || 'Could not read this file with ffprobe' });
      continue;
    }
    const p = ff.normalizeProbe(raw.data, f.path);
    if (!p.video.width || !p.video.height) { fs.unlinkSync(f.path); results.push({name:f.originalname,ok:false,error:'The input has no usable video stream.'}); continue; }
    p.health = ff.assessHealth(p);
    p.recommendation = recommendPreset(p, gpuInfo);
    p.uploadId = path.basename(f.path);
    p.file.name = f.originalname;
    uploads.set(p.uploadId, f.originalname);
    results.push(p);
  }
  res.json({ items: results });
});

// ---------- history ----------
app.get('/api/history', (req, res) => {
  const list = store.getHistory();
  res.json({ items: list.slice().reverse() });
});

app.delete('/api/history/:id', (req, res) => {
  store.removeHistory(req.params.id);
  res.json({ ok: true });
});

app.post('/api/history/clear', (req, res) => {
  store.clearHistory();
  res.json({ ok: true });
});

// ---------- settings ----------
app.get('/api/settings', (req, res) => {
  res.json({ ...store.getSettings(), dataDir: store.DATA_DIR });
});

route('post', '/api/settings', async (req, res) => {
  const patch = req.body || {};
  const clean = {};
  if (typeof patch.ffmpegPath === 'string') clean.ffmpegPath = patch.ffmpegPath.trim();
  if (typeof patch.ffprobePath === 'string') clean.ffprobePath = patch.ffprobePath.trim();
  if (typeof patch.outDir === 'string' && patch.outDir.trim()) clean.outDir = path.normalize(patch.outDir.trim());
  if (patch.historyLimit != null) clean.historyLimit = Math.max(10, Math.min(2000, Number(patch.historyLimit) || 200));
  if (patch.preferGpu != null) clean.preferGpu = Boolean(patch.preferGpu);
  if (typeof patch.tempDir === 'string') clean.tempDir = patch.tempDir.trim();
  store.saveSettings(clean);
  ff.clearBinCache();
  gpu.clearGpuCache();
  const bins = await ff.locateBinaries();
  res.json({ ok: true, settings: store.getSettings(), ffmpegReady: bins.ok });
});

route('post', '/api/open-folder', async (req, res) => {
  const dir = String((req.body || {}).path || store.getSettings().outDir);
  if (!fs.existsSync(dir)) return res.status(400).json({ error: 'Folder does not exist' });
  if (process.versions.electron) { const error = await require('electron').shell.openPath(dir); if(error) throw new Error(error); }
  else execFile(process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open', [dir], { windowsHide: true }, () => {});
  res.json({ ok: true });
});

// ---------- static frontend (production build) ----------
const DIST = path.join(__dirname, '..', 'dist');
app.use(express.static(DIST));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(DIST, 'index.html'));
});
app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  for(const file of _req.files || (_req.file ? [_req.file] : [])) {
    if(path.dirname(path.resolve(file.path))!==path.resolve(store.UPLOADS_DIR)) continue;
    if([...queue.JOBS.values()].some(job=>job._payload?.inputPath===file.path)) continue;
    try{fs.unlinkSync(file.path);}catch{} uploads.delete(path.basename(file.path));
  }
  res.status(error.status || (error instanceof multer.MulterError ? 400 : 500)).json({error:error.message || 'Request failed.'});
});

function startServer(port = Number(process.env.PORT || 5177)) {
store.ensureDir(store.UPLOADS_DIR);
// V2: temp dir outside OneDrive; clean stale files older than 24h at boot
store.ensureDir(store.getSettings().tempDirEffective);
try { store.cleanTempDir(24 * 3600 * 1000); } catch (e) {}
// stale staged uploads (failed/cancelled jobs never removed) get the same 24h rule
queue.restore();

return new Promise((resolve, reject) => {
  const server = app.listen(port, '127.0.0.1', () => resolve(server));
  server.on('error', reject);
});
}
module.exports = { app, startServer };
if (require.main === module) startServer().then(server => console.log('[forge] http://127.0.0.1:' + server.address().port)).catch(console.error);
