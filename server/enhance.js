'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ff = require('./ffmpeg');
const presets = require('./presets');

function engineRoot() { return path.join(process.env.FORCE_FFMPEG_DIR || path.join(__dirname, '..', 'bin'), 'ai'); }
function status() {
  const root = engineRoot();
  const present = files => files.every(file => fs.existsSync(path.join(root,file)));
  return { upscale: present(['esrgan/realesrgan-ncnn-vulkan.exe','esrgan/vcomp140.dll','esrgan/models/realesrgan-x4plus.bin','esrgan/models/realesrgan-x4plus.param']),
    interpolate: present(['rife/rife-ncnn-vulkan.exe','rife/vcomp140.dll','rife/rife-v4.6/flownet.bin','rife/rife-v4.6/flownet.param']) };
}
function options(value = {}) {
  if (!value || typeof value !== 'object') throw new Error('Invalid enhancement options.');
  const scale = Number(value.scale ?? 1), fps = Number(value.fps ?? 0), denoise = value.denoise ?? 'off';
  if (![1, 2, 4].includes(scale) || ![0, 60, 120].includes(fps) || !['off', 'gentle'].includes(denoise)) throw new Error('Unsupported enhancement setting.');
  return { scale, fps, denoise, enabled: scale > 1 || fps > 0 || denoise !== 'off' };
}
function plan(probe, preset, value, preview = false) {
  const opt = options(value), v = probe.video, target = preset.target || {};
  if (!v?.width || !v?.height || !Number.isFinite(v.fps) || v.fps <= 0) throw new Error('A readable video frame rate is required.');
  if (opt.enabled && preset.mode === 'remux') throw new Error('Choose a TikTok, Reels or Master preset for enhancement.');
  if (opt.fps && opt.fps > (target.maxFps || 120)) throw new Error('Choose Master 4K120 to export interpolated 120fps.');
  const duration = preview ? Math.min(5, probe.format.durationSec) : probe.format.durationSec;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('A readable video duration is required.');
  const cap = { shortEdge: target.shortEdge || 2160, longEdge: target.longEdge || 3840 };
  const dimensions = presets.geometry({ ...v, width: v.width * opt.scale, height: v.height * opt.scale }, cap);
  const fps = opt.fps || Math.min(v.fps, target.maxFps || 120);
  if (opt.fps && opt.fps < v.fps - .01) throw new Error('Interpolation must not lower the source frame rate. Use Keep source instead.');
  const frames = Math.ceil(duration * Math.min(v.fps, fps)) + 2;
  const pixels = v.width * v.height;
  const neural = opt.scale > 1 || fps > v.fps + .01;
  const scratchBytes = neural ? Math.ceil(frames * pixels * 4 * (opt.scale > 1 ? 17 : 1) + Math.ceil(duration * fps + 2) * dimensions.width * dimensions.height * 4 + 256 * 1024 ** 2) : 0;
  return { ...opt, ...dimensions, fps, sourceFps: v.fps, duration, preview: !!preview, scratchBytes,
    color: 'BT.709 SDR', codec: preview ? 'h264' : target.vcodec || 'h264', reason: [opt.scale > 1 && 'Real-ESRGAN detail enhancement', opt.fps > v.fps + .01 && 'RIFE frame interpolation', opt.denoise !== 'off' && 'gentle temporal noise reduction', 'SDR output'].filter(Boolean).join('; ') + '.' };
}
function cleanup(folder, root) {
  const resolved = path.resolve(folder), parent = path.resolve(root);
  if (path.dirname(resolved) !== parent || !/^forge-ai-[a-f0-9-]+$/.test(path.basename(resolved))) throw new Error('Invalid enhancement workspace.');
  fs.rmSync(resolved, { recursive: true, force: true });
}
async function render({ input, output, probe, preset, adv, job, tempRoot, bins }) {
  const p = plan(probe, preset, adv.enhance, adv.preview), engines = status();
  if (p.scale > 1 && !engines.upscale || p.fps > p.sourceFps + .01 && !engines.interpolate) throw new Error('AI engine files are missing. Install the full Forge desktop build.');
  fs.mkdirSync(tempRoot, { recursive: true });
  const disk = fs.statfsSync(tempRoot);
  if (Number(disk.bavail) * Number(disk.bsize) < p.scratchBytes) throw new Error('Not enough temporary disk space. Allow about ' + Math.ceil(p.scratchBytes / 1024 ** 3) + ' GB, or try the 5-second sample.');
  const folder = fs.mkdtempSync(path.join(tempRoot, 'forge-ai-'));
  // mkdtemp uses mixed-case characters; rename to a strictly validated cleanup identifier.
  const work = path.join(tempRoot, 'forge-ai-' + crypto.randomUUID()); fs.renameSync(folder, work);
  const stage = name => { job.phase = name; job.progress = null; job.logLines.push(name); };
  async function run(bin, args, isFfmpeg = false, directory = null, expected = 0) {
    if (job.cancelRequested) throw new Error('Cancelled');
    const started = Date.now();
    const update = done => { const elapsed = (Date.now() - started) / 1000; job.progress = { pct: expected ? Math.min(99, Math.floor(done / expected * 100)) : null, frame: done, speed: elapsed > 0 && done ? (done / elapsed).toFixed(1) + ' frames/s' : null, elapsedMs: Date.now() - started, etaSec: done > 0 && expected ? Math.ceil(elapsed / done * Math.max(0, expected - done)) : null }; };
    const timer = setInterval(() => { if(directory){try{update(fs.readdirSync(directory).filter(n=>n.endsWith('.png')).length);}catch{}} },1000);
    let result;
    try { result = await ff.runBin(bin, args, { progress: isFfmpeg, timeoutMs: 24 * 60 * 60 * 1000,
      onSpawn: child => { job.child = child; if (job.cancelRequested) child.kill(); },
      onProgressKv: kv => { if(kv.frame) update(Number(kv.frame)); },
      onLog: text => { job.logLines.push(text.slice(-1000)); if (job.logLines.length > 200) job.logLines.splice(0, job.logLines.length - 200); } });
    } finally { clearInterval(timer); }
    if (job.cancelRequested) throw new Error('Cancelled');
    if (result.code !== 0) throw new Error('Enhancement failed: ' + (result.error || result.stderr.slice(-700) || result.code));
    return result;
  }
  try {
    fs.writeFileSync(path.join(work,'owner.json'),JSON.stringify({pid:process.pid}));
    const source = path.join(work, 'source'); fs.mkdirSync(source);
    const filters = [];
    if (probe.video.fieldOrder && !['progressive','unknown'].includes(probe.video.fieldOrder)) filters.push('bwdif=mode=send_frame:parity=auto:deint=interlaced');
    if (presets.isHdrish(probe.video)) filters.push('zscale=t=linear:npl=100','format=gbrpf32le','zscale=p=bt709','tonemap=tonemap=mobius:desat=2','zscale=t=bt709:m=bt709:r=limited');
    else if (/bt2020/.test(probe.video.colorPrimaries || '')) filters.push('zscale=p=bt709:t=bt709:m=bt709:r=limited');
    if (p.denoise === 'gentle') filters.push('hqdn3d=1:1:3:3');
    const encoder = presets.pickEncoder({ probe, adv: { ...adv, target: {vcodec:p.codec} }, gpu: adv.gpu });
    function outputArgs() {
      const args = ['-c:v',encoder.encoder];
      if (encoder.accel === 'gpu') args.push('-preset','p6','-rc','vbr','-cq','18','-b:v','0');
      else args.push('-preset','medium','-crf','18');
      if (p.codec === 'hevc') args.push('-tag:v','hvc1');
      const ceiling = preset.target?.maxKbps;
      if (ceiling) args.push('-maxrate',ceiling+'k','-bufsize',(ceiling*2)+'k');
      args.push('-c:a','aac','-b:a',String(preset.target?.audioKbps || 192)+'k','-ar','48000','-ac','2','-map_metadata','-1','-map_chapters','-1','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-movflags','+faststart',output);
      return args;
    }
    if (p.scale === 1 && p.fps <= p.sourceFps + .01) {
      stage('Encoding with noise reduction');
      return await run(bins.ffmpegPath,['-hide_banner','-nostdin','-y','-i',input,'-map','0:v:0','-map','0:a:0?','-t',String(p.duration),'-vf',[...filters,`fps=${p.fps}`,`scale=${p.width}:${p.height}:flags=lanczos`,'format=yuv420p'].join(','),...outputArgs()],true,null,Math.ceil(p.duration*p.fps));
    }
    filters.push('fps=' + Math.min(p.sourceFps, p.fps), 'format=rgb24');
    stage('Preparing AI frames');
    await run(bins.ffmpegPath, ['-hide_banner','-nostdin','-y','-i',input,'-t',String(p.duration),'-an','-vf',filters.join(','),'-start_number','1',path.join(source,'%08d.png')], true,null,Math.ceil(p.duration*Math.min(p.sourceFps,p.fps)));
    let images = source;
    let count = fs.readdirSync(images).filter(n => n.endsWith('.png')).length;
    if (!count) throw new Error('No frames could be decoded.');
    if (p.scale > 1) {
      const enhanced = path.join(work,'detail'); fs.mkdirSync(enhanced);
      stage('AI detail enhancement');
      await run(path.join(engineRoot(),'esrgan','realesrgan-ncnn-vulkan.exe'), ['-i',images,'-o',enhanced,'-m',path.join(engineRoot(),'esrgan','models'),'-n','realesrgan-x4plus','-s','4','-t','128','-j','1:1:1','-f','png'],false,enhanced,count);
      if (fs.readdirSync(enhanced).filter(n => n.endsWith('.png')).length !== count) throw new Error('Upscaling produced an incomplete frame sequence.');
      const scaled = path.join(work,'scaled'); fs.mkdirSync(scaled);
      stage('Sizing enhanced frames');
      await run(bins.ffmpegPath,['-hide_banner','-nostdin','-y','-framerate',String(Math.min(p.sourceFps,p.fps)),'-start_number','1','-i',path.join(enhanced,'%08d.png'),'-vf',`scale=${p.width}:${p.height}:flags=lanczos`,'-start_number','1',path.join(scaled,'%08d.png')],true,null,count);
      // Both paths are fixed children of this freshly created, validated job workspace.
      cleanupChild(enhanced,work); cleanupChild(source,work);
      images=scaled;
    }
    if (p.fps > p.sourceFps + .01) {
      if (count < 2) throw new Error('Interpolation needs at least two source frames.');
      const interpolated = path.join(work, 'motion'); fs.mkdirSync(interpolated);
      stage('AI motion interpolation');
      const desired = Math.max(2, Math.round((count - 1) * p.fps / p.sourceFps) + 1);
      const rifeArgs = ['-i',images,'-o',interpolated,'-m',path.join(engineRoot(),'rife','rife-v4.6'),'-n',String(desired),'-j','1:1:1','-f','%08d.png'];
      if (Math.min(p.width,p.height)>1080) rifeArgs.push('-u');
      await run(path.join(engineRoot(),'rife','rife-ncnn-vulkan.exe'), rifeArgs,false,interpolated,desired);
      const actual = fs.readdirSync(interpolated).filter(n => n.endsWith('.png')).length;
      if (actual !== desired) throw new Error('Interpolation produced an incomplete frame sequence.');
      images = interpolated; count = actual;
    }
    stage('Encoding enhanced video');
    const args = ['-hide_banner','-nostdin','-y','-framerate',String(p.fps),'-start_number','1','-i',path.join(images,'%08d.png'),'-i',input,'-map','0:v:0','-map','1:a:0?','-t',String(p.duration),'-vf',`scale=${p.width}:${p.height}:flags=lanczos,tpad=stop_mode=clone:stop_duration=1,format=yuv420p`,...outputArgs()];
    return await run(bins.ffmpegPath,args,true,null,Math.ceil(p.duration*p.fps));
  } finally { cleanup(work,tempRoot); }
}
module.exports = { status, options, plan, render, cleanup };
function cleanupChild(folder,root) {
  if(path.dirname(path.resolve(folder))!==path.resolve(root)||!['source','detail'].includes(path.basename(folder))) throw new Error('Invalid frame workspace.');
  fs.rmSync(folder,{recursive:true,force:true});
}
