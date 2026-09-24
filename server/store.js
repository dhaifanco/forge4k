'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = process.env.FORGE_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'Forge', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

// V2: dedicated local temp root OUTSIDE any OneDrive/managed-sync folder.
// %LOCALAPPDATA%\Forge\temp on Windows, ~/.forge/temp elsewhere.
function defaultTempDir() {
  if (process.env.FORGE_DATA_DIR) return path.join(DATA_DIR, 'temp');
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'Forge', 'temp');
  }
  return path.join(os.homedir(), '.forge', 'temp');
}

function isUnderSyncFolder(p) {
  const norm = String(p || '').toLowerCase();
  return /onedrive|icloud|dropbox|google drive|googleDrive/.test(norm);
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function writeJSON(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try { fs.unlinkSync(file); } catch (e) {}
  fs.renameSync(tmp, file);
}

const DEFAULT_SETTINGS = {
  ffmpegPath: '',
  ffprobePath: '',
  outDir: path.join(process.env.USERPROFILE || os.homedir(), 'Videos', 'Forge Optimizer'),
  historyLimit: 200,
  // V2: prefer GPU encoding automatically when NVENC is available
  preferGpu: true,
  // V2: temp work dir; empty = platform default outside OneDrive
  tempDir: ''
};

function getSettings() {
  const s = Object.assign({}, DEFAULT_SETTINGS, readJSON(SETTINGS_FILE, {}));
  if (!s.tempDir || isUnderSyncFolder(s.tempDir)) {
    s.tempDirEffective = defaultTempDir();
  } else {
    s.tempDirEffective = path.join(s.tempDir, 'Forge-work');
  }
  if (isUnderSyncFolder(s.outDir)) {
    // only warn via flag; user may deliberately want synced output
    s.outDirSynced = true;
  }
  return s;
}

function saveSettings(patch) {
  const s = Object.assign({}, getSettings(), patch || {});
  if (s.tempDir && isUnderSyncFolder(s.tempDir)) {
    // refuse to persist a synced temp dir — silently keep the safe default
    s.tempDir = '';
  }
  const clean = {
    ffmpegPath: s.ffmpegPath, ffprobePath: s.ffprobePath, outDir: s.outDir,
    historyLimit: s.historyLimit, preferGpu: s.preferGpu !== false, tempDir: s.tempDir || ''
  };
  writeJSON(SETTINGS_FILE, clean);
  return getSettings();
}

function getHistory() {
  const l = readJSON(HISTORY_FILE, []);
  return Array.isArray(l) ? l : [];
}

function addHistory(entry) {
  const s = getSettings();
  const list = getHistory();
  list.push(entry);
  const limit = Math.max(10, Number(s.historyLimit) || 200);
  while (list.length > limit) list.shift();
  writeJSON(HISTORY_FILE, list);
  return entry;
}

function removeHistory(id) {
  const list = getHistory().filter((e) => e.id !== id);
  writeJSON(HISTORY_FILE, list);
  return list;
}

function clearHistory() {
  writeJSON(HISTORY_FILE, []);
}

// V2: wipe leftover temp work files (per-job folders are jobid-xxx.*)
function cleanTempDir(olderThanMs) {
  const dir = getSettings().tempDirEffective;
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  const now = Date.now();
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && /^forge-ai-[a-f0-9-]+$/.test(e.name)) {
      const folder=path.resolve(dir,e.name);
      if(path.dirname(folder)!==path.resolve(dir)) continue;
      try {
        if (now-fs.statSync(folder).mtimeMs < (olderThanMs || 24*3600*1000)) continue;
        const owner=readJSON(path.join(folder,'owner.json'),{});
        if(Number.isInteger(owner.pid) && owner.pid>0){try{process.kill(owner.pid,0);continue;}catch(error){if(error.code!=='ESRCH')continue;}}
        fs.rmSync(folder,{recursive:true,force:true});removed++;
      } catch {}
      continue;
    }
    if (!e.isFile() || !/^job_[a-z0-9]+\.part\.mp4$/.test(e.name)) continue;
    const full = path.join(dir, e.name);
    try {
      {
        if (olderThanMs) {
          const age = now - fs.statSync(full).mtimeMs;
          if (age < olderThanMs) continue;
        }
        fs.unlinkSync(full);
        removed++;
      }
    } catch (err) { /* file locked — skip */ }
  }
  return removed;
}

// V2 QA: stale staged uploads (failed/cancelled jobs that were never removed) must not
// accumulate forever — apply the same age rule the temp dir uses, at boot.
function cleanUploadsDir(olderThanMs) {
  if (!fs.existsSync(UPLOADS_DIR)) return 0;
  let removed = 0;
  const now = Date.now();
  for (const e of fs.readdirSync(UPLOADS_DIR, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const full = path.join(UPLOADS_DIR, e.name);
    try {
      if (olderThanMs) {
        const age = now - fs.statSync(full).mtimeMs;
        if (age < olderThanMs) continue;
      }
      fs.unlinkSync(full);
      removed++;
    } catch (err) { /* locked — skip */ }
  }
  return removed;
}

module.exports = {
  DATA_DIR, HISTORY_FILE, SETTINGS_FILE, UPLOADS_DIR,
  ensureDir, readJSON, writeJSON,
  getSettings, saveSettings,
  getHistory, addHistory, removeHistory, clearHistory,
  defaultTempDir, isUnderSyncFolder, cleanTempDir, cleanUploadsDir
};
