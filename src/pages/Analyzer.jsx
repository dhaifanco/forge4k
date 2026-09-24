import React from 'react';
import { api } from '../api';
import { Card, Spec, Badge, DropZone, ErrorBar, Icon } from '../ui.jsx';
export default function Analyzer() {
  const [info, setInfo] = React.useState(null), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
  async function inspect(file) { setBusy(true); setError(''); try { setInfo(await api.analyze(file)); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  const v = info?.video, a = info?.audio;
  return <div className="page"><header className="page-head"><div><div className="eyebrow">Know your source</div><h1>Video Analyzer</h1><p className="page-sub">Inspect the file before making export decisions.</p></div>{info && <DropZone compact label="Inspect another video" onFile={inspect} busy={busy}/>}</header><ErrorBar>{error}</ErrorBar>
    {busy ? <div className="loading-state" role="status"><span className="spinner"/>Reading media specifications</div> : !info ? <DropZone onFile={inspect} label="Choose a video to inspect"/> : <>
      <Card title={info.file.name} right={<Badge>{info.format.container?.toUpperCase()}</Badge>}><div className="spec-grid"><Spec label="Resolution" value={v.resolution}/><Spec label="Frame rate" value={v.fps ? v.fps + ' fps' : null}/><Spec label="Duration" value={info.format.durationHuman}/><Spec label="File size" value={info.file.size?.human}/></div></Card>
      <div className="grid-2"><Card title="Video"><div className="spec-grid"><Spec label="Codec" value={v.codecLong || v.codec}/><Spec label="Profile" value={v.profile}/><Spec label="Pixel format" value={v.pixFmt}/><Spec label="Bit depth" value={v.bitDepth ? v.bitDepth + '-bit' : null}/><Spec label="Bitrate" value={v.bitrate}/><Spec label="Scan type" value={v.fieldOrder}/></div></Card>
      <Card title="Color" right={<Badge kind={v.isHdr ? 'warn' : 'info'}>{v.isHdr ? 'HDR tags detected' : 'No HDR tags detected'}</Badge>}><div className="spec-grid"><Spec label="Color space" value={v.colorSpace}/><Spec label="Transfer function" value={v.colorTransfer}/><Spec label="Primaries" value={v.colorPrimaries}/><Spec label="Chroma location" value={v.chromaLocation}/></div><p className="settings-note">Missing tags do not establish a color standard. Tagged HDR is tone-mapped by the social presets and preserved by the master presets.</p></Card></div>
      <div className="grid-2"><Card title="Audio">{a ? <div className="spec-grid"><Spec label="Codec" value={a.codec}/><Spec label="Sample rate" value={a.sampleRate}/><Spec label="Channels" value={a.channelLayout || a.channels}/><Spec label="Bitrate" value={a.bitrate}/></div> : <p className="muted">This video has no audio stream.</p>}</Card>
      <Card title="Export considerations"><ul className="health-list"><li className="finding"><Icon name="film" size={17}/><span>{v.codec === 'h264' ? 'H.264 source. Compatible presets can avoid another video encode.' : 'Social presets may convert this codec to H.264.'}</span></li><li className="finding"><Icon name="history" size={17}/><span>{v.fps > 60 ? 'Above 60fps. Use a master preset to preserve higher frame rates.' : 'Source cadence is kept unless the selected preset requires a cap.'}</span></li><li className="finding"><Icon name="scan" size={17}/><span>Preset scaling preserves aspect ratio and does not upscale smaller footage.</span></li></ul></Card></div>
      <Card title="Container metadata"><pre className="meta-json">{Object.keys(info.metadata || {}).length ? JSON.stringify(info.metadata, null, 2) : 'No container tags reported.'}</pre></Card>
    </>}
  </div>;
}
