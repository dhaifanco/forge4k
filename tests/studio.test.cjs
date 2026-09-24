'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
process.env.FORCE_FFMPEG_DIR=path.resolve('bin');
process.env.FORGE_DATA_DIR=path.resolve('.test-data','studio-'+Date.now());
const studio=require('../server/studio'),ai=require('../server/enhance'),ff=require('../server/ffmpeg'),store=require('../server/store'),{PRESETS}=require('../server/presets');
const root=process.env.FORGE_DATA_DIR;fs.mkdirSync(root,{recursive:true});
test('studio options validate, portrait plans fit and saved recipes round trip',()=>{
  assert.throws(()=>studio.options({face:2}));assert.throws(()=>studio.options({crop:'invented'}));assert.throws(()=>studio.options({stabilize:7}));
  const p=ai.plan({video:{width:1920,height:1080,fps:30},format:{durationSec:12}},PRESETS.reels_hq,{crop:'follow',face:.2});
  assert.equal(p.width,606);assert.equal(p.height,1080);assert.equal(p.enabled,true);
  studio.saveRecipe({name:'Camera',preset:'reels_hq',enhance:{face:.2,crop:'manual',cropX:.2}});
  assert.equal(studio.recipes()[0].enhance.cropX,.2);studio.deleteRecipe('Camera');assert.equal(studio.recipes().length,0);
});
test('real export resumes validated checkpoints without re-rendering and preserves audio duration',async()=>{
  const bins=await ff.locateBinaries(),input=path.join(root,'input.mp4');
  const r=await ff.runBin(bins.ffmpegPath,['-y','-f','lavfi','-i','testsrc2=size=192x128:rate=30','-f','lavfi','-i','sine=frequency=440','-t','5.4','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',input]);assert.equal(r.code,0);
  const probe=ff.normalizeProbe((await ff.probe(input)).data,input),job={id:'job_checkpointtest',logLines:[]};
  let child;Object.defineProperty(job,'child',{set(c){child=c;job.pauseRequested=true;},get(){return child;},configurable:true});
  const context={input,output:path.join(root,'output.mp4'),probe,preset:PRESETS.reels_hq,adv:{encoder:'cpu',target:PRESETS.reels_hq.target,enhance:{}},job,tempRoot:root,bins};
  const strategy={reencode:true,reencodeVideo:true,reencodeAudio:true};
  const first=await studio.render(context,strategy);assert.equal(first.paused,true);assert.equal(job.checkpoint.completed,1);
  const checkpoint=path.join(store.DATA_DIR,'checkpoints',job.id,'0.mp4'),mtime=fs.statSync(checkpoint).mtimeMs;
  delete job.child;job.pauseRequested=false;
  // A fresh job object represents resuming after reopening the desktop application.
  context.job={id:job.id,logLines:[]};
  const resumed=await studio.render(context,strategy);assert.equal(resumed.code,0);assert.equal(fs.statSync(checkpoint).mtimeMs,mtime);
  const output=ff.normalizeProbe((await ff.probe(context.output)).data,context.output);
  assert.ok(output.audio);assert.ok(Math.abs(output.format.durationSec-5.4)<.12,output.format.durationSec);assert.equal((await ff.validatePlayback(context.output)).ok,true);
  studio.discard(context.job);assert.equal(fs.existsSync(checkpoint),false);
});
test('smart mode inspects low-light samples and real framing/stabilization outputs decode',async()=>{
  const bins=await ff.locateBinaries(),input=path.join(root,'dark.mp4');
  assert.equal((await ff.runBin(bins.ffmpegPath,['-y','-f','lavfi','-i','color=black:size=192x128:rate=30:duration=0.2','-c:v','libx264',input])).code,0);
  const probe=ff.normalizeProbe((await ff.probe(input)).data,input),smart=await studio.smart(input,probe);assert.ok(smart.brightness<65);assert.equal(smart.enhance.fps,0);assert.equal(smart.enhance.denoise,'ai');
  const output=path.join(root,'framed.mp4');
  await ai.render({input,output,probe,preset:PRESETS.reels_hq,adv:{encoder:'cpu',enhance:{crop:'manual',cropX:.8,stabilize:5}},job:{logLines:[]},tempRoot:root,bins});
  const after=ff.normalizeProbe((await ff.probe(output)).data,output);assert.equal(after.video.width,72);assert.equal(after.video.height,128);assert.equal((await ff.validatePlayback(output)).ok,true);
});
test('multiple destinations retain their shared source and sample compression is a real playable file',async()=>{
  store.saveSettings({outDir:path.join(root,'batch-output'),preferGpu:false});
  const queue=require('../server/queue'),server=await require('../server/index').startServer(0),base='http://127.0.0.1:'+server.address().port;
  const request=async(url,body)=>{const r=await fetch(base+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;};
  const wait=async id=>{for(let i=0;i<100;i++){const job=await request('/api/queue/'+id);if(['completed','failed'].includes(job.state)){assert.equal(job.state,'completed',job.error);return job;}await new Promise(r=>setTimeout(r,100));}throw new Error('Export timed out');};
  try{
    const form=new FormData();form.append('files',new Blob([fs.readFileSync(path.join(root,'input.mp4'))]),'camera.mp4');
    const imported=await(await fetch(base+'/api/analyze-batch',{method:'POST',body:form})).json(),uploadId=imported.items[0].uploadId,source=path.join(store.UPLOADS_DIR,uploadId);
    const first=await request('/api/optimize-id',{uploadId,preset:'tiktok_1080p60',adv:{encoder:'cpu',keepSource:true}});await wait(first.jobId);assert.ok(fs.existsSync(source));
    const second=await request('/api/optimize-id',{uploadId,preset:'reels_hq',adv:{encoder:'cpu',preview:true,sampleStart:.4}});
    await fetch(base+'/api/uploads/'+uploadId,{method:'DELETE'});const job=await wait(second.jobId);assert.equal(fs.existsSync(source),false);
    assert.equal(job.result.preview,true);assert.ok(Math.abs(job.result.afterSpecs.format.durationSec-5)<.1);
    const simulated=await request('/api/queue/'+second.jobId+'/compression',{});
    const video=await fetch(base+simulated.url,{headers:{Range:'bytes=0-99'}});assert.equal(video.status,206);await video.arrayBuffer();
    const file=queue.getJob(second.jobId).compressionPath;assert.equal((await ff.validatePlayback(file)).ok,true);
    queue.remove(second.jobId);assert.equal(fs.existsSync(file),false);
  }finally{queue.shutdown();await new Promise(r=>server.close(r));}
});
