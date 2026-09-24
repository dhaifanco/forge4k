'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
process.env.FORGE_DATA_DIR = path.resolve('.test-data/api-' + Date.now());
process.env.FORCE_FFMPEG_DIR = path.resolve('bin');
process.env.FORGE_API_TOKEN = 'isolated-api-test';
const store = require('../server/store');
const ff = require('../server/ffmpeg');
async function main() {
  store.ensureDir(store.DATA_DIR);
  store.saveSettings({ outDir: path.join(store.DATA_DIR, 'output'), preferGpu: false });
  const fixture = path.join(store.DATA_DIR, 'Master 4K120.mp4');
  execFileSync(path.resolve('bin/ffmpeg.exe'), ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=2160x3840:r=120', '-frames:v', '6', '-c:v', 'libx264', '-preset', 'ultrafast', fixture], { stdio: 'pipe', windowsHide: true, timeout: 120000 });
  const server = await require('../server/index').startServer(0);
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(url, options = {}) {
    const r = await fetch(base + url, { ...options, headers: { 'X-Forge-Token': process.env.FORGE_API_TOKEN, ...options.headers } });
    const body = await r.json();
    assert.ok(r.ok, JSON.stringify(body)); return body;
  }
  try {
    assert.equal((await fetch(base + '/api/health')).status, 403);
    assert.equal((await request('/api/health')).ffmpegReady, true);
    assert.equal((await request('/api/presets')).presets.length, 8);
    const form = new FormData(); form.append('files', new Blob([fs.readFileSync(fixture)]), path.basename(fixture));
    const analyzed = (await request('/api/analyze-batch', { method: 'POST', body: form })).items[0];
    assert.equal(analyzed.file.name, 'Master 4K120.mp4');
    const submit = await request('/api/optimize-id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId: analyzed.uploadId, preset: 'master_4k120', adv: { encoder: 'cpu', x264Preset: 'ultrafast' } }) });
    let job;
    for (let i = 0; i < 120; i++) {
      job = await request('/api/queue/' + submit.jobId);
      if (['completed', 'failed', 'cancelled'].includes(job.state)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(job.state, 'completed', job.error);
    assert.equal(job.result.afterSpecs.video.resolution, '2160x3840');
    assert.equal(job.result.afterSpecs.video.fps, 120);
    assert.equal(job.result.afterSpecs.video.codec, 'hevc');
    assert.equal(job.result.mode, 're-encode');
    assert.ok(job.result.output.name.startsWith('Master 4K120'));
    assert.equal(job.result.validation.ok, true);
    assert.equal((await request('/api/history')).items.length, 1);
    assert.equal((await ff.validatePlayback(job.result.output.path)).ok, true);
    console.log('PASS: authenticated API, batch import, original filename, actual portrait 4K120 export, decode validation and history.');
    fs.writeFileSync(path.join(store.DATA_DIR, 'result.json'), JSON.stringify(job.result, null, 2));
  } finally { require('../server/queue').shutdown(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
