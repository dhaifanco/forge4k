'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../desktop/update-core.cjs');
const keys = crypto.generateKeyPairSync('ed25519');
const content = Buffer.from('test installer bytes, never execute');
const release = { appId: 'com.forge.videooptimizer', version: '1.2.0', platform: 'win32', arch: 'x64', file: 'Forge-1.2.0-setup.exe', size: content.length, sha512: crypto.createHash('sha512').update(content).digest('hex'), notes: 'Test release' };
const sign = value => ({ release: value, signature: crypto.sign(null, Buffer.from(JSON.stringify(value)), keys.privateKey).toString('base64') });
test('signed updates, semantic version order and downgrade handling', () => {
  assert.equal(core.verifyManifest(sign(release), keys.publicKey, '1.1.0').newer, true);
  assert.equal(core.verifyManifest(sign(release), keys.publicKey, '1.2.0').newer, false);
  assert.equal(core.verifyManifest(sign(release), keys.publicKey, '2.0.0').newer, false);
  assert.equal(core.compareVersions('1.10.0', '1.9.0'), 1);
  assert.throws(() => core.compareVersions('1.2.0-beta', '1.1.0'));
});
test('tampering, foreign publisher and unsafe filenames are rejected', () => {
  const altered = sign(release); altered.release = { ...release, version: '9.0.0' };
  assert.throws(() => core.verifyManifest(altered, keys.publicKey, '1.0.0'), /not signed/);
  const other = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => core.verifyManifest(sign(release), other.publicKey, '1.0.0'), /not signed/);
  assert.throws(() => core.verifyManifest(sign({ ...release, file: '../setup.exe' }), keys.publicKey, '1.0.0'), /filename/);
  assert.throws(() => core.verifyManifest(sign({ ...release, arch: 'arm64' }), keys.publicKey, '1.0.0'), /Windows x64/);
});
test('update feed requires HTTPS and no credentials', () => {
  assert.equal(core.feedUrl('https://github.com/dhaifanco/forge4k/releases/latest/download/forge-update.json'), 'https://github.com/dhaifanco/forge4k/releases/latest/download/forge-update.json');
  assert.throws(() => core.feedUrl('http://example.com/update.json'));
  assert.throws(() => core.feedUrl('https://user:secret@example.com/update.json'));
});
test('download verifies bytes and removes corrupted partial files', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-download-test-'));
  const destination = path.join(folder, 'update.exe');
  const original = global.fetch; let percent;
  try {
    global.fetch = async () => new Response(content);
    await core.downloadInstaller('https://example.com/setup.exe', destination, release, p => { percent = p; });
    assert.equal(percent, 100); await core.verifyInstaller(destination, release);
    fs.unlinkSync(destination);
    global.fetch = async () => new Response(Buffer.alloc(content.length, 7));
    await assert.rejects(core.downloadInstaller('https://example.com/setup.exe', destination, release, () => {}), /verification failed/);
    assert.equal(fs.existsSync(destination), false);
    global.fetch = async () => new Response(null, { status: 302, headers: { location: 'http://example.com/unsafe.exe' } });
    await assert.rejects(core.downloadInstaller('https://example.com/setup.exe', destination, release, () => {}), /HTTPS/);
    global.fetch = async () => new Response('x'.repeat(70000));
    await assert.rejects(core.fetchManifest('https://example.com/update.json'), /too large/);
  } finally { global.fetch = original; }
});
test('offline update checks signature, preserves app data and blocks installation during exports', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-offline-test-'));
  const previous = process.env.FORGE_DATA_DIR;
  process.env.FORGE_DATA_DIR = folder;
  const manifest = path.join(folder, 'forge-update.json');
  fs.writeFileSync(manifest, JSON.stringify(sign(release)));
  fs.writeFileSync(path.join(folder, release.file), content);
  fs.writeFileSync(path.join(folder, 'settings.json'), '{"keep":"yes"}');
  let busy = true, launched = false;
  const updater = require('../desktop/updates.cjs').createUpdates({
    app: { getVersion: () => '1.1.0', quit: () => {} }, getWindow: () => null,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [manifest] }) },
    trustedKey: keys.publicKey, busy: () => busy, beforeInstall: () => {}, launchInstaller: async file => { await core.verifyInstaller(file, release); launched = true; }
  });
  try {
    assert.equal((await updater.importFile()).phase, 'ready');
    await assert.rejects(updater.install(), /Finish or cancel/);
    assert.equal(launched, false);
    await updater.importFile(); busy = false;
    assert.equal((await updater.install()).phase, 'installing');
    assert.equal(launched, true);
    assert.equal(fs.readFileSync(path.join(folder, 'settings.json'), 'utf8'), '{"keep":"yes"}');
  } finally { if (previous == null) delete process.env.FORGE_DATA_DIR; else process.env.FORGE_DATA_DIR = previous; }
});
