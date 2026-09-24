'use strict';
// NVIDIA GPU + NVENC detection and lightweight stats polling. Local only.
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

let smiPath = null;
let smiTried = false;
let detection = null;   // { available, name, driver, nvenc: {h264, hevc, av1}, reason, checkedAt }
let statsCache = { at: 0, data: null };
const STATS_TTL_MS = 1200;
const DETECT_TTL_MS = 60000;

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs || 10000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', error: err ? String(err.message || err) : null });
    });
  });
}

function smiCandidates() {
  const list = ['nvidia-smi'];
  if (process.platform === 'win32') {
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe');
    list.push(sys);
    for (const base of ['C:\\Program Files\\NVIDIA Corporation\\NVSMI', 'C:\\NVIDIA']) {
      list.push(path.join(base, 'nvidia-smi.exe'));
    }
  } else {
    list.push('/usr/bin/nvidia-smi', '/usr/local/bin/nvidia-smi');
  }
  return list;
}

async function locateSmi() {
  if (smiTried && smiPath) return smiPath;
  for (const c of smiCandidates()) {
    if (path.isAbsolute(c) && !fs.existsSync(c)) continue;
    const r = await run(c, ['--query-gpu=name', '--format=csv,noheader'], 6000);
    if (r.ok && r.stdout.trim()) { smiPath = c; smiTried = true; return smiPath; }
  }
  smiTried = true;
  return null;
}

// Cheap encode smoke test — the encoders list only proves the build has NVENC
// compiled in, not that the driver/session can actually open an encoder.
// NVENC minimum width is 145 px (some drivers 33), so use a 256x256 test frame.
async function nvencSmokeTest(ffmpegPath, encoder) {
  const r = await run(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=256x256:d=0.1', '-frames:v', '3',
    '-c:v', encoder, '-f', 'null', '-'
  ], 20000);
  return r.ok;
}

async function detectGpu(ffmpegPath, force) {
  const fresh = detection && (Date.now() - detection.checkedAt) < DETECT_TTL_MS;
  if (detection && fresh && !force) return detection;

  const smi = await locateSmi();
  if (!smi) {
    detection = { available: false, name: null, driver: null, nvenc: { h264: false, hevc: false, av1: false }, reason: 'No NVIDIA GPU / nvidia-smi found', checkedAt: Date.now() };
    return detection;
  }
  const q = await run(smi, ['--query-gpu=name,driver_version', '--format=csv,noheader'], 6000);
  if (!q.ok) {
    detection = { available: false, name: null, driver: null, nvenc: { h264: false, hevc: false, av1: false }, reason: 'nvidia-smi query failed', checkedAt: Date.now() };
    return detection;
  }
  const [name, driver] = q.stdout.trim().split(/,\s*/);
  const base = { available: true, name: name || 'NVIDIA GPU', driver: driver || null, checkedAt: Date.now() };

  if (!ffmpegPath) {
    detection = Object.assign(base, { nvenc: { h264: false, hevc: false, av1: false }, reason: 'FFmpeg not found yet' });
    return detection;
  }
  const enc = await run(ffmpegPath, ['-hide_banner', '-encoders'], 15000);
  const list = enc.ok ? enc.stdout : '';
  const compiled = {
    h264: /h264_nvenc/.test(list),
    hevc: /hevc_nvenc/.test(list),
    av1: /av1_nvenc/.test(list)
  };
  const nvenc = { h264: false, hevc: false, av1: false };
  let reason = compiled.h264 || compiled.hevc ? 'NVENC ready' : 'This FFmpeg build has no NVENC encoders';
  for (const k of ['h264', 'hevc', 'av1']) {
    if (compiled[k]) nvenc[k] = await nvencSmokeTest(ffmpegPath, k + '_nvenc');
  }
  if ((compiled.h264 || compiled.hevc) && !nvenc.h264 && !nvenc.hevc) {
    reason = 'NVENC encoders present but could not open a session (driver/session error)';
  }
  detection = Object.assign(base, { nvenc, reason, checkedAt: Date.now() });
  return detection;
}

// Best-effort live stats for the NVIDIA panel. Non-fatal on any failure.
async function gpuStats() {
  if (statsCache.data && (Date.now() - statsCache.at) < STATS_TTL_MS) return statsCache.data;
  const smi = await locateSmi();
  if (!smi) return null;
  const r = await run(smi, [
    '--query-gpu=name,driver_version,utilization.gpu,memory.used,memory.total,temperature.gpu,encoder.stats.sessionCount,encoder.stats.averageFps,encoder.stats.averageLatency',
    '--format=csv,noheader,nounits'
  ], 6000);
  if (!r.ok) { statsCache = { at: Date.now(), data: null }; return null; }
  const p = r.stdout.trim().split(/,\s*/).map((s) => s.trim());
  const num = (s) => { const n = Number(s); return isFinite(n) ? n : null; };
  const data = {
    name: p[0] || null,
    driver: p[1] || null,
    gpuUtil: num(p[2]),
    vramUsedMb: num(p[3]),
    vramTotalMb: num(p[4]),
    tempC: num(p[5]),
    encSessions: num(p[6]),
    encFps: num(p[7]),
    encLatencyUs: num(p[8])
  };
  statsCache = { at: Date.now(), data };
  return data;
}

function clearGpuCache() { detection = null; smiPath = null; smiTried = false; statsCache = { at: 0, data: null }; }

module.exports = { detectGpu, gpuStats, clearGpuCache, locateSmi };
