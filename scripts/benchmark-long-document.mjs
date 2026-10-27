// Native-only measurements; excludes the host relay and browser presentation.
// Run baseline and candidate sequentially with the same fixture and viewport.
// LYX_CODEX_BINARY selects a saved baseline without replacing live sessions.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {NativeSession} from '../lib/native-session.mjs';
import {longDocument} from '../test/fixtures/long-document.mjs';

await mkdir('.native',{recursive:true});
const directory=await mkdtemp(resolve('.native/long-document-benchmark-'));
const source=await readFile('test/fixtures/demo.lyx','utf8');
await mkdir(join(directory,'profile'));process.env.LYX_USER_PROFILE=join(directory,'profile');
const results=[];
for(const paragraphs of [150,3000]){
  const path=join(directory,`long-${paragraphs}.lyx`),fixture=longDocument(source,paragraphs);
  await writeFile(path,fixture);
  const session=new NativeSession(),times={},size={width:1100,height:750};
  async function measure(name,method,params={}){
    const start=performance.now(),result=await session.call(method,params);
    assert.ok(!result.error,result.message??String(result.error));
    (times[name]??=[]).push(performance.now()-start);return result;
  }
  try{
    await session.start(path);
    let frame=await session.call('frame',{...size,serial:-1});
    const before=await session.call('selection'),surface=frame.surfaces.find(item=>item.main).id;
    for(let i=0;i<50;i++){
      const start=performance.now();
      await measure('wheelInput','input',{type:'wheel',surface,x:300,y:300,deltaMode:0,dx:0,dy:-4});
      await measure('postInputState','state');
      frame=await measure('changedFrame','frame',{...size,serial:-1});
      (times.wheelCycle??=[]).push(performance.now()-start);
      await measure('unchangedFrame','frame',{...size,serial:frame.serial});
    }
    await session.call('command',{command:'buffer-begin'});
    frame=await session.call('frame',{...size,serial:-1});
    const p=frame.inputMethod.rect,y=p.y+Math.floor(p.height/2);
    await session.call('input',{type:'pointerdown',surface,x:p.x+2,y,button:0,buttons:1});
    await session.call('state');
    for(let i=0;i<50;i++){
      const start=performance.now();
      await measure('dragInput','input',{type:'pointermove',surface,x:p.x+100+i*3,y,button:0,buttons:1});
      await measure('dragState','state');await measure('dragFrame','frame',{...size,serial:-1});
      (times.dragCycle??=[]).push(performance.now()-start);
    }
    await session.call('input',{type:'pointerup',surface,x:p.x+247,y,button:0,buttons:0});
    assert.equal((await session.call('state')).hasSelection,true);
    for(let i=0;i<5;i++)await measure('fullSnapshot','selection');
    assert.equal((await session.call('selection')).source,before.source);
    assert.equal(await readFile(path,'utf8'),fixture);
    const summary=Object.fromEntries(Object.entries(times).map(([name,values])=>{
      const sorted=[...values].sort((a,b)=>a-b);
      return [name,{samples:values.length,medianMs:+sorted[Math.floor(values.length/2)].toFixed(2),
        p95Ms:+sorted[Math.floor(values.length*.95)].toFixed(2)}];
    }));
    results.push({paragraphs,bytes:Buffer.byteLength(fixture),viewport:size,summary});
  }finally{session.stop();}
}
const result={scope:'native socket; excludes Codex relay and browser presentation',results};
await writeFile(join(directory,'results.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({directory,...result},null,2));
