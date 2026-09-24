'use strict';
// FFmpeg/FFprobe detection + all media operations. Local only.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getSettings } = require('./store');

let CACHED = null;

function candidates(name) {
  const list = [];
  if (process.env.FORCE_FFMPEG_DIR) list.push(path.join(process.env.FORCE_FFMPEG_DIR, name + (process.platform === 'win32' ? '.exe' : '')));
  list.push(name); // PATH
  if (process.platform === 'win32') {
    for (const base of [process.env.LOCALAPPDATA, process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]) {
      if (!base) continue;
      for (const sub of ['ffmpeg\\bin', 'ffmpeg\\ffmpeg-master-latest-win64-gpl\\bin', 'ffmpeg-9.0.1-full_build\\bin', 'ffmpeg-8.0-full_build\\bin', 'ffmpeg-7.1-full_build\\bin']) {
        list.push(path.join(base, sub, name + '.exe'));
      }
    }
  }
  return list;
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs || 20000, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', error: err ? String(err.message || err) : null });
    });
  });
}

async function locateBinaries() {
  if (CACHED) return CACHED;
  const s = getSettings();
  const res = {};
  for (const [key, name] of [['ffmpegPath', 'ffmpeg'], ['ffprobePath', 'ffprobe']]) {
    const list = [];
    if (s[key]) list.push(s[key]);
    list.push(...candidates(name));
    let found = '';        // spawnable path
    let display = '';      // human-readable location
    for (const c of list) {
      if (!c) continue;
      if (path.isAbsolute(c) && !fs.existsSync(c)) continue;
      const r = await run(c, ['-version'], 10000);
      if (r.ok) {
        found = c;
        display = path.isAbsolute(c) ? c : ((r.stdout.split('\n')[0] || '').trim() + ' (on PATH)');
        break;
      }
    }
    res[key] = found;
    res[key + 'Display'] = display;
    res[key + 'IsPath'] = !path.isAbsolute(found);
  }
  res.ok = Boolean(res.ffmpegPath && res.ffprobePath);
  CACHED = res;
  return res;
}

function clearBinCache() { CACHED = null; }

function runBin(binPath, args, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    // V2: -progress pipe:1 gives machine-readable progress on stdout; keep the
    // human stderr log for the collapsible debug log.
    const finalArgs = opts.progress !== false
      ? [...args.slice(0, -1), '-progress', 'pipe:1', '-nostats', args[args.length - 1]]
      : args;
    const child = spawn(binPath, finalArgs, { windowsHide: true });
    if (opts.onSpawn) try { opts.onSpawn(child); } catch (e) {}
    let stdout = '', stderr = '', lastLine = '';
    let progressBuf = '';
    let kv = null;
    const logLines = []; // ring buffer for the collapsible log (tail)
    const pushLog = (line) => {
      if (!line) return;
      logLines.push(line);
      if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
    };
    const timeout = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, opts.timeoutMs || 1000 * 60 * 60);
    child.stdout.on('data', (d) => {
      stdout += d; if (stdout.length > 2e6) stdout = stdout.slice(-1e6);
      if (opts.progress !== false) {
        // -progress emits `key=value` lines terminated by a `progress=continue|end` line.
        // Parse line-wise: a complete block ends whenever we see a progress= line.
        progressBuf += String(d);
        const lines = progressBuf.split(/\r?\n/);
        progressBuf = lines.pop(); // keep the incomplete tail line in the buffer
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          const m = t.match(/^([a-z_0-9]+)=(.*)$/);
          if (!m) continue;
          if (!kv) kv = {};
          kv[m[1]] = m[2];
          if (m[1] === 'progress' && kv && opts.onProgressKv) {
            // block complete — kv.progress is 'continue' or 'end'
            try { opts.onProgressKv(kv); } catch (e) {}
            kv = null;
          }
        }
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d; if (stderr.length > 4e6) stderr = stderr.slice(-2e6);
      for (const l of String(d).split(/\r?\n/)) {
        const t = l.trim();
        if (!t) continue;
        pushLog(t);
        if (t.startsWith('frame=') || t.startsWith('size=')) lastLine = t;
      }
      if (opts.onProgress && lastLine) opts.onProgress(lastLine);
      if (opts.onLog) { try { opts.onLog(String(d)); } catch (e) {} }
    });
    child.on('error', (e) => { clearTimeout(timeout); resolve({ code: -1, stdout, stderr, error: String(e.message || e), logLines }); });
    child.on('close', (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr, lastLine, logLines }); });
  });
}

function probe(file) {
  return new Promise(async (resolve) => {
    const { ffprobePath } = await locateBinaries();
    if (!ffprobePath) return resolve({ ok: false, error: 'FFprobe not found' });
    const r = await run(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 60000);
    if (!r.ok) return resolve({ ok: false, error: r.stderr.slice(-400) || r.error });
    try {
      const j = JSON.parse(r.stdout);
      if (!(j.streams || []).some(s => s.codec_type === 'video' && s.width && s.height && !s.disposition?.attached_pic)) {
        return resolve({ ok: false, error: 'This file has no usable video stream.' });
      }
      resolve({ ok: true, data: j });
    } catch (e) {
      resolve({ ok: false, error: 'Could not parse ffprobe output' });
    }
  });
}

// ---- Normalization of probe data ----
function fracToFps(str) {
  if (!str) return null;
  const [a, b = 1] = String(str).split('/').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return Math.round((a / b) * 1000) / 1000;
}

function bytes(n) {
  if (n == null || isNaN(n)) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return { bytes: Math.round(Number(n)), human: (i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)) + ' ' + units[i] };
}

function normalizeProbe(raw, filePath) {
  const f = raw.format || {};
  const fmtTokens = (f.format_name || '').split(',');
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  let container = fmtTokens[0];
  if (fmtTokens.includes('mp4') && ['mp4', 'm4v', 'm4a'].includes(ext)) container = 'mp4';
  else if (fmtTokens.includes('mov') && ext === 'mov') container = 'mov';
  else if (fmtTokens.includes('mp4')) container = 'mp4';
  const v = (raw.streams || []).find((s) => s.codec_type === 'video') || {};
  const a = (raw.streams || []).find((s) => s.codec_type === 'audio') || null;
  const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  const sizeB = stat ? stat.size : (Number(f.size) || null);
  const dur = Number(f.duration || v.duration || 0);
  const bitRate = Number(v.bit_rate || f.bit_rate || 0);
  return {
    file: { name: path.basename(filePath), path: filePath, dir: path.dirname(filePath), size: bytes(sizeB) },
    format: { container, formatLong: f.format_name || '', durationSec: Math.round(dur * 1000) / 1000, durationHuman: fmtDur(dur), overallBitrate: bitRate ? Math.round(bitRate / 1000) + ' kbps' : '—', start: f.start_time || '0' },
    video: {
      codec: v.codec_name || null, codecLong: v.codec_long_name || null, profile: v.profile || null, level: v.level != null ? v.level : null,
      width: v.width || null, height: v.height || null, resolution: v.width ? v.width + 'x' + v.height : null,
      rotation: Number((v.side_data_list || []).find(s => s.rotation != null)?.rotation || v.tags?.rotate || 0),
      bitrateKbps: Number(v.bit_rate || 0) / 1000,
      fps: fracToFps(v.avg_frame_rate) || fracToFps(v.r_frame_rate), fpsRaw: { avg: v.avg_frame_rate, r: v.r_frame_rate },
      bitrate: bitRate ? Math.round(bitRate / 1000) + ' kbps' : '—', pixFmt: v.pix_fmt || null, bitDepth: pixDepth(v.pix_fmt),
      colorSpace: v.color_space || null, colorTransfer: v.color_transfer || null, colorPrimaries: v.color_primaries || null,
      chromaLocation: v.chroma_location || null, isHdr: /^(smpte2084|arib-std-b67)$/.test(String(v.color_transfer || '')),
      fieldOrder: v.field_order || null, nbFrames: v.nb_frames || null
    },
    audio: a ? {
      codec: a.codec_name, codecLong: a.codec_long_name, profile: a.profile || null, sampleRate: a.sample_rate ? Number(a.sample_rate) + ' Hz' : null,
      channels: a.channels, channelLayout: a.channel_layout || null, bitrate: a.bit_rate ? Math.round(a.bit_rate / 1000) + ' kbps' : null
    } : null,
    streams: (raw.streams || []).map((s) => ({ index: s.index, type: s.codec_type, codec: s.codec_name, lang: (s.tags && s.tags.language) || null, disposition: s.disposition || {} })),
    metadata: cleanTags(f.tags), streamMetadata: cleanTags(v.tags)
  };
}

function pixDepth(pix) {
  if (!pix) return null;
  if (/10|p10|yuv420p10|yuv422p10|yuv444p10/.test(pix)) return 10;
  if (/12/.test(pix)) return 12;
  if (/16/.test(pix)) return 16;
  return 8;
}

function cleanTags(tags) {
  const out = {};
  for (const [k, val] of Object.entries(tags || {})) out[k] = String(val).slice(0, 300);
  return out;
}

function fmtDur(s) {
  if (s == null || !isFinite(s) || s < 0) return 'Not available';
  const total = Math.round(s), h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
  return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + sec + 's';
}

// ---- Health assessment (pure analysis, honest labels) ----
function assessHealth(p) {
  const findings = []; let score = 100;
  const v = p.video, a = p.audio;
  const socialHeight = [1920, 1080].includes(v.height) ? true : false;

  if (v.codec === 'h264') findings.push({ level: 'good', text: 'H.264 — maximum platform compatibility' });
  else if (v.codec === 'hevc') findings.push({ level: 'warn', text: 'H.265/HEVC — may be transcoded or rejected by some platforms' });
  else if (v.codec === 'av1') findings.push({ level: 'warn', text: 'AV1 — modern, but upload support varies' });
  else findings.push({ level: 'bad', text: 'Unusual codec: ' + (v.codec || 'unknown') });

  if (a && a.codec === 'aac') findings.push({ level: 'good', text: 'AAC audio — platform standard' });
  else if (!a) findings.push({ level: 'warn', text: 'No audio stream' });
  else findings.push({ level: 'warn', text: 'Audio ' + a.codec + ' — AAC is the safe standard' });

  if (v.pixFmt === 'yuv420p') findings.push({ level: 'good', text: 'yuv420p pixel format — fully compatible' });
  else if (v.pixFmt && /10/.test(v.pixFmt)) findings.push({ level: 'warn', text: v.pixFmt + ' 10-bit — some platforms prefer yuv420p 8-bit' });
  else if (v.pixFmt) findings.push({ level: 'warn', text: 'Pixel format ' + v.pixFmt + ' — yuv420p is the compatible standard' });

  if (p.format.container === 'mov') findings.push({ level: 'warn', text: 'MOV container — MP4 remux recommended for upload' });
  else findings.push({ level: 'good', text: 'MP4 container' });

  const moovFast = p.metadata && String(p.metadata['major_brand'] || '').length > 0;
  findings.push({ level: 'info', text: 'Faststart (moov at front) will be verified/applied during optimization' });

  if (!socialHeight && v.height) findings.push({ level: 'info', text: v.height + 'p is fine — vertical 1080x1920 / 2160x3840 is the social sweet spot' });
  if (v.fps && v.fps > 65) findings.push({ level: 'info', text: v.fps + ' fps high frame rate — preserved as-is' });
  if (v.isHdr) findings.push({ level: 'warn', text: 'HDR color metadata detected — SDR platforms may shift colors' });
  if (String(p.metadata['encoder'] || '').includes('Lavf')) findings.push({ level: 'info', text: 'Already FFmpeg-produced container' });

  return { score: Math.max(0, Math.min(100, score)), findings };
}

// V2: full decode validation — proves the output actually plays, not just probes.
async function validatePlayback(file, options = {}) {
  const { ffmpegPath } = await locateBinaries();
  if (!ffmpegPath) return { ok: false, error: 'FFmpeg not found' };
  const r = await runBin(ffmpegPath, ['-nostdin', '-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], {
    progress: false, timeoutMs: Math.max(600000, (options.durationSec || 0) * 20000), onSpawn: options.onSpawn
  });
  return { ok: r.code === 0, warnings: 0, error: r.code === 0 ? null : (r.error || r.stderr.slice(-400) || 'Validation interrupted') };
}

module.exports = { locateBinaries, clearBinCache, probe, normalizeProbe, assessHealth, runBin, bytes, fracToFps, fmtDur, validatePlayback };
