
// Forge V2 E2E suite — 41 checks, no new deps, runs against a LIVE API on :5177.
// Usage: node tests/e2e_suite.js
// Prereqs: API started with GENERATE_STRESS=1 environment having generated
// tests/fixtures (auto-generated on first run into %TEMP%/forge_e2e).
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { req, analyzeFile, waitForJob, sleep, SAMPLES, GEN } = require('./helpers.js');

let PASS = 0, FAIL = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { PASS++; console.log('  PASS ' + name); }
  else { FAIL++; failures.push(name + (detail ? ' | ' + String(detail).slice(0, 160) : '')); console.log('  FAIL ' + name + (detail ? ' | ' + String(detail).slice(0, 160) : '')); }
}

function md5(p) {
  const crypto = require('crypto');
  const h = crypto.createHash('md5');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

// ---- fixture generation (idempotent) ----
function ensureFixtures() {
  fs.mkdirSync(GEN, { recursive: true });
  const hevc60 = path.join(GEN, 'hevc60.mp4');          // 60s 4K60 HEVC — needs h264 transcode
  const corrupt = path.join(GEN, 'broken_stream.mp4');  // probeable but undecodable mid-stream
  if (!fs.existsSync(hevc60)) {
    console.log('  [fixtures] generating hevc60 (60s 4K60 HEVC, ~30s)…');
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=s=3840x2160:r=60:d=60',
      '-f', 'lavfi', '-i', 'sine=frequency=440:r=48000:d=60',
      '-c:v', 'hevc_nvenc', '-preset', 'p1', '-cq', '30', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-shortest', hevc60], { stdio: 'inherit', timeout: 600000 });
  }
  if (!fs.existsSync(corrupt)) {
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', corrupt]);
    const fd = fs.openSync(corrupt, 'r+');
    fs.writeSync(fd, Buffer.alloc(4096, 0), 0, 4096, Math.floor(fs.statSync(corrupt).size * 0.6));
    fs.closeSync(fd);
  }
  // truly unprobeable: random bytes (no container headers at all) -> analyze must 4xx
  const garbage = path.join(GEN, 'garbage.bin');
  if (!fs.existsSync(garbage)) fs.writeFileSync(garbage, require('crypto').randomBytes(256 * 1024));
  return { hevc60, corrupt, garbage };
}

async function main() {
  console.log('== Forge V2 E2E suite ==');
  const health = await req('GET', '/api/health');
  check('health: ffmpeg ready', health.ok && health.ffmpegReady);

  const gpu = (await req('GET', '/api/gpu')).gpu;

  const presets = (await req('GET', '/api/presets')).presets;
  check('presets: 7 presets listed', Array.isArray(presets) && presets.length === 7, presets.length);

  const fix = ensureFixtures();
  const vertical = path.join(SAMPLES, 'sample-vertical.mp4');
  const camera = path.join(SAMPLES, 'sample-camera.mov');
  const src4k = path.join(SAMPLES, 'sample-4k90.mp4');

  // ---- 1. analyze ----
  console.log('-- analyze --');
  const a1 = await analyzeFile(vertical);
  check('analyze: h264 1080x1920', a1.video && a1.video.codec === 'h264' && a1.video.resolution === '1080x1920');
  check('analyze: recommendation present', Boolean(a1.recommendation && a1.recommendation.presetId));
  check('analyze: clean source recommends remux', a1.recommendation.presetId === 'remux', a1.recommendation.presetId);

  const a2 = await analyzeFile(camera, 'camera.mov');

  let corruptRejected = false;
  try { await analyzeFile(fix.garbage, 'garbage.bin'); } catch (e) { corruptRejected = e.status === 422 || e.status === 400; }
  check('analyze: garbage file rejected with 4xx', corruptRejected);

  // ---- 2. strategy / labels ----
  console.log('-- strategy labels --');
  const aG = await analyzeFile(fix.hevc60, 'hevc60.mp4');
  check('hevc source: recommends 4k60 preset', aG.recommendation.presetId === 'tiktok_4k60', aG.recommendation.presetId);
  const oG = await req('POST', '/api/optimize-id', { uploadId: aG.uploadId, preset: 'tiktok_4k60', adv: {} });
  check('gpu accepted: GPU ENCODE label', oG.accel === 'GPU ENCODE', oG.accel);
  check('gpu accepted: h264_nvenc encoder', oG.encoder === 'h264_nvenc', oG.encoder);
  const jG = await waitForJob(oG.jobId, { timeoutMs: 600000 });
  check('gpu encode: completes', jG.state === 'completed', jG.error);
  check('gpu encode: result encoder h264_nvenc', (jG.result || {}).encoder === 'h264_nvenc', (jG.result || {}).encoder);
  const outG = (jG.result || {}).output || {};
  check('gpu encode: output exists', outG.path && fs.existsSync(outG.path));
  check('gpu encode: afterSpecs 4K60 h264',
    jG.result && jG.result.afterSpecs && jG.result.afterSpecs.video.resolution === '3840x2160' &&
    jG.result.afterSpecs.video.fps === 60 && jG.result.afterSpecs.video.codec === 'h264');
  check('gpu encode: decode clean',
    (() => { try { execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', outG.path, '-f', 'null', '-'], { timeout: 300000 }); return true; } catch (e) { return false; } })());

  // ---- 3. forced CPU fallback ----
  console.log('-- forced CPU fallback --');
  const aC = await analyzeFile(fix.hevc60, 'hevc60-cpu.mp4');
  const oC = await req('POST', '/api/optimize-id', { uploadId: aC.uploadId, preset: 'tiktok_1080p60', adv: { encoder: 'cpu' } });
  check('forced cpu: CPU ENCODE label', oC.accel === 'CPU ENCODE', oC.accel);
  check('forced cpu: libx264 encoder', oC.encoder === 'libx264', oC.encoder);
  const jC = await waitForJob(oC.jobId, { timeoutMs: 900000 });
  check('forced cpu: completes', jC.state === 'completed', jC.error);
  check('forced cpu: downscaled to 1080',
    jC.result && jC.result.afterSpecs && jC.result.afterSpecs.video.resolution.includes('1080'),
    jC.result && jC.result.afterSpecs && jC.result.afterSpecs.video.resolution);

  // ---- 4. lossless remux integrity ----
  console.log('-- lossless remux --');
  const aM = await analyzeFile(camera, 'camera2.mov');
  const oM = await req('POST', '/api/optimize-id', { uploadId: aM.uploadId, preset: 'remux', adv: {} });
  check('remux: LOSSLESS REMUX label', oM.accel === 'LOSSLESS REMUX', oM.accel);
  const jM = await waitForJob(oM.jobId);
  check('remux: completes', jM.state === 'completed', jM.error);
  check('remux: mode lossless remux', (jM.result || {}).mode === 'lossless remux');
  const outM = ((jM.result || {}).output || {}).path;
  const pdM = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_name,pix_fmt:format=format_name,duration', '-of', 'json', outM]).toString());
  check('remux: codecs preserved (h264+aac)',
    pdM.streams[0].codec_name === 'h264' && (pdM.streams[1] || {}).codec_name === 'aac');
  const headM = fs.readFileSync(outM).slice(0, 300000);
  const moovM = headM.indexOf('moov'), mdatM = headM.indexOf('mdat');
  check('remux: faststart (moov before mdat)', moovM !== -1 && (mdatM === -1 || moovM < mdatM));

  // ---- 5. progress tracking accuracy ----
  console.log('-- progress tracking --');
  const aP = await analyzeFile(fix.hevc60, 'hevc60-prog.mp4');
  const oP = await req('POST', '/api/optimize-id', { uploadId: aP.uploadId, preset: 'tiktok_1080p60', adv: { encoder: 'cpu', x264Preset: 'fast', crf: 23 } });
  const samples = [];
  let jP = null;
  const t0 = Date.now();
  for (;;) {
    const j = await req('GET', '/api/queue/' + oP.jobId);
    if (j.progress && j.progress.pct != null) samples.push({ t: (Date.now() - t0) / 1000, pct: j.progress.pct, out: j.progress.outTimeSec, eta: j.progress.etaSec });
    if (['completed', 'failed', 'cancelled'].includes(j.state)) { jP = j; break; }
    if (Date.now() - t0 > 600000) throw new Error('progress job timeout');
    await sleep(800);
  }
  check('progress: job completes', jP.state === 'completed', jP.error);
  const sampleErrs = samples.filter((s) => s.out != null).map((s) => Math.abs(s.pct - Math.min(100, (s.out / 60) * 100)));
  check('progress: pct matches out_time/duration (max err < 2%)', sampleErrs.length > 0 && Math.max(...sampleErrs) < 2, sampleErrs.length ? Math.max(...sampleErrs).toFixed(3) : 'n/a');
  const mid = samples[Math.floor(samples.length / 2)];
  check('progress: ETA present mid-job', mid && mid.eta != null && mid.eta > 0);

  // ---- 6. cancel during active encode ----
  console.log('-- cancel during active encode --');
  const aX = await analyzeFile(fix.hevc60, 'hevc60-cancel.mp4');
  const oX = await req('POST', '/api/optimize-id', { uploadId: aX.uploadId, preset: 'tiktok_4k60', adv: { encoder: 'cpu', x264Preset: 'slow', crf: 20 } });
  let reached = false;
  const t1 = Date.now();
  while (Date.now() - t1 < 120000) {
    const j = await req('GET', '/api/queue/' + oX.jobId);
    if (j.progress && (j.progress.pct || 0) >= 5) { reached = true; break; }
    await sleep(400);
  }
  await req('POST', '/api/queue/' + oX.jobId + '/cancel');
  await sleep(2500);
  const jX = await req('GET', '/api/queue/' + oX.jobId);
  check('cancel: state cancelled', jX.state === 'cancelled', jX.state);
  const partX = path.join(os.homedir(), 'AppData', 'Local', 'Forge', 'temp', oX.jobId + '.part.mp4');
  check('cancel: no .part file left', !fs.existsSync(partX));
  check('cancel: no output produced', !(jX.result || {}).output);
  const rX = await req('POST', '/api/queue/' + oX.jobId + '/retry');
  check('cancel: retry accepted', (rX.job || {}).state === 'waiting', (rX.job || {}).error);
  const jX2 = await waitForJob((rX.job || {}).id, { timeoutMs: 600000 });
  check('cancel: retry completes', jX2.state === 'completed', jX2.error);
  await req('DELETE', '/api/queue/' + oX.jobId);   // reclaim cancelled staged input

  // cancel of a WAITING job stays visible
  const aW = await analyzeFile(fix.hevc60, 'hevc60-wait.mp4');
  const oW1 = await req('POST', '/api/optimize-id', { uploadId: aW.uploadId, preset: 'tiktok_4k60', adv: { encoder: 'cpu', x264Preset: 'slow', crf: 20 } });
  const aW2 = await analyzeFile(fix.hevc60, 'hevc60-wait2.mp4');
  const oW2 = await req('POST', '/api/optimize-id', { uploadId: aW2.uploadId, preset: 'tiktok_4k60', adv: { encoder: 'cpu', x264Preset: 'slow', crf: 20 } });
  let sawWaiting = false;
  const t2 = Date.now();
  while (Date.now() - t2 < 60000) {
    const q = (await req('GET', '/api/queue')).items;
    const s1 = (q.find((x) => x.id === oW1.jobId) || {}).state;
    const s2 = (q.find((x) => x.id === oW2.jobId) || {}).state;
    if (s1 === 'processing' && s2 === 'waiting') { sawWaiting = true; break; }
    await sleep(400);
  }
  check('queue: second job waits while first runs', sawWaiting);
  await req('POST', '/api/queue/' + oW2.jobId + '/cancel');
  await sleep(1200);
  const qW = (await req('GET', '/api/queue')).items;
  check('cancel-waiting: shows cancelled in queue', (qW.find((x) => x.id === oW2.jobId) || {}).state === 'cancelled');
  const jW1 = await waitForJob(oW1.jobId, { timeoutMs: 600000 });
  check('queue: first job unaffected by sibling cancel', jW1.state === 'completed', jW1.error);
  await req('DELETE', '/api/queue/' + oW2.jobId);

  // ---- 7. queue semantics ----
  console.log('-- queue semantics --');
  const q0 = (await req('GET', '/api/queue')).items;
  const processingNow = q0.filter((x) => x.state === 'processing').length;

  // failed job retry works (BUG-4 regression)
  const aF = await analyzeFile(fix.corrupt, 'broken2.mp4').catch(() => null);
  let failedRetry = null;
  if (aF) {
    const oF = await req('POST', '/api/optimize-id', { uploadId: aF.uploadId, preset: 'remux', adv: {} });
    const jF = await waitForJob(oF.jobId);
    const rr = await req('POST', '/api/queue/' + oF.jobId + '/retry');
    failedRetry = (rr.job || {}).state;
    check('retry-failed: re-enqueues (input kept)', failedRetry === 'waiting', (rr.job || {}).error);
    await waitForJob((rr.job || {}).id).catch(() => {});
    await req('DELETE', '/api/queue/' + oF.jobId);
    await req('DELETE', '/api/queue/' + (rr.job || {}).id);
  }

  // ---- 8. history ----
  console.log('-- history --');
  const h = (await req('GET', '/api/history')).items;
  const latest = h[0] || {};
  check('history: latest has before/after specs', Boolean(latest.beforeSpecs && latest.afterSpecs));
  await req('DELETE', '/api/history/' + latest.id);
  const h2 = (await req('GET', '/api/history')).items;

  // ---- 9. settings ----
  console.log('-- settings --');
  const st = await req('GET', '/api/settings');
  check('settings: has outDir + preferGpu', typeof st.outDir === 'string' && typeof st.preferGpu === 'boolean');
  check('settings: tempDirEffective outside OneDrive', !/onedrive/i.test(st.tempDirEffective || ''), st.tempDirEffective);
  const st2 = await req('POST', '/api/settings', { historyLimit: 250 });
  await req('POST', '/api/settings', { historyLimit: 200 });

  // ---- 10. batch analyze ----
  console.log('-- batch analyze --');
  const bb = await req('POST', '/api/analyze-batch', null, {
    files: [
      ['v.mp4', vertical, 'video/mp4'],
      ['c.mov', camera, 'video/quicktime'],
      ['k.mp4', src4k, 'video/mp4'],
    ]
  });
  check('batch: 3 items analyzed', bb.items.length === 3);
  check('batch: all have uploadId + recommendation', bb.items.every((x) => x.uploadId && x.recommendation));
  check('batch: 4K90 recommends 4k60 preset', (bb.items[2].recommendation || {}).presetId === 'tiktok_4k60', bb.items[2].recommendation && bb.items[2].recommendation.presetId);
  // clean staged batch inputs by aging+removing via boot rule is overkill; jobs consume on run
  for (const it of bb.items) {
    // enqueue remux jobs so staged files get consumed, then wait
    const o = await req('POST', '/api/optimize-id', { uploadId: it.uploadId, preset: 'remux', adv: {} });
  }
  const qB = (await req('GET', '/api/queue')).items.filter((x) => x.state === 'waiting' || x.state === 'processing');
  for (const x of qB) await waitForJob(x.id, { timeoutMs: 600000 }).catch(() => {});
  await req('POST', '/api/queue/clear-finished');

  // ---- summary ----
  console.log('\n========================');
  console.log('PASS ' + PASS + ' / ' + (PASS + FAIL));
  if (FAIL) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
}

main().catch((e) => { console.error('SUITE ERROR:', e && (e.stack || e.message || e)); process.exit(2); });
