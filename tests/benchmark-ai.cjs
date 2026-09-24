'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
process.env.FORCE_FFMPEG_DIR=path.resolve('bin');
process.env.FORGE_DATA_DIR=path.resolve('.test-data','benchmark-ai');
const ff=require('../server/ffmpeg'),ai=require('../server/enhance'),{PRESETS}=require('../server/presets');
(async()=>{
  const label=process.argv[2]||'current',root=process.env.FORGE_DATA_DIR;fs.mkdirSync(root,{recursive:true});
  const input=path.join(root,'source.mp4'),bins=await ff.locateBinaries();
  if(!fs.existsSync(input)){const made=await ff.runBin(bins.ffmpegPath,['-y','-f','lavfi','-i','testsrc2=size=192x108:rate=30','-t','0.5','-c:v','libx264','-pix_fmt','yuv420p',input]);assert.equal(made.code,0);}
  const probe=ff.normalizeProbe((await ff.probe(input)).data,input),stages=[],job={logLines:[],cancelRequested:false};let phase;
  Object.defineProperty(job,'phase',{get:()=>phase,set:value=>{phase=value;stages.push({phase:value,time:Date.now()});}});
  const output=path.join(root,label+'.mp4'),start=Date.now();
  await ai.render({input,output,probe,preset:PRESETS.master_4k120,adv:{enhance:{scale:2,fps:120},encoder:'cpu'},job,tempRoot:root,bins});
  const result={label,seconds:(Date.now()-start)/1000,input:'192x108, 30fps, 0.5 seconds',output:'384x216, 120fps',stages};
  assert.equal((await ff.validatePlayback(output)).ok,true);fs.writeFileSync(path.join(root,label+'.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
})().catch(e=>{console.error(e);process.exitCode=1});
