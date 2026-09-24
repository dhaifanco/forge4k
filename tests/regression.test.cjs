'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-regression-'));
process.env.FORGE_DATA_DIR = work;
process.env.FORCE_FFMPEG_DIR = path.resolve('bin');
const p = require('../server/presets');
const store = require('../server/store');
const ff = require('../server/ffmpeg');
const queue = require('../server/queue');
const source = { video: { codec: 'h264', pixFmt: 'yuv420p', width: 1080, height: 1920, fps: 60 }, audio: { codec: 'aac' } };
test('portrait 1080p and 4K dimensions are retained', () => {
  assert.equal(p.decideStrategy(source, p.PRESETS.reels_hq).reencode, false);
  assert.deepEqual(p.geometry({ width: 2160, height: 3840 }, p.PRESETS.tiktok_4k60.target), { width: 2160, height: 3840, changed: false });
  assert.deepEqual(p.geometry({ width: 2160, height: 3840 }, p.PRESETS.reels_hq.target), { width: 1080, height: 1920, changed: true });
});
test('120fps social export is capped; master does not synthesize frames', () => {
  const probe = { ...source, video: { ...source.video, fps: 120 } };
  const rec = p.recommendPreset(probe);
  const preset = p.PRESETS[rec.presetId];
  const strategy = p.decideStrategy(probe, preset);
  assert.equal(strategy.reencodeVideo, true);
  const args = p.buildArgs({ input: 'in', output: 'out', probe, strategy, adv: { target: preset.target, encoder: 'cpu' } });
  assert.ok(args.includes('fps=60'));
  assert.equal(p.geometry({ width: 360, height: 640 }, p.PRESETS.master_4k120.target).changed, false);
});
test('SDR H264 target stays H264 on a 10-bit source', () => {
  const result = p.pickEncoder({ probe: { video: { pixFmt: 'yuv420p10le' } }, adv: { target: p.PRESETS.reels_hq.target }, gpu: { available: true, nvenc: { h264: true, hevc: true } } });
  assert.equal(result.encoder, 'h264_nvenc');
});
test('cleanup preserves unrelated directories and files', () => {
  const dir = store.getSettings().tempDirEffective;
  fs.mkdirSync(path.join(dir, 'unrelated'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'unrelated', 'keep.txt'), 'keep');
  fs.writeFileSync(path.join(dir, 'keep.mp4'), 'keep');
  fs.writeFileSync(path.join(dir, 'job_abc123.part.mp4'), 'partial');
  assert.equal(store.cleanTempDir(0), 1);
  assert.ok(fs.existsSync(path.join(dir, 'unrelated', 'keep.txt')));
  assert.ok(fs.existsSync(path.join(dir, 'keep.mp4')));
});
test('retry transfers ownership and old removal preserves retry input', () => {
  fs.mkdirSync(store.UPLOADS_DIR, { recursive: true });
  const inputPath = path.join(store.UPLOADS_DIR, 'retry.mp4');
  fs.writeFileSync(inputPath, 'fixture');
  const job = queue.enqueue({ inputPath });
  queue.cancel(job.id);
  const retried = queue.retry(job.id);
  queue.remove(job.id);
  assert.ok(fs.existsSync(inputPath));
  queue.cancel(retried.id);
  queue.remove(retried.id);
  assert.equal(fs.existsSync(inputPath), false);
  assert.deepEqual(queue.listJobs(), []);
});
test('progress survives split stdout writes', async () => {
  const blocks = [];
  const result = await ff.runBin(process.execPath, ['-e', "process.stdout.write('frame=10\\nout_time_us=1000\\n'); setTimeout(()=>process.stdout.write('progress=end\\n'),60)", '--', 'ignored'], { onProgressKv: kv => blocks.push(kv), timeoutMs: 5000 });
  assert.equal(result.code, 0);
  assert.deepEqual(blocks, [{ frame: '10', out_time_us: '1000', progress: 'end' }]);
});
test('removing an active job leaves queue listing usable', async () => {
  const originalLocate = ff.locateBinaries, originalProbe = ff.probe;
  let release;
  ff.locateBinaries = async () => ({ ok: true });
  ff.probe = () => new Promise(resolve => { release = resolve; });
  try {
    const job = queue.enqueue({ inputPath: path.join(work, 'mock.mp4'), keepInput: true });
    const pumping = queue.pump();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(queue.getJob(job.id).state, 'processing');
    queue.remove(job.id);
    release({ ok: false, error: 'interrupted fixture' });
    await pumping;
    assert.deepEqual(queue.listJobs(), []);
  } finally { ff.locateBinaries = originalLocate; ff.probe = originalProbe; }
});
test('real SDR encode and HDR tone mapping decode successfully', async () => {
  const bin = path.resolve('bin/ffmpeg.exe');
  const input = path.join(work, 'pq.mp4');
  execFileSync(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=256x448:r=120:d=0.2', '-vf', 'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error:pools=1', '-pix_fmt', 'yuv420p10le', '-colorspace', 'bt2020nc', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', input], { windowsHide: true, timeout: 60000, stdio: 'pipe' });
  const raw = await ff.probe(input);
  assert.equal(raw.ok, true);
  const probe = ff.normalizeProbe(raw.data, input);
  for (const preset of [p.PRESETS.reels_hq, p.PRESETS.master_4k120]) {
    const output = path.join(work, preset.id + '.mp4');
    const strategy = p.decideStrategy(probe, preset);
    const args = p.buildArgs({ input, output, probe, strategy, adv: { target: preset.target, encoder: 'cpu', x264Preset: 'ultrafast' } });
    execFileSync(bin, args, { windowsHide: true, timeout: 60000, stdio: 'pipe' });
    const after = ff.normalizeProbe((await ff.probe(output)).data, output);
    assert.equal(after.video.resolution, '256x448');
    assert.equal(after.video.fps, preset.id === 'reels_hq' ? 60 : 120);
    assert.equal(after.video.colorTransfer, preset.id === 'reels_hq' ? 'bt709' : 'smpte2084');
    assert.equal(after.video.pixFmt, preset.id === 'reels_hq' ? 'yuv420p' : 'yuv420p10le');
    assert.equal((await ff.validatePlayback(output)).ok, true);
  }
});
test('audio-only files are rejected before recommendation', async () => {
  const input = path.join(work, 'audio.wav');
  execFileSync(path.resolve('bin/ffmpeg.exe'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=duration=0.1', input], { windowsHide: true, stdio: 'pipe' });
  const result = await ff.probe(input);
  assert.equal(result.ok, false);
  assert.match(result.error, /no usable video/);
});
