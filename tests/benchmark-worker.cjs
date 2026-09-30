'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),assert=require('node:assert/strict');
const root=path.resolve('.test-data','core-speed');fs.mkdirSync(root,{recursive:true});
const legacy=path.join(root,'legacy-worker.py');
fs.writeFileSync(legacy,execFileSync('git',['show','e71d7c3:server/studio-worker.py']));
const source=path.join(root,'source');fs.mkdirSync(source,{recursive:true});
execFileSync(path.resolve('bin/ai/python/python.exe'),['-c',"from skimage.data import astronaut; import cv2,sys; from pathlib import Path; p=Path(sys.argv[1]); image=cv2.cvtColor(cv2.resize(astronaut(),(256,256)),cv2.COLOR_RGB2BGR); [cv2.imwrite(str(p/f'{i+1:08}.png'),image) for i in range(8)]",source],{windowsHide:true});
const results={frames:8,resolution:'256x256',faceStrength:.3,denoise:'ai'};
for(const [name,python,worker,device] of [
  ['legacyCpu',path.resolve('bin/ai/python/python.exe'),legacy,'cpu'],
  ['currentGpu',path.resolve('bin/ai/runtime/python.exe'),path.resolve('server/studio-worker.py'),'auto'],
]) {
  const output=path.join(root,name);fs.mkdirSync(output,{recursive:true});
  const config=path.join(root,name+'.json');
  fs.writeFileSync(config,JSON.stringify({models:path.resolve('bin/ai/models'),input:source,output,face:.3,denoise:'ai',inferenceDevice:device}));
  const start=performance.now();
  const logs=execFileSync(python,[worker,config],{windowsHide:true,encoding:'utf8',timeout:180000,maxBuffer:2e6});
  results[name]={seconds:(performance.now()-start)/1000,logs};
  assert.equal(fs.readdirSync(output).filter(n=>n.endsWith('.png')).length,8);
  assert.match(logs,/"faces": 8/);
  console.log(name,results[name].seconds.toFixed(3)+'s');
}
results.speedup=results.legacyCpu.seconds/results.currentGpu.seconds;
fs.writeFileSync(path.join(root,'benchmark.json'),JSON.stringify(results,null,2));
console.log('Restoration stage including model startup:',results.speedup.toFixed(2)+'x');
