// Hold an edge selection for 40 seconds in a disposable copy of the 25-page
// demo. This measures the native socket, not the host relay or browser display.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {NativeSession} from '../lib/native-session.mjs';

await mkdir('.native',{recursive:true});
const directory=await mkdtemp(resolve('.native/sustained-selection-'));
await mkdir(join(directory,'profile'));process.env.LYX_USER_PROFILE=join(directory,'profile');
const path=join(directory,'demo.lyx');
const source=await readFile('demo/long-document/interaction-demo-25-pages.lyx');
await writeFile(path,source);
const session=new NativeSession(),samples=[],size={width:1100,height:750};
try{
  await session.start(path);
  const original=(await session.call('selection')).source;
  const beginning=await session.call('command',{command:'buffer-begin'});
  assert.ok(!beginning.error,beginning.message);
  let frame=await session.call('frame',{...size,serial:-1});
  const surface=frame.surfaces.find(item=>item.main),rect=surface.scrollViewport,p=frame.inputMethod.rect;
  await session.call('input',{type:'pointerdown',surface:surface.id,x:p.x+2,y:p.y+Math.floor(p.height/2),button:0,buttons:1});
  await session.call('state');
  const x=350,y=rect.y+rect.height+20;
  await session.call('input',{type:'pointermove',surface:surface.id,x,y,button:0,buttons:1});
  const start=performance.now();let nextMemory=0,rss=0;
  while(performance.now()-start<40000){
    const elapsed=performance.now()-start;
    const a=performance.now(),state=await session.call('state'),stateMs=performance.now()-a;
    const b=performance.now();frame=await session.call('frame',{...size,serial:frame.serial});
    const frameMs=performance.now()-b;
    if(elapsed>=nextMemory){
      rss=Number(execFileSync('ps',['-o','rss=','-p',String(session.process.pid)],{encoding:'utf8'}).trim());
      nextMemory+=5000;
    }
    samples.push({elapsed,stateMs,frameMs,chars:state.selection.length,rss});
    await new Promise(done=>setTimeout(done,16));
  }
  await session.call('input',{type:'pointerup',surface:surface.id,x,y,button:0,buttons:0});
  const final=await session.call('state');
  assert.ok(final.hasSelection && final.selection.length>10000,'The hold must grow a substantial selection');
  assert.equal((await session.call('selection')).source,original);
  assert.deepEqual(await readFile(path),source);
  // Releasing the button must stop the native autoscroll timer as well.
  await new Promise(done=>setTimeout(done,300));
  const settled=await session.call('state');
  assert.deepEqual(settled.selectionStart,final.selectionStart);
  assert.deepEqual(settled.selectionEnd,final.selectionEnd);
  const buckets=[];
  await writeFile(join(directory,'samples.json'),JSON.stringify(samples,null,2)+'\n');
  for(let i=0;i<8;i++){
    const rows=samples.filter(row=>row.elapsed>=i*5000 && row.elapsed<(i+1)*5000);
    if(!rows.length){buckets.push({seconds:`${i*5}-${(i+1)*5}`,samples:0});continue;}
    const quantile=(field,q)=>{
      const values=rows.map(row=>row[field]).sort((a,b)=>a-b);
      return +values[Math.floor(values.length*q)].toFixed(2);
    };
    buckets.push({seconds:`${i*5}-${(i+1)*5}`,samples:rows.length,selectionChars:rows.at(-1).chars,
      rssKiB:rows.at(-1).rss,stateMedian:quantile('stateMs',.5),stateP95:quantile('stateMs',.95),
      stateMax:Math.max(...rows.map(row=>row.stateMs)),frameMedian:quantile('frameMs',.5),frameP95:quantile('frameMs',.95),
      frameMax:Math.max(...rows.map(row=>row.frameMs))});
  }
  const result={scope:'native socket; excludes host relay and browser presentation',buckets};
  await writeFile(join(directory,'results.json'),JSON.stringify({samples,...result},null,2)+'\n');
  console.log(JSON.stringify({directory,...result},null,2));
}finally{session.stop();}
