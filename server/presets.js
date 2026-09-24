'use strict';
const social = { vcodec: 'h264', pixFmt: 'yuv420p', acodec: 'aac', color: 'sdr', maxFps: 60, audioKbps: 192 };
const PRESETS = {
  remux: { id: 'remux', name: 'Lossless Remux', group: 'Universal', mode: 'remux', icon: 'shield', description: 'Copy source video and audio without re-encoding.' },
  tiktok_ultra: { id: 'tiktok_ultra', name: 'TikTok Quality', group: 'TikTok', mode: 'smart', icon: 'zap', description: 'Up to 4K60 H.264 SDR. Platform compression still applies.', target: { ...social, shortEdge: 2160, longEdge: 3840, maxKbps: 60000 } },
  tiktok_1080p60: { id: 'tiktok_1080p60', name: 'TikTok 1080p60', group: 'TikTok', mode: 'smart', icon: 'zap', description: 'Up to 1080x1920 portrait or 1920x1080 landscape, SDR, up to 60fps. No upscaling.', target: { ...social, shortEdge: 1080, longEdge: 1920, maxKbps: 20000 } },
  tiktok_4k60: { id: 'tiktok_4k60', name: 'TikTok 4K60', group: 'TikTok', mode: 'smart', icon: 'zap', description: 'Up to 2160x3840 portrait or 3840x2160 landscape at 60fps. Playback quality is controlled by TikTok.', target: { ...social, shortEdge: 2160, longEdge: 3840, maxKbps: 60000 } },
  reels_hq: { id: 'reels_hq', name: 'Instagram Reels HQ', group: 'Instagram', mode: 'smart', icon: 'zap', description: 'Up to 1080x1920, source cadence up to 60fps, H.264 SDR and AAC.', target: { ...social, shortEdge: 1080, longEdge: 1920, maxKbps: 24000, audioKbps: 128 } },
  shorts_hq: { id: 'shorts_hq', name: 'YouTube Shorts HQ', group: 'YouTube', mode: 'smart', icon: 'zap', description: 'Up to 4K60 H.264 SDR with AAC. Aspect ratio preserved.', target: { ...social, shortEdge: 2160, longEdge: 3840, maxKbps: 60000 } },
  master_4k120: { id: 'master_4k120', name: 'Master 4K120', group: 'Master', mode: 'smart', icon: 'archive', description: 'HEVC master up to 4K120. Preserves HDR and source cadence; does not invent frames or bypass social compression.', target: { vcodec: 'hevc', acodec: 'aac', color: 'preserve', shortEdge: 2160, longEdge: 3840, maxFps: 120, maxKbps: 120000 } },
  archive_master: { id: 'archive_master', name: 'Archive Master', group: 'Master', mode: 'smart', icon: 'archive', description: 'HEVC master preserving source resolution, frame rate and HDR.', target: { vcodec: 'hevc', acodec: 'aac', color: 'preserve' } }
};
function listPresets() { return Object.values(PRESETS).map(({ target, ...p }) => p); }
function is10Bit(p) { return /10|12|16/.test(String(p || '')); }
function isHdrish(v) { return !!v && /smpte2084|arib-std-b67/.test(String(v.colorTransfer || '')); }
function geometry(v, t = {}) {
  let w = v.width, h = v.height;
  if (Math.abs(Number(v.rotation) || 0) % 180 === 90) [w, h] = [h, w];
  const ratio = t.shortEdge ? Math.min(1, t.shortEdge / Math.min(w, h), t.longEdge / Math.max(w, h)) : 1;
  return { width: Math.max(2, Math.floor(w * ratio / 2) * 2), height: Math.max(2, Math.floor(h * ratio / 2) * 2), changed: ratio < 1 || w % 2 !== 0 || h % 2 !== 0 };
}
function outputPixel(v, t, adv = {}) {
  if (t.color === 'sdr' || adv.sdrConvert) return 'yuv420p';
  return t.pixFmt || (is10Bit(v.pixFmt) || isHdrish(v) ? 'yuv420p10le' : 'yuv420p');
}
function decideStrategy(probe, preset, adv = {}) {
  const v = probe.video, a = probe.audio;
  if (!v || !v.width || !v.height) throw new Error('The input has no usable video stream.');
  if (preset.mode === 'remux' || adv.forceRemux) return { reencode: false, reason: 'Stream copy: source video and audio preserved.' };
  const t = preset.target || {}, reasons = [], g = geometry(v, t);
  let video = false, audio = false;
  const need = text => { video = true; reasons.push(text); };
  if (t.vcodec && v.codec !== t.vcodec) need('video to ' + t.vcodec);
  if (v.pixFmt !== outputPixel(v, t, adv)) need('pixel format conversion');
  if (g.changed) need('fit ' + g.width + 'x' + g.height);
  if (t.maxFps && v.fps > t.maxFps + 0.001) need('cap frame rate to ' + t.maxFps);
  if ((t.color === 'sdr' || adv.sdrConvert) && (isHdrish(v) || /bt2020/.test(v.colorPrimaries || ''))) need('convert source color to BT.709 SDR');
  if (t.color === 'sdr' && v.fieldOrder && !['progressive', 'unknown'].includes(v.fieldOrder)) need('deinterlace');
  if (t.maxKbps && Number(v.bitrateKbps) > t.maxKbps) need('limit video bitrate');
  if (a && (a.codec !== t.acodec || (t.color === 'sdr' && (a.channels > 2 || parseInt(a.sampleRate) > 48000 || parseInt(a.bitrate) > (t.audioKbps || 192))))) { audio = true; reasons.push('normalize AAC audio'); }
  return { reencode: video || audio, reencodeVideo: video, reencodeAudio: audio, reason: reasons.length ? reasons.join('; ') + '.' : 'Source meets this target; stream copy avoids generation loss.' };
}
function pickEncoder({ probe, adv = {}, gpu }) {
  const codec = (adv.target || {}).vcodec === 'hevc' ? 'hevc' : 'h264';
  const available = gpu && gpu.available && gpu.nvenc && gpu.nvenc[codec];
  return adv.encoder !== 'cpu' && available ? { codec, encoder: codec + '_nvenc', accel: 'gpu' } : { codec, encoder: codec === 'hevc' ? 'libx265' : 'libx264', accel: 'cpu' };
}
function ceilingKbps(codec, edge) { return edge > 1080 ? 80000 : 20000; }
function nvencPixFmt(p) { return is10Bit(p) ? 'p010le' : 'yuv420p'; }
function nvencProfile(codec, p) { return codec === 'hevc' ? (is10Bit(p) ? 'main10' : 'main') : 'high'; }
function buildArgs({ input, output, probe, strategy, adv = {} }) {
  const args = ['-hide_banner', '-nostdin', '-y'];
  if (adv.genpts) args.push('-fflags', '+genpts');
  args.push('-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-dn', '-sn', '-map_chapters', '-1');
  if (adv.stripMetadata !== false) args.push('-map_metadata', '-1');
  const v = probe.video, t = adv.target || {};
  if (!strategy.reencode) args.push('-c', 'copy');
  else {
    if (strategy.reencodeVideo) {
      const enc = pickEncoder({ probe, adv, gpu: adv.gpu });
      const pix = outputPixel(v, t, adv), g = geometry(v, t), filters = [];
      const sdr = t.color === 'sdr' || adv.sdrConvert;
      if (sdr && v.fieldOrder && !['progressive', 'unknown'].includes(v.fieldOrder)) filters.push('bwdif=mode=send_frame:parity=auto:deint=interlaced');
      if (sdr && isHdrish(v)) filters.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=mobius:desat=2', 'zscale=t=bt709:m=bt709:r=limited', 'format=yuv420p');
      else if (sdr && /bt2020/.test(v.colorPrimaries || '')) filters.push('zscale=p=bt709:t=bt709:m=bt709:r=limited', 'format=yuv420p');
      if (g.changed) filters.push('scale=' + g.width + ':' + g.height + ':flags=lanczos');
      if (t.maxFps && v.fps > t.maxFps + 0.001) filters.push('fps=' + t.maxFps);
      if (filters.length) args.push('-vf', filters.join(','));
      args.push('-c:v', enc.encoder);
      if (enc.accel === 'gpu') args.push('-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', String(adv.nvencCq || 19), '-b:v', '0', '-spatial-aq', '1');
      else args.push('-preset', adv.x264Preset || 'slow', '-crf', String(adv.crf == null ? 18 : adv.crf));
      args.push('-pix_fmt', enc.accel === 'gpu' ? nvencPixFmt(pix) : pix, '-profile:v', nvencProfile(enc.codec, pix));
      if (enc.codec === 'hevc') args.push('-tag:v', 'hvc1');
      const ceiling = t.maxKbps || adv.bitrateCeilingKbps;
      if (ceiling) args.push('-maxrate', ceiling + 'k', '-bufsize', ceiling * 2 + 'k');
      if (sdr && (isHdrish(v) || /bt2020/.test(v.colorPrimaries || ''))) args.push('-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv');
      else for (const [flag, value] of [['-colorspace', v.colorSpace], ['-color_primaries', v.colorPrimaries], ['-color_trc', v.colorTransfer]]) { if (value && value !== 'unknown') args.push(flag, value); }
    } else args.push('-c:v', 'copy');
    if (strategy.reencodeAudio) args.push('-c:a', 'aac', '-b:a', (t.audioKbps || 192) + 'k', '-ar', '48000', '-ac', '2');
    else args.push('-c:a', 'copy');
  }
  args.push('-movflags', '+faststart', '-f', 'mp4', output);
  return args;
}
function recommendPreset(probe) {
  const preset = PRESETS.tiktok_1080p60, strategy = decideStrategy(probe, preset);
  return { presetId: preset.id, confidence: 'high', reasons: [strategy.reason, 'Choose Master 4K120 separately for high frame rate local playback.'] };
}
module.exports = { PRESETS, listPresets, decideStrategy, buildArgs, pickEncoder, recommendPreset, ceilingKbps, nvencPixFmt, nvencProfile, is10Bit, isHdrish, geometry };
