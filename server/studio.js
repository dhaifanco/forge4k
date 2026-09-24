'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ff = require('./ffmpeg');
const store = require('./store');
const { PRESETS, buildArgs } = require('./presets');

function options(value = {}) {
  const face = Number(value.face ?? 0), cropX = Number(value.cropX ?? .5), cropY = Number(value.cropY ?? .5);
  const crop = value.crop ?? 'off', motionGuard = value.motionGuard ?? 'cuts', stabilize = Number(value.stabilize ?? 0);
  if (![face,cropX,cropY].every(n=>Number.isFinite(n)&&n>=0&&n<=1) || ![0,5,10].includes(stabilize) || !['off','center','manual','follow'].includes(crop) || !['off','cuts','conservative'].includes(motionGuard)) throw new Error('Unsupported studio setting.');
  return {face,cropX,cropY,crop,motionGuard,stabilize};
}
function runtime() {
  const root = path.join(process.env.FORCE_FFMPEG_DIR || path.join(__dirname,'..','bin'),'ai');
  return { python: path.join(root,'python','python.exe'), models: path.join(root,'models') };
}
function capabilities() {
  const r=runtime(), python=fs.existsSync(r.python)&&fs.existsSync(path.join(path.dirname(r.python),'Lib','site-packages','cv2','__init__.py'));
  return {tracking:python,face:python&&fs.existsSync(path.join(r.models,'GFPGANv1.4.pth')),denoise:python&&fs.existsSync(path.join(r.models,'realesr-general-x4v3.pth'))};
}
function workerArgs(config, folder) {
  const file=path.join(folder,'studio-task.json');
  fs.writeFileSync(file,JSON.stringify({...config,models:runtime().models}));
  const script=path.join(__dirname,'studio-worker.py').replace(/app\.asar([\\/])/,'app.asar.unpacked$1');
  return [script,file];
}
async function smart(input, probe) {
  const bins=await ff.locateBinaries();
  const result=await ff.runBin(bins.ffmpegPath,['-hide_banner','-nostdin','-i',input,'-t','5','-an','-vf','scale=320:-2,signalstats,metadata=print','-f','null','-'],{timeoutMs:30000});
  if(result.code!==0)throw new Error('Could not inspect sample brightness.');
  const values=[...result.stderr.matchAll(/lavfi\.signalstats\.YAVG=(\d+(?:\.\d+)?)/g)].map(m=>Number(m[1]));
  const brightness=values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
  const lowLight=brightness!==null&&brightness<65;
  const cap=capabilities(), edge=Math.min(probe.video.width,probe.video.height);
  return {preset:'tiktok_1080p60',enhance:{scale:edge<720?2:1,fps:0,denoise:lowLight?(cap.denoise?'ai':'gentle'):'off',...options()},
    reasons:[edge<720?'Small source: suggest 2× detail.':'Keep source detail to avoid unnecessary processing.',lowLight?'The first five seconds are dark; suggest noise reduction.':'Sample brightness does not call for automatic denoising.','Keep source motion to avoid interpolation artifacts.'],brightness, sampledSeconds:Math.min(5,probe.format.durationSec)};
}
const recipesFile=path.join(store.DATA_DIR,'recipes.json');
function recipes(){return store.readJSON(recipesFile,[]);}
function saveRecipe(value) {
  const name=String(value.name||'').trim();
  if(!name||name.length>60||!PRESETS[value.preset])throw new Error('Give the preset a name (1–60 characters) and a valid destination.');
  const enhance=require('./enhance').options(value.enhance);
  const items=recipes().filter(r=>r.name!==name);
  if(items.length>=30)throw new Error('Delete a saved preset before adding another.');
  items.push({name,preset:value.preset,enhance,encoder:value.encoder==='cpu'?'cpu':'auto'});
  store.writeJSON(recipesFile,items);return items;
}
function deleteRecipe(name){const items=recipes().filter(r=>r.name!==name);store.writeJSON(recipesFile,items);return items;}

function checkpointDir(job){
  if(!/^job_[a-z0-9]+$/.test(job.id))throw new Error('Invalid export checkpoint.');
  return path.join(store.DATA_DIR,'checkpoints',job.id);
}
function discard(job){const dir=checkpointDir(job);if(fs.existsSync(dir))fs.rmSync(dir,{recursive:true,force:true});}
async function render(context, strategy) {
  const {job,input,output,probe,preset,adv,bins}=context;
  const folder=checkpointDir(job);fs.mkdirSync(folder,{recursive:true});
  const manifest=path.join(folder,'checkpoint.json');
  const {gpu,encoderResolved,accelLabel,...stableAdv}=adv;
  const signature=JSON.stringify({schema:1,input,size:fs.statSync(input).size,mtime:fs.statSync(input).mtimeMs,preset:preset.id,adv:stableAdv});
  let state=store.readJSON(manifest,{signature,completed:[]});
  if(state.signature!==signature)throw new Error('Source or settings changed. Remove this job and export again.');
  const duration=adv.preview?Math.min(5,probe.format.durationSec):probe.format.durationSec;
  const sourceStart=adv.preview?Math.max(0,Math.min(Number(adv.sampleStart)||0,probe.format.durationSec-duration)):0;
  const outputFps=adv.enhance?.fps||Math.min(probe.video.fps,preset.target?.maxFps||probe.video.fps);
  const segment=Math.max(1,Math.round(5*outputFps))/outputFps, total=Math.ceil(duration/segment);
  job.checkpoint={completed:state.completed.length,total};
  for(let i=0;i<total;i++) {
    if(job.cancelRequested)throw new Error('Cancelled');
    if(job.pauseRequested) {job.state='paused';job.status='paused';return {paused:true};}
    const file=path.join(folder,`${i}.mp4`);
    if(state.completed.includes(i)&&fs.existsSync(file)&&fs.statSync(file).size>0)continue;
    const length=Math.min(segment,duration-i*segment), start=sourceStart+i*segment;
    const partProbe={...probe,format:{...probe.format,durationSec:length}};
    job.phase=`Rendering section ${i+1} of ${total}`;
    job.logLines.push(job.phase);
    const enhance=require('./enhance');
    let result;
    if(enhance.options(adv.enhance).enabled)result=await enhance.render({...context,output:file,probe:partProbe,preset:adv.preview?{...preset,target:{...preset.target,vcodec:'h264'}}:preset,adv:{...adv,preview:false,segmentStart:start,videoOnly:true}});
    else {
      const args=buildArgs({input,output:file,probe:partProbe,strategy,adv});
      args.splice(args.indexOf('-i'),0,'-ss',String(start));
      args.splice(args.length-1,0,'-t',String(length),'-an');
      result=await ff.runBin(bins.ffmpegPath,args,{timeoutMs:24*60*60*1000,onSpawn:child=>{job.child=child;if(job.cancelRequested)child.kill();},onProgressKv:kv=>{job.progress={pct:Math.min(99,Math.round((Number(kv.out_time_us)||0)/1e6/length*100)),speed:kv.speed};}});
    }
    if(job.cancelRequested)throw new Error('Cancelled');
    if(result.code!==0)throw new Error(result.stderr?.slice(-500)||'Export section failed.');
    const valid=await ff.validatePlayback(file,{durationSec:length,onSpawn:child=>{job.child=child;if(job.cancelRequested)child.kill();}});
    if(!valid.ok)throw new Error('Checkpoint failed playback validation.');
    state.completed=Array.from(new Set([...state.completed,i]));store.writeJSON(manifest,state);
    job.checkpoint={completed:state.completed.length,total};
  }
  if(job.pauseRequested){job.state='paused';job.status='paused';return {paused:true};}
  job.phase='Joining completed sections';
  const list=path.join(folder,'sections.txt');
  fs.writeFileSync(list,Array.from({length:total},(_,i)=>`file '${i}.mp4'`).join('\n'));
  return ff.runBin(bins.ffmpegPath,['-hide_banner','-nostdin','-y','-f','concat','-safe','1','-i',list,'-ss',String(sourceStart),'-i',input,'-map','0:v:0','-map','1:a:0?','-t',String(duration),'-c:v','copy','-c:a','aac','-b:a',String(preset.target?.audioKbps||192)+'k','-ar','48000','-ac','2','-map_metadata','-1','-map_chapters','-1','-movflags','+faststart',output],{timeoutMs:3600000,onSpawn:child=>{job.child=child;if(job.cancelRequested)child.kill();}});
}
module.exports={options,runtime,capabilities,workerArgs,smart,recipes,saveRecipe,deleteRecipe,render,discard};
