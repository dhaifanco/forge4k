'use strict';
// V2 batch queue: sequential job runner with statuses, retry, remove, cancel.
// Keeps the V1 single-job API intact (JOBS map + /api/optimize/:id polling).

const fs = require('fs');
const path = require('path');
const store = require('./store');
const ff = require('./ffmpeg');
const presetsMod = require('./presets');
const gpuMod = require('./gpu');
const enhance = require('./enhance');
const studio = require('./studio');
const { PRESETS, decideStrategy, buildArgs } = presetsMod;

// Single source of truth for job records. V1 /api/optimize writes here too.
const JOBS = new Map();
const QUEUE = [];           // ordered job ids
let running = false;
let stopping = false;
let gpuCache = null;        // refreshed before each job

const MAX_DONE_JOBS = 60;

function newId(prefix) {
  return (prefix || 'job') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function jobSnapshot(j) {
  // strip non-serializable fields for API responses
  const { child, _payload, ...safe } = j;
  return safe;
}

function getJob(id) { return JOBS.get(id); }

function listJobs() {
  // QUEUE holds every job (running/finished stay until removed by the user or
  // pruned); jobs whose record vanished are skipped defensively.
  return QUEUE.map((id) => JOBS.get(id)).filter(Boolean).map(jobSnapshot);
}

// enqueue(payload): { inputPath, sourceName, presetId, adv, sourcePath (original), keepInput }
function enqueue(payload) {
  const duplicate = [...JOBS.values()].find(j => j._payload?.inputPath === payload.inputPath && (j.presetId||'remux') === (payload.presetId||'remux') && ['waiting', 'processing','paused'].includes(j.state));
  if (duplicate) { const error = new Error('This source already has an active export. Wait for it to finish or cancel it.'); error.status=409; throw error; }
  const id = newId('job');
  const job = {
    id,
    state: 'waiting',           // waiting | processing | completed | failed | cancelled
    status: 'waiting',          // alias used by V1 UI
    presetId: payload.presetId || 'remux',
    sourceName: payload.sourceName || path.basename(payload.inputPath),
    sourcePath: payload.sourcePath || payload.inputPath,
    createdAt: new Date().toISOString(),
    progress: null,
    logLines: [],
    cancelRequested: false,
    _payload: payload
  };
  JOBS.set(id, job);
  QUEUE.push(id);
  prune();
  persist();
  setImmediate(pump);
  return jobSnapshot(job);
}

function remove(id) {
  const j = JOBS.get(id);
  if (!j) return false;
  if (j.state === 'processing') {
    j.cancelRequested = true;
    if (j.child) { try { j.child.kill('SIGKILL'); } catch (e) {} }
    j._removeAfterCancel = true;
    return true;
  }
  // Reclaim the staged input of a never-finished job (cancelled/failed jobs keep their
  // input alive for Retry — deleting the job must not leak it in data/uploads).
  releaseInput(j);
  studio.discard(j);
  if(j.compressionPath && j.result?.output?.path && j.compressionPath===j.result.output.path+'.compression.mp4'){try{fs.unlinkSync(j.compressionPath);}catch{}}
  const qi = QUEUE.indexOf(id);
  if (qi >= 0) QUEUE.splice(qi, 1);
  JOBS.delete(id);
  persist();
  return true;
}

function retry(id) {
  const j = JOBS.get(id);
  if (!j) return null;
  if (!['failed','cancelled'].includes(j.state)) return jobSnapshot(j);
  // re-enqueue a fresh job with the same payload
  if (!j._payload || !fs.existsSync(j._payload.inputPath)) {
    j.error = 'Cannot retry — source file no longer staged. Drop the file again.';
    return jobSnapshot(j);
  }
  const payload = j._payload;
  const result=enqueue(payload);
  studio.discard(j);
  j._payload = null;
  persist();
  return result;
}

function cancel(id) {
  const j = JOBS.get(id);
  if (!j) return false;
  if (j.state === 'waiting' || j.state==='paused') {
    j.state = 'cancelled'; j.status = 'cancelled';
    j.error = 'Cancelled before start';
    j.finishedAt = new Date().toISOString();
    persist();
  studio.discard(j);
    // Keep the id in QUEUE so the job still shows up in /api/queue as Cancelled —
    // splicing it out orphans the record (in JOBS but invisible in listJobs).
    setImmediate(pump);
    return true;
  }
  if (j.state === 'processing') {
    j.cancelRequested = true;
    if (j.child) { try { j.child.kill('SIGKILL'); } catch (e) {} }
    return true;
  }
  return false;
}

function pause(id) {
  const j=JOBS.get(id);if(!j||!['waiting','processing'].includes(j.state))return false;
  if(j.presetId==='remux')throw new Error('Lossless copy cannot pause; it can be cancelled.');
  j.pauseRequested=true;
  if(j.state==='waiting'){j.state='paused';j.status='paused';}
  persist();return true;
}
function resume(id) {
  const j=JOBS.get(id);if(!j||j.state!=='paused')return false;
  j.pauseRequested=false;j.cancelRequested=false;j.error=null;j.state='waiting';j.status='waiting';persist();setImmediate(pump);return true;
}

function cancelAll() {
  for (const id of [...QUEUE]) cancel(id);
}

async function pump() {
  if (running || stopping) return;
  const nextId = QUEUE.find((id) => JOBS.get(id) && JOBS.get(id).state === 'waiting');
  if (!nextId) { running = false; return; }
  running = true;
  const job = JOBS.get(nextId);
  job.state = 'processing'; job.status = 'processing';
  job.startedAt = new Date().toISOString();
  try {
    await runJob(job);
  } catch (e) {
    job.state = job.pauseRequested ? 'paused' : job.cancelRequested ? 'cancelled' : 'failed'; job.status = job.state;
    job.error = String(e.message || e);
    cleanupJobFiles(job, false);
    if(job.state==='cancelled')studio.discard(job);
  }
  job.finishedAt = new Date().toISOString();
  if (job._removeAfterCancel) { remove(nextId); }
  prune();
  persist();
  running = false;
  setImmediate(pump);
}

function prune() {
  // keep memory bounded: only finished jobs past MAX_DONE_JOBS are dropped
  // (and pruned records are also taken out of QUEUE so listJobs stays clean)
  const done = [...JOBS.entries()].filter(([, j]) => ['completed', 'failed', 'cancelled'].includes(j.state));
  done.sort((a, b) => String(a[1].finishedAt || '').localeCompare(String(b[1].finishedAt || '')));
  while (done.length > MAX_DONE_JOBS) {
    const [id] = done.shift();
    remove(id);
  }
}

async function currentGpu(force) {
  if (!gpuCache || force || (Date.now() - gpuCache.checkedAt) > 60000) {
    const bins = await ff.locateBinaries();
    gpuCache = await gpuMod.detectGpu(bins.ffmpegPath, force);
  }
  return gpuCache;
}

async function runJob(job) {
  const payload = job._payload;
  const { inputPath, presetId, adv } = payload;
  const settings = store.getSettings();
  let advUser = {};
  try { advUser = typeof adv === 'string' ? JSON.parse(adv) : (adv || {}); } catch (e) {}
  const enhanced = enhance.options(advUser.enhance).enabled;
  if (advUser.preview) payload.keepInput = true;

  const bins = await ff.locateBinaries();
  if (!bins.ok) throw new Error('FFmpeg not found — run setup in Settings first.');

  const pr = await ff.probe(inputPath);
  if (job.cancelRequested) throw new Error('Cancelled');
  if (!pr.ok) throw new Error('Could not read source: ' + (pr.error || 'ffprobe failed'));

  const before = ff.normalizeProbe(pr.data, inputPath);
  const presetDef = PRESETS[presetId] || PRESETS.remux;
  const gpu = await currentGpu();
  if (job.cancelRequested) throw new Error('Cancelled');
  const useGpu = settings.preferGpu !== false && advUser.encoder !== 'cpu';
  const enhancementPlan = enhanced ? enhance.plan(before, presetDef, advUser.enhance, advUser.preview) : null;
  const strategy = enhancementPlan ? { reencode: true, reencodeVideo: true, reencodeAudio: true, reason: enhancementPlan.reason } : presetDef.mode!=='remux' ? {reencode:true,reencodeVideo:true,reencodeAudio:true,reason:'Encode independently playable sections for resumable export.'} : decideStrategy(before, presetDef, advUser);
  const advFull = Object.assign({}, advUser, presetDef.target ? { target: presetDef.target } : {});
  if (enhancementPlan) advFull.target = { ...advFull.target, vcodec: enhancementPlan.codec };
  if(advUser.preview)advFull.target={...advFull.target,vcodec:'h264'};
  advFull.gpu = useGpu ? gpu : null;
  if (strategy.reencode && strategy.reencodeVideo) {
    // Same gate as the args: pass the useGpu-filtered value, not raw detection,
    // or a preferGpu=false job would be labeled "GPU ENCODE" (BUG-2).
    const enc = presetsMod.pickEncoder({ probe: enhancementPlan?{...before,video:{...before.video,width:enhancementPlan.width,height:enhancementPlan.height}}:before, adv: advFull, gpu: useGpu ? gpu : null });
    advFull.encoderResolved = enc.accel;           // gpu | cpu
    advFull.encoderName = enc.encoder;             // h264_nvenc | hevc_nvenc | libx264 | libx265
    advFull.accelLabel = enc.accel === 'gpu' ? 'GPU ENCODE' : 'CPU ENCODE';
  } else if (!strategy.reencode) {
    advFull.encoderResolved = 'copy';
    advFull.accelLabel = 'LOSSLESS REMUX';
  }

  // Atomic output: write to <name>.part.mp4 in temp, then rename into place.
  const outDir = advUser.outDir || settings.outDir;
  store.ensureDir(outDir);
  const tempDir = store.getSettings().tempDirEffective;
  store.ensureDir(tempDir);
  const finalName = uniqueOutPath(outDir, buildOutputName(job.sourceName + (enhanced ? (advUser.preview ? ' [AI sample]' : ' [AI]') + '.mp4' : ''), presetDef));
  const tmpOutput = path.join(outDir, job.id + '.part.mp4');
  job.tempOutput = tmpOutput;

  const args = buildArgs({ input: inputPath, output: tmpOutput, probe: before, strategy, adv: advFull });
  job.command = enhanced ? enhancementPlan.reason : 'ffmpeg ' + args.join(' ');
  job.accel = (enhanced ? 'AI / ' : '') + advFull.accelLabel;
  job.encoderName = advFull.encoderName || 'copy';
  job.presetName = presetDef.name;
  job.reason = strategy.reason;
  job.outputFinal = finalName;
  job.outDir = outDir;

  const durationSec = advUser.preview?Math.min(5,before.format.durationSec):before.format.durationSec || 0;
  const t0 = Date.now();
  let lastLog = 0;

  const run = presetDef.mode!=='remux' ? await studio.render({ input: inputPath, output: tmpOutput, probe: before, preset: presetDef, adv: advFull, job, tempRoot: tempDir, bins },strategy) : await ff.runBin(bins.ffmpegPath, args, {
    timeoutMs: 1000 * 60 * 60 * 3,
    onSpawn: (child) => { job.child = child; if (job.cancelRequested) child.kill(); },
    onProgressKv: (kv) => {
      // Progress starts emitting after the first frames; ignore N/A before that.
      const outTime = parseTimeUs(kv.out_time_us != null ? kv.out_time_us : kv.out_time_ms);
      const pct = durationSec > 0 && outTime > 0 ? Math.min(100, (outTime / durationSec) * 100) : null;
      if (pct == null && !kv.frame) return;
      job.progress = {
        pct: pct != null ? Math.round(pct * 10) / 10 : (kv.frame ? 0 : null),
        frame: Number(kv.frame) || null,
        fps: kv.fps && kv.fps !== 'N/A' ? Number(kv.fps) : null,
        speed: kv.speed && kv.speed !== 'N/A' ? String(kv.speed) : null,
        outTimeSec: outTime,
        totalSec: durationSec || null,
        elapsedMs: Date.now() - t0,
        etaSec: pct != null && pct > 0.5 ? Math.max(0, Math.round(((Date.now() - t0) / pct) * (100 - pct) / 1000)) : null,
        sizeBytes: kv.total_size && kv.total_size !== 'N/A' ? Number(kv.total_size) || null : null,
        bitrate: kv.bitrate && kv.bitrate !== 'N/A' ? kv.bitrate : null
      };
      // throttle log sample lines (progress kv carries the useful data)
      const now = Date.now();
      if (now - lastLog > 2000) {
        lastLog = now;
        job.logLines.push('frame=' + (kv.frame || '?') + ' fps=' + (kv.fps || '?') + ' speed=' + (kv.speed || '?') + ' time=' + (kv.out_time || '?') + ' size=' + (kv.total_size || '?'));
        if (job.logLines.length > 200) job.logLines.splice(0, job.logLines.length - 200);
      }
    },
    onLog: (chunk) => {
      for (const l of chunk.split(/\r?\n/)) {
        const t = l.trim();
        if (!t) continue;
        job.logLines.push(t);
        if (job.logLines.length > 200) job.logLines.splice(0, job.logLines.length - 200);
      }
    }
  });

  if(run.paused)return;
  if (job.cancelRequested) {
    job.state = 'cancelled'; job.status = 'cancelled';
    job.error = 'Cancelled';
    cleanupJobFiles(job, false);
    return;
  }
  if (run.code !== 0 || !fs.existsSync(tmpOutput) || fs.statSync(tmpOutput).size === 0) {
    job.state = 'failed'; job.status = 'failed';
    job.error = lastErr(run.stderr) || ('FFmpeg exited with code ' + run.code);
    job.logTail = (run.logLines || []).slice(-40);
    cleanupJobFiles(job, false);
    return;
  }

  // Playback validation before the output counts as completed.
  job.phase = 'validating';
  const validation = await ff.validatePlayback(tmpOutput, { durationSec, onSpawn: child => { job.child = child; if (job.cancelRequested) child.kill(); } });
  if (job.cancelRequested) throw new Error('Cancelled');
  if (!validation.ok) {
    job.state = 'failed'; job.status = 'failed';
    job.error = 'Output failed playback validation: ' + (validation.error || 'decode error');
    job.logTail = (run.logLines || []).slice(-40);
    cleanupJobFiles(job, false);
    return;
  }

  // Atomic finalize: move into the output folder only now.
  try {
    fs.linkSync(tmpOutput, finalName);
    fs.unlinkSync(tmpOutput);
  } catch (e) {
    // cross-device rename: copy+delete fallback
    try {
      fs.copyFileSync(tmpOutput, finalName, fs.constants.COPYFILE_EXCL);
      fs.unlinkSync(tmpOutput);
    } catch (e2) {
      job.state = 'failed'; job.status = 'failed';
      job.error = 'Could not move output into place: ' + String(e2.message || e2);
      cleanupJobFiles(job, false);
      return;
    }
  }

  let after = null;
  const pr2 = await ff.probe(finalName);
  if (pr2.ok) after = ff.normalizeProbe(pr2.data, finalName);

  job.state = 'completed'; job.status = 'done';
  job.result = {
    id: job.id,
    preview: !!advUser.preview,
    sampleStart: Number(advUser.sampleStart)||0,
    enhancement: enhancementPlan,
    preset: presetDef.id, presetName: presetDef.name,
    mode: strategy.reencode ? 're-encode' : 'lossless remux',
    accel: advFull.accelLabel,
    encoder: advFull.encoderName || 'stream copy',
    reason: strategy.reason,
    source: before.file,
    beforeSpecs: before,
    output: { name: path.basename(finalName), path: finalName, dir: outDir, size: after ? after.file.size : null },
    afterSpecs: after,
    validation,
    status: 'done',
    durationMs: Date.now() - t0,
    startedAt: job.startedAt, finishedAt: new Date().toISOString(),
    command: job.command
  };
  store.addHistory(job.result);
  cleanupJobFiles(job, true);
  studio.discard(job);
  releaseInput(job);
  job._payload = null;
}

function cleanupJobFiles(job, success) {
  const payload = job._payload || {};
  try {
    if (job.outputFinal && !fs.existsSync(job.outputFinal)) { /* nothing */ }
    const tmp = job.tempOutput;
    if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp);
  } catch (e) {}
  // failed + cancelled: KEEP the staged input — the UI offers Retry for both, and Retry
  // needs the source. remove()/clear-finished reclaim the input when the user deletes
  // the job instead of retrying (BUG-4: Retry used to be a dead button on failed jobs).
}

function parseTimeUs(v) {
  if (v == null || v === 'N/A' || v === '') return 0;
  if (String(v).includes(':')) {
    // hh:mm:ss.micro
    const [h, m, s] = String(v).split(':').map(Number);
    return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
  }
  const n = Number(v);
  if (!isFinite(n)) return 0;
  // out_time_us field is microseconds; out_time_ms is actually also microseconds in ffmpeg
  return n / 1e6;
}

function lastErr(stderr) {
  if (!stderr) return null;
  const lines = stderr.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (/^(ERROR|Error|Invalid|Could not|Unable|Conversion failed|Unknown|At least one)/i.test(l)) return l.slice(0, 300);
  }
  return lines[lines.length - 1].slice(0, 300) || null;
}

function buildOutputName(srcName, presetDef) {
  const base = srcName.replace(/\.[^./\\]+$/, '').slice(0, 120) || 'video';
  return base + ' [optimized ' + presetDef.id + '].mp4';
}

function uniqueOutPath(dir, name) {
  let candidate = path.join(dir, name);
  if (!fs.existsSync(candidate)) return candidate;
  const base = name.replace(/\.mp4$/i, '');
  for (let i = 2; i < 500; i++) {
    candidate = path.join(dir, base + ' (' + i + ').mp4');
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, base + ' (' + Date.now() + ').mp4');
}

function releaseInput(job) {
  const p = job._payload;
  if (!p || p.keepInput || path.dirname(path.resolve(p.inputPath)) !== path.resolve(store.UPLOADS_DIR)) return;
  if ([...JOBS.values()].some(j => j !== job && j._payload?.inputPath === p.inputPath)) return;
  try { fs.unlinkSync(p.inputPath); } catch {}
}
const queueFile = path.join(store.DATA_DIR, 'queue.json');
function persist() {
  store.writeJSON(queueFile, [...JOBS.values()].map(({ child, ...j }) => j));
}
function restore() {
  for (const j of store.readJSON(queueFile, [])) {
    if (!j.id) continue;
    if (['waiting', 'processing'].includes(j.state)) { j.state = 'paused'; j.status = 'paused'; j.error = 'Interrupted by shutdown. Resume continues from the last completed section.'; }
    j.cancelRequested = false;
    JOBS.set(j.id, j); QUEUE.push(j.id);
  }
}
function shutdown() { stopping = true; for(const j of JOBS.values()){if(['waiting','processing'].includes(j.state)){j.pauseRequested=true;j.state='paused';j.status='paused';if(j.child)j.child.kill();}} persist(); }
module.exports = { JOBS, enqueue, remove, retry, cancel, cancelAll, pause, resume, getJob, listJobs, pump, currentGpu, buildOutputName, uniqueOutPath, lastErr, restore, shutdown };
