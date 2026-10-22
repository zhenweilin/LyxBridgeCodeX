import {spawn} from 'node:child_process';
import {mkdir, access, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {availableParallelism} from 'node:os';
const root=fileURLToPath(new URL('..',import.meta.url));
const source=process.env.LYX_SOURCE_DIR?resolve(process.env.LYX_SOURCE_DIR):resolve(root,'.native/lyx-source');
const build=resolve(root,'.native/build-engine');
function run(command,args,capture=false){return new Promise((done,reject)=>{
 const child=spawn(command,args,{cwd:root,stdio:capture?['ignore','pipe','inherit']:'inherit'});let output='';
 if(capture)child.stdout.on('data',data=>output+=data);
 child.once('error',reject);child.once('exit',code=>code===0?done(output.trim()):reject(new Error(`${command} exited with ${code}`)));
});}
await mkdir(resolve(root,'.native'),{recursive:true});
let qt=process.env.LYX_QT_PREFIX;
if(!qt){
 try{qt=await run('qmake',['-query','QT_INSTALL_PREFIX'],true);}
 catch{throw new Error('Set LYX_QT_PREFIX to a Qt 5.15 development installation, or put its qmake on PATH.');}
}
const qtVersion=await run(resolve(qt,'bin/qmake'),['-query','QT_VERSION'],true);
if(!/^5\.15\./.test(qtVersion))throw new Error(`Qt 5.15 is required; found ${qtVersion}.`);
try{await access(resolve(source,'.git'));}catch{
 if(process.env.LYX_SOURCE_DIR)throw new Error('LYX_SOURCE_DIR must be an existing Git checkout of LyX 2.4.1 at the pinned commit.');
 await run('git',['clone','--depth','1','--branch','2.4.1','--single-branch','https://codeberg.org/LyX-org/lyx.git',source]);
}
const commit=await run('git',['-C',source,'rev-parse','HEAD'],true);
if(commit!=='1d25832edcfde1eac543a7b7b82545319d79c1e3')throw new Error('Expected the pinned LyX 2.4.1 source; refusing to patch another revision.');
await run(process.execPath,[resolve(root,'scripts/patch-native.mjs'),source]);
await run('cmake',['-S',source,'-B',build,`-DCMAKE_PREFIX_PATH=${qt}`,'-DLYX_USE_QT=QT5','-DLYX_NLS=OFF','-DLYX_EXTERNAL_Z=ON','-DLYX_EXTERNAL_ICONV=ON','-DCMAKE_BUILD_TYPE=Release','-DLYX_RELEASE=ON','-DLYX_QUIET=ON']);
await run('cmake',['--build',build,'--target','LyX','-j',String(Math.min(6,availableParallelism()))]);
await writeFile(resolve(root,'.native/engine.json'),JSON.stringify({source,commit,binary:resolve(build,'bin/LyX'),library:resolve(source,'lib'),qt},null,2)+'\n');
console.log('Native LyX bridge built successfully.');
