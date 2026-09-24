'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const core = require('./update-core.cjs');

function createUpdates({ app, dialog, getWindow, busy, beforeInstall, trustedKey, launchInstaller }) {
  const configFile = path.join(process.env.FORGE_DATA_DIR, 'updates.json');
  const cache = path.join(process.env.FORGE_DATA_DIR, 'updates');
  const publicKey = trustedKey || fs.readFileSync(path.join(__dirname, 'update-public.pem'));
  let config = { feedUrl: require('./release-config.json').feedUrl, checkOnStart: true };
  try { config = { ...config, ...JSON.parse(fs.readFileSync(configFile, 'utf8')) }; } catch {}
  let state = { phase: 'idle', currentVersion: app.getVersion(), release: null, progress: 0, error: null, checkedAt: null };
  let operation = false, installer = null, releaseSource = null;
  const snapshot = () => ({ ...state, ...config, desktop: true, portable: !!process.env.PORTABLE_EXECUTABLE_FILE });
  async function run(action) {
    if (operation) throw new Error('Another update action is still running.');
    operation = true; state.error = null;
    try { return await action(); }
    catch (error) { state.phase = 'error'; state.error = error.message; throw error; }
    finally { operation = false; }
  }
  function save(patch) {
    if (operation) throw new Error('Wait for the current update action to finish.');
    if (patch.feedUrl != null) config.feedUrl = patch.feedUrl.trim() ? core.feedUrl(patch.feedUrl.trim()) : '';
    if (typeof patch.checkOnStart === 'boolean') config.checkOnStart = patch.checkOnStart;
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    installer = null; releaseSource = null; state = { ...state, phase: 'idle', release: null, progress: 0, error: null };
    return snapshot();
  }
  const check = () => run(async () => {
    if (!config.feedUrl) throw new Error('Set the GitHub release manifest URL first.');
    state.phase = 'checking'; installer = null;
    const release = core.verifyManifest(await core.fetchManifest(config.feedUrl), publicKey, app.getVersion());
    state.release = release; state.checkedAt = new Date().toISOString(); state.phase = release.newer ? 'available' : 'current';
    releaseSource = new URL(release.file, config.feedUrl).href;
    return snapshot();
  });
  const download = () => run(async () => {
    if (!state.release?.newer || !releaseSource) throw new Error('Check for an update first.');
    fs.mkdirSync(cache, { recursive: true });
    const destination = path.join(cache, crypto.randomUUID() + '.exe');
    state.phase = 'downloading'; state.progress = 0;
    await core.downloadInstaller(releaseSource, destination, state.release, percent => { state.progress = percent; });
    installer = destination; state.phase = 'ready'; return snapshot();
  });
  const importFile = () => run(async () => {
    const selected = await dialog.showOpenDialog(getWindow(), { title: 'Choose forge-update.json', properties: ['openFile'], filters: [{ name: 'Forge update manifest', extensions: ['json'] }] });
    if (selected.canceled) return snapshot();
    const filename = selected.filePaths[0];
    if (fs.statSync(filename).size > 65536) throw new Error('Update manifest is too large.');
    const release = core.verifyManifest(JSON.parse(fs.readFileSync(filename, 'utf8')), publicKey, app.getVersion());
    state.release = release; installer = null; releaseSource = null;
    if (!release.newer) { state.phase = 'current'; return snapshot(); }
    state.phase = 'verifying'; fs.mkdirSync(cache, { recursive: true });
    const destination = path.join(cache, crypto.randomUUID() + '.exe');
    try {
      await fs.promises.copyFile(path.join(path.dirname(filename), release.file), destination, fs.constants.COPYFILE_EXCL);
      await core.verifyInstaller(destination, release);
    } catch (error) { try { fs.unlinkSync(destination); } catch {} throw error; }
    installer = destination; state.phase = 'ready'; return snapshot();
  });
  const install = () => run(async () => {
    if (busy()) throw new Error('Finish or cancel your exports before installing an update.');
    if (state.phase !== 'ready' || !installer) throw new Error('Download or import a verified update first.');
    await core.verifyInstaller(installer, state.release);
    if (launchInstaller) await launchInstaller(installer);
    else await new Promise((resolve, reject) => {
      const child = spawn(installer, [], { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
      child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
    });
    state.phase = 'installing';
    setTimeout(() => { beforeInstall(); app.quit(); }, 400);
    return snapshot();
  });
  return { snapshot, save, check, download, importFile, install };
}
module.exports = { createUpdates };
