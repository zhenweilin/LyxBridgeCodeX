// Disposable native-only benchmark. LYX_CODEX_BINARY can select an older
// engine for a controlled comparison. This never opens a production session.
import {readFile,writeFile,mkdtemp,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {NativeSession} from '../lib/native-session.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
await mkdir(resolve(root,'.native'),{recursive:true});
const directory=await mkdtemp(resolve(root,'.native/scroll-benchmark-'));
const source=await readFile(resolve(root,'demo/demo.lyx'),'utf8');
const paragraphs=Array.from({length:150},(_,i)=>`\\begin_layout Standard\nScroll benchmark paragraph ${i+1}. This is disposable document content for measuring wheel and frame latency.\n\\end_layout\n`).join('\n');
const path=join(directory,'scroll.lyx');
await writeFile(path,source.replace(/\\begin_body[\s\S]*\\end_body/,`\\begin_body\n${paragraphs}\n\\end_body`));
await mkdir(join(directory,'profile'));
process.env.LYX_USER_PROFILE=join(directory,'profile');
const session=new NativeSession(),measurements={};
async function time(name,fn){
  const start=performance.now(),result=await fn();
  if(result.error)throw new Error(result.message??String(result.error));
  (measurements[name]??=[]).push(performance.now()-start);return result;
}
try{
  await session.start(path);
  let frame=await session.call('frame',{width:1100,height:750,serial:-1});
  const before=await session.call('selection');
  for(let i=0;i<50;i++){
    await time('input',()=>session.call('input',{type:'wheel',surface:frame.surfaces[0].id,
      x:300,y:300,deltaMode:0,dx:0,dy:-4,ax:0,ay:-12}));
    await time('state',()=>session.call('state'));
    frame=await time('changedFrame',()=>session.call('frame',{width:1100,height:750,serial:-1}));
    await time('unchangedFrame',()=>session.call('frame',{width:1100,height:750,serial:frame.serial}));
  }
  if((await session.call('selection')).source!==before.source)throw new Error('Scrolling changed the source');
  const summary=Object.fromEntries(Object.entries(measurements).map(([key,values])=>{
    values.sort((a,b)=>a-b);
    return [key,{samples:values.length,medianMs:+values[25].toFixed(2),p95Ms:+values[47].toFixed(2)}];
  }));
  Object.assign(summary,{scope:'native socket, excludes Codex relay and browser presentation',
    framePngBytes:Buffer.from(frame.surfaces[0].png,'base64').length,
    viewport:{width:frame.width,height:frame.height}});
  await writeFile(join(directory,'results.json'),JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify({directory,...summary},null,2));
}finally{session.stop();}
