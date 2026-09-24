'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { hashFile, compareVersions, feedUrl } = require('../desktop/update-core.cjs');
const root = path.resolve(__dirname, '..');
const keyFile = process.env.FORGE_SIGNING_KEY || path.join(root, '.release-private', 'update-private.pem');
const pubFile = path.join(root, 'desktop', 'update-public.pem');
async function main() {
  if (process.argv.includes('--init')) {
    if (fs.existsSync(pubFile)) {
      if (!fs.existsSync(keyFile)) throw new Error('Restore the original private key. Never replace the public key for an existing release channel.');
      const derived = crypto.createPublicKey(fs.readFileSync(keyFile)).export({ type: 'spki', format: 'pem' });
      if (derived !== fs.readFileSync(pubFile, 'utf8')) throw new Error('Release signing key does not match the trusted public key.');
      console.log('Existing release signing key verified.'); return;
    }
    const keys = crypto.generateKeyPairSync('ed25519');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(pubFile, keys.publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx' });
    console.log('Release key created. Back up .release-private privately; never distribute it.'); return;
  }
  const version = require('../package.json').version;
  compareVersions(version, '0.0.0');
  const file = `Forge-${version}-setup.exe`, installer = path.join(root, 'release', file);
  const notesFile = path.join(root, 'release-notes.txt');
  const release = { appId: 'com.forge.videooptimizer', version, platform: 'win32', arch: 'x64', file,
    size: fs.statSync(installer).size, sha512: await hashFile(installer),
    publishedAt: new Date().toISOString(), notes: fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8').trim() : '' };
  const key = fs.readFileSync(keyFile);
  const derived = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' });
  if (derived !== fs.readFileSync(pubFile, 'utf8')) throw new Error('Signing key mismatch.');
  const signature = crypto.sign(null, Buffer.from(JSON.stringify(release)), key).toString('base64');
  fs.writeFileSync(path.join(root, 'release', 'forge-update.json'), JSON.stringify({ release, signature }, null, 2));
  console.log('Created signed forge-update.json. Share it together with ' + file + '.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
