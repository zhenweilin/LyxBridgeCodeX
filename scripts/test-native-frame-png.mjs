import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
let qt=process.env.LYX_QT_PREFIX;
if(!qt){
  try{qt=JSON.parse(await readFile(join(root,'.native/engine.json'),'utf8')).qt;}catch{}
}
const qmake=qt?join(qt,'bin/qmake'):'qmake';
const directory=await mkdtemp(join(tmpdir(),'lyx-frame-png-test-'));
function run(command,args){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:directory,stdio:'inherit'});
    child.once('error',reject);
    child.once('exit',code=>code===0?resolve():reject(new Error(`${command} exited with ${code}`)));
  });
}
// qmake paths are quoted separately from shell syntax; spawn never uses a shell.
function quote(value){
  if(/[\r\n"$]/.test(value))throw new Error('Unsupported qmake path characters');
  return `"${value}"`;
}
try{
  await writeFile(join(directory,'encoder.pro'),`QT = core gui
CONFIG += console c++17 release
CONFIG -= app_bundle debug
TARGET = encoder-test
SOURCES = ${quote(join(root,'test/native-frame-png.cpp'))}
INCLUDEPATH += ${quote(join(root,'native'))}
LIBS += -lz
`);
  await run(qmake,['encoder.pro']);
  await run('make',['-j2']);
  await run(join(directory,'encoder-test'),process.argv.slice(2).map(path=>resolve(path)));
}finally{
  await rm(directory,{recursive:true,force:true});
}
