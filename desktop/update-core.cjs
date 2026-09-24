'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

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
async function httpsResponse(url, signal, headers = {}) {
  let current = feedUrl(url);
  for (let i = 0; i < 6; i++) {
    const response = await fetch(current, { redirect: 'manual', signal, headers: { 'User-Agent': 'Forge-Updater', ...headers } });
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
async function downloadInstaller(url, filename, release, progress = () => {}, options = {}) {
  feedUrl(url);
  if (fs.existsSync(filename)) throw new Error('Update destination already exists.');
  const temporary = filename + '.' + crypto.randomUUID() + '.part';
  const file = await fs.promises.open(temporary, 'wx');
  const chunkSize = options.chunkSize || 4 * 1024 * 1024;
  let received = 0, failures = 0;
  try {
    while (received < release.size) {
      options.signal?.throwIfAborted();
      const controller = new AbortController();
      const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
      let timer;
      const resetTimeout = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new Error('Update connection stalled.')), options.idleTimeoutMs || 20000); };
      let reader;
      try {
        const start = received, end = Math.min(release.size - 1, start + chunkSize - 1);
        resetTimeout();
        const response = await httpsResponse(url, signal, { Range: `bytes=${start}-${end}` });
        let expectedEnd;
        if (response.status === 206) {
          const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
          if (!match || Number(match[1]) !== start || Number(match[2]) !== end || Number(match[3]) !== release.size) {
            await response.body?.cancel(); throw new Error('Invalid update byte range.');
          }
          expectedEnd = end + 1;
        } else if (response.status === 200) {
          // A server may ignore Range. Restart rather than append duplicate bytes.
          received = 0; await file.truncate(0); expectedEnd = release.size;
        } else { await response.body?.cancel(); throw new Error('Unexpected update response.'); }
        reader = response.body.getReader();
        while (true) {
          resetTimeout();
          const { done, value } = await reader.read();
          if (done) break;
          if (received + value.length > expectedEnd) throw new Error('Update exceeds its signed size or requested range.');
          let offset = 0;
          while (offset < value.length) { const written = await file.write(value, offset, value.length - offset, received); offset += written.bytesWritten; received += written.bytesWritten; }
          progress(Math.min(99, Math.floor(received / release.size * 100)));
        }
        if (received !== expectedEnd) throw new Error('Incomplete update response.');
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (++failures > (options.maxRetries ?? 3) || /Invalid update byte range|exceeds|HTTPS|Unexpected/.test(error.message)) throw error;
      } finally { clearTimeout(timer); controller.abort(); if (reader) { try { await reader.cancel(); } catch {} } }
    }
    await file.close();
    await verifyInstaller(temporary, release);
    fs.linkSync(temporary, filename); fs.unlinkSync(temporary);
    progress(100);
  } catch (error) {
    await file.close().catch(() => {});
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}
module.exports = { compareVersions, verifyManifest, verifyInstaller, hashFile, feedUrl, fetchManifest, downloadInstaller };
