'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..','bin','ai'),source=path.join(root,'python'),dest=path.join(root,'runtime');
const packages=['numpy','numpy.libs','cv2','onnxruntime'];
const hashes={'face.onnx':'9f92bea7c59abc6c442c070a91849673571d25ac8f6987fb8902fbd843ab712f','denoise.onnx':'aecf19d7de402a6e55d5a3092d96f60dd47e90517b33cff0d25e9615d0c9b4e6'};
for(const [name,hash] of Object.entries(hashes)) {
  const file=path.join(root,'models',name);
  if(!fs.existsSync(file)||crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==hash)throw new Error('Verified ONNX model missing: '+name);
}
fs.mkdirSync(dest,{recursive:true});
const copy=(from,to)=>fs.cpSync(from,to,{recursive:true,filter:file=>!file.split(path.sep).includes('__pycache__')&&!file.endsWith('.pyc')});
for(const file of fs.readdirSync(source,{withFileTypes:true}))if(file.isFile()&&!file.name.endsWith('.pyc'))copy(path.join(source,file.name),path.join(dest,file.name));
const libs=path.join(source,'Lib','site-packages'),target=path.join(dest,'Lib','site-packages');
fs.mkdirSync(target,{recursive:true});
for(const name of packages)copy(path.join(libs,name),path.join(target,name));
for(const name of fs.readdirSync(libs))if(/^(numpy-|opencv_python|onnxruntime_directml-).*\.dist-info$/.test(name))copy(path.join(libs,name),path.join(target,name));
console.log('Prepared portable ONNX runtime with upstream licenses; training libraries stay in the development environment.');
