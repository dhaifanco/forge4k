'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
process.env.FORCE_FFMPEG_DIR=path.resolve('bin');
process.env.FORGE_DATA_DIR=path.resolve('.test-data','ai-real-'+Date.now());
const ff=require('../server/ffmpeg'),ai=require('../server/enhance'),{PRESETS}=require('../server/presets');
(async()=>{
  const root=process.env.FORGE_DATA_DIR;fs.mkdirSync(root,{recursive:true});
  const bins=await ff.locateBinaries(),input=path.join(root,'source.mp4'),output=path.join(root,'enhanced.mp4');
  const created=await ff.runBin(bins.ffmpegPath,['-y','-f','lavfi','-i','testsrc2=size=64x96:rate=30','-f','lavfi','-i','sine=frequency=440','-t','0.2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',input]);
  assert.equal(created.code,0);
  const probe=ff.normalizeProbe((await ff.probe(input)).data,input),job={logLines:[],cancelRequested:false};
  await ai.render({input,output,probe,preset:PRESETS.master_4k120,adv:{enhance:{scale:2,fps:120,denoise:'gentle'},encoder:'cpu'},job,tempRoot:root,bins});
  const after=ff.normalizeProbe((await ff.probe(output)).data,output);
  assert.equal(after.video.width,128);assert.equal(after.video.height,192);assert.equal(after.video.fps,120);assert.ok(after.audio);assert.ok(Math.abs(after.format.durationSec-probe.format.durationSec)<.08);
  assert.equal((await ff.validatePlayback(output)).ok,true);
  assert.equal(fs.readdirSync(root).some(n=>n.startsWith('forge-ai-')),false);
  const cancelled={logLines:[],cancelRequested:false};
  Object.defineProperty(cancelled,'child',{set(child){if(this.phase==='AI detail enhancement')setTimeout(()=>{this.cancelRequested=true;child.kill();},30);}});
  await assert.rejects(ai.render({input,output:path.join(root,'cancelled.mp4'),probe,preset:PRESETS.reels_hq,adv:{enhance:{scale:2},encoder:'cpu'},job:cancelled,tempRoot:root,bins}),/Cancelled/);
  assert.equal(fs.readdirSync(root).some(n=>n.startsWith('forge-ai-')),false);
  const store=require('../server/store');store.saveSettings({outDir:path.join(root,'exports'),preferGpu:false});
  const server=await require('../server/index').startServer(0),base='http://127.0.0.1:'+server.address().port;
  try{
    const request=async(url,body)=>{const response=await fetch(base+url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data};
    const form=new FormData();form.append('files',new Blob([fs.readFileSync(input)]),'source.mp4');
    const imported=await(await fetch(base+'/api/analyze-batch',{method:'POST',body:form})).json();
    const uploadId=imported.items[0].uploadId;
    const submitted=await request('/api/optimize-id',{uploadId,preset:'master_4k120',adv:{preview:true,enhance:{scale:2,fps:120},encoder:'cpu'}});
    let queued;
    for(let i=0;i<240;i++){queued=await request('/api/queue/'+submitted.jobId);if(['completed','failed','cancelled'].includes(queued.state))break;await new Promise(r=>setTimeout(r,250));}
    assert.equal(queued.state,'completed',queued.error);assert.equal(queued.result.preview,true);assert.equal(queued.result.afterSpecs.video.codec,'h264');
    assert.ok(fs.existsSync(path.join(store.UPLOADS_DIR,uploadId)),'sample must retain staged original');
    const media=await fetch(base+'/api/queue/'+queued.id+'/video',{headers:{Range:'bytes=0-99'}});assert.equal(media.status,206);await media.arrayBuffer();
  }finally{require('../server/queue').shutdown();await new Promise(r=>server.close(r));}
  fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({output,after,log:job.logLines},null,2));
  console.log('REAL AI PASS:',output,after.video.resolution,after.video.fps,'fps; audio and decode verified');
})().catch(e=>{console.error(e);process.exitCode=1});
