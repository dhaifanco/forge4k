'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
process.env.FORGE_DATA_DIR=path.resolve('.test-data','api-regression-'+Date.now());
process.env.FORCE_FFMPEG_DIR=path.resolve('bin');
const store=require('../server/store'),ff=require('../server/ffmpeg'),queue=require('../server/queue');
test('API survives invalid media and async errors, cleans staging and protects active sources',async()=>{
  fs.mkdirSync(store.DATA_DIR,{recursive:true});
  const audio=path.join(store.DATA_DIR,'audio.wav'),video=path.join(store.DATA_DIR,'video.mp4');
  execFileSync(path.resolve('bin/ffmpeg.exe'),['-v','error','-f','lavfi','-i','sine=duration=0.1',audio],{windowsHide:true});
  execFileSync(path.resolve('bin/ffmpeg.exe'),['-v','error','-f','lavfi','-i','color=size=64x96:rate=30:duration=0.1','-c:v','libx264',video],{windowsHide:true});
  const server=await require('../server/index').startServer(0),base='http://127.0.0.1:'+server.address().port;
  const send=async(endpoint,files,field='files')=>{const form=new FormData();for(const file of files)form.append(field,new Blob([fs.readFileSync(file)]),path.basename(file));const r=await fetch(base+endpoint,{method:'POST',body:form});return {status:r.status,body:await r.json()};};
  try{
    assert.equal((await send('/api/analyze',[audio],'file')).status,422);
    const batch=await send('/api/analyze-batch',[audio,video]);assert.equal(batch.status,200);assert.equal(batch.body.items[0].ok,false);assert.ok(batch.body.items[1].uploadId);
    const id=batch.body.items[1].uploadId,input=path.join(store.UPLOADS_DIR,id);assert.equal(fs.readdirSync(store.UPLOADS_DIR).length,1);
    const owner={id:'test-owner',state:'waiting',_payload:{inputPath:input,keepInput:true}};queue.JOBS.set(owner.id,owner);
    assert.throws(()=>queue.enqueue({inputPath:input,presetId:'remux'}),/active export/);
    assert.equal((await fetch(base+'/api/uploads/'+id,{method:'DELETE'})).status,200);assert.equal(owner._payload.keepInput,false);assert.ok(fs.existsSync(input));
    queue.JOBS.delete(owner.id);await fetch(base+'/api/uploads/'+id,{method:'DELETE'});assert.equal(fs.existsSync(input),false);
    const original=ff.probe;ff.probe=async()=>{throw new Error('Controlled probe failure');};
    try{const failed=await send('/api/analyze',[video],'file');assert.equal(failed.status,500);assert.match(failed.body.error,/Controlled/);}finally{ff.probe=original;}
    assert.equal(fs.readdirSync(store.UPLOADS_DIR).length,0);
    const malformed=await fetch(base+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'});assert.equal(malformed.status,400);assert.ok((await malformed.json()).error);
    assert.equal((await fetch(base+'/api/health')).status,200);
  }finally{queue.shutdown();await new Promise(resolve=>server.close(resolve));}
});
test('SDR tags are not HDR and fractional frame rates/time carry are parsed correctly',()=>{
  for(const transfer of ['smpte170m','bt709'])assert.equal(ff.normalizeProbe({streams:[{codec_type:'video',width:64,height:96,color_transfer:transfer,color_primaries:'bt2020'}]},'absent.mp4').video.isHdr,false);
  assert.equal(ff.fracToFps('30'),30);assert.equal(ff.fracToFps('30000/1001'),29.97);assert.equal(ff.fracToFps('1/0'),null);
  assert.equal(ff.fmtDur(59.8),'1m 0s');assert.equal(ff.fmtDur(0),'0s');
});
test('startup cleanup removes stale AI workspaces but preserves live and unrelated directories',()=>{
  const root=store.getSettings().tempDirEffective;
  const stale=path.join(root,'forge-ai-abc123'),live=path.join(root,'forge-ai-def456'),unrelated=path.join(root,'user-project');
  for(const folder of [stale,live,unrelated])fs.mkdirSync(folder,{recursive:true});
  fs.writeFileSync(path.join(live,'owner.json'),JSON.stringify({pid:process.pid}));
  for(const folder of [stale,live,unrelated])fs.utimesSync(folder,new Date(0),new Date(0));
  store.cleanTempDir(1000);assert.equal(fs.existsSync(stale),false);assert.ok(fs.existsSync(live));assert.ok(fs.existsSync(unrelated));
});
