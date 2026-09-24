'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Transform, Readable } = require('node:stream');

function compareVersions(a, b) {
  const parse = value => {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error('Use a stable version such as 1.2.0.');
    return value.split('.').map(Number);
  };
  const av = parse(a), bv = parse(b);
  for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i] > bv[i] ? 1 : -1;
  return 0;
}
function verifyManifest(envelope, publicKey, currentVersion) {
  if (!envelope || !envelope.release || typeof envelope.signature !== 'string') throw new Error('Not a Forge update manifest.');
  const release = envelope.release;
  if (!crypto.verify(null, Buffer.from(JSON.stringify(release)), publicKey, Buffer.from(envelope.signature, 'base64'))) throw new Error('This update is not signed by the Forge release publisher.');
  if (release.appId !== 'com.forge.videooptimizer' || release.platform !== 'win32' || release.arch !== 'x64') throw new Error('This update is not for Forge on Windows x64.');
  if (!/^Forge-\d+\.\d+\.\d+-setup\.exe$/.test(release.file) || path.basename(release.file) !== release.file) throw new Error('Invalid installer filename.');
  if (!Number.isSafeInteger(release.size) || release.size < 1 || release.size > 2 * 1024 ** 3 || !/^[a-f0-9]{128}$/.test(release.sha512)) throw new Error('Invalid installer verification data.');
  if (typeof release.notes !== 'string' || release.notes.length > 20000) throw new Error('Invalid release notes.');
  return { ...release, newer: compareVersions(release.version, currentVersion) > 0 };
}
async function hashFile(filename) {
  const hash = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
async function verifyInstaller(filename, release) {
  if (fs.statSync(filename).size !== release.size || await hashFile(filename) !== release.sha512) throw new Error('Installer verification failed. Download or copy the update again.');
}
function feedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Use an HTTPS manifest URL without credentials.');
  return url.href;
}
async function httpsResponse(url, signal) {
  let current = feedUrl(url);
  for (let i = 0; i < 6; i++) {
    const response = await fetch(current, { redirect: 'manual', signal, headers: { 'User-Agent': 'Forge-Updater', 'Cache-Control': 'no-cache' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Update server returned an invalid redirect.');
      current = feedUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error('Update server returned HTTP ' + response.status + '.'); }
    return response;
  }
  throw new Error('Too many update redirects.');
}
async function fetchManifest(url) {
  const response = await httpsResponse(url, AbortSignal.timeout(30000));
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 65536) throw new Error('Update manifest is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function downloadInstaller(url, filename, release, progress) {
  const response = await httpsResponse(url, AbortSignal.timeout(15 * 60 * 1000));
  let received = 0;
  const meter = new Transform({ transform(chunk, _encoding, callback) {
    received += chunk.length;
    if (received > release.size) return callback(new Error('Update exceeds its signed size.'));
    progress(Math.round(received / release.size * 100)); callback(null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(filename, { flags: 'wx' }));
    await verifyInstaller(filename, release);
  } catch (error) { try { fs.unlinkSync(filename); } catch {} throw error; }
}
module.exports = { compareVersions, verifyManifest, verifyInstaller, hashFile, feedUrl, fetchManifest, downloadInstaller };
