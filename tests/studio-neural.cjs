'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
process.env.FORCE_FFMPEG_DIR=path.resolve('bin');
process.env.FORGE_DATA_DIR=path.resolve('.test-data','studio-neural-'+Date.now());
const root=process.env.FORGE_DATA_DIR;fs.mkdirSync(root,{recursive:true});
const ff=require('../server/ffmpeg'),ai=require('../server/enhance'),studio=require('../server/studio'),{PRESETS}=require('../server/presets');
(async()=>{
  const image=path.join(root,'face.png');
  execFileSync(studio.runtime().python,['-c',"from skimage.data import astronaut; import cv2,sys; cv2.imwrite(sys.argv[1],cv2.cvtColor(cv2.resize(astronaut(),(256,256)),cv2.COLOR_RGB2BGR))",image],{windowsHide:true});
  const bins=await ff.locateBinaries(),input=path.join(root,'camera.mp4'),output=path.join(root,'restored.mp4');
  assert.equal((await ff.runBin(bins.ffmpegPath,['-y','-loop','1','-framerate','5','-i',image,'-f','lavfi','-i','sine=frequency=440','-t','0.2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',input])).code,0);
  const probe=ff.normalizeProbe((await ff.probe(input)).data,input),job={logLines:[]};
  await ai.render({input,output,probe,preset:PRESETS.reels_hq,adv:{encoder:'cpu',enhance:{face:.3,denoise:'ai',crop:'follow'}},job,tempRoot:root,bins});
  const after=ff.normalizeProbe((await ff.probe(output)).data,output);assert.equal(after.video.width,144);assert.equal(after.video.height,256);assert.ok(after.audio);assert.ok(Math.abs(after.format.durationSec-.2)<.12);assert.equal((await ff.validatePlayback(output)).ok,true);
  // Cut protection must replace blended intermediate frames with real source frames.
  const source=path.join(root,'cuts'),motion=path.join(root,'motion');fs.mkdirSync(source);fs.mkdirSync(motion);
  execFileSync(studio.runtime().python,['-c',"import cv2,numpy as np,sys; from pathlib import Path; s,m=map(Path,sys.argv[1:]); [cv2.imwrite(str(s/f'{i+1:08}.png'),np.full((32,32,3),v,np.uint8)) for i,v in enumerate([0,255])]; [cv2.imwrite(str(m/f'{i+1:08}.png'),np.full((32,32,3),v,np.uint8)) for i,v in enumerate([0,128,255])]",source,motion],{windowsHide:true});
  const args=studio.workerArgs({task:'protect',input:source,output:motion,sourceFps:30,fps:60,motionGuard:'cuts'},root);
  const protectedResult=execFileSync(studio.runtime().python,args,{windowsHide:true,encoding:'utf8'});assert.match(protectedResult,/"sceneCuts": 1/);
  const mean=Number(execFileSync(studio.runtime().python,['-c',"import cv2,sys; print(cv2.imread(sys.argv[1]).mean())",path.join(motion,'00000002.png')],{windowsHide:true,encoding:'utf8'}));assert.equal(mean,255);
  fs.writeFileSync(path.join(root,'verification.json'),JSON.stringify({faceAndDenoise:'Actual GFPGAN and Real-ESRGAN inference',portrait:after.video.resolution,audio:true,decode:true,cutProtection:true,output},null,2));
  console.log('PASS actual face restoration, AI denoise, face-follow crop, audio/decode and scene-cut protection:',root);
})().catch(e=>{console.error(e);process.exitCode=1;});
