import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {NativeSession} from '../lib/native-session.mjs';

test('native frame caching refreshes pixels, metadata, resize and dialog surfaces',{timeout:60000},async()=>{
  const directory=await mkdtemp(resolve('.native/frame-integration-')),path=join(directory,'demo.lyx');
  await copyFile('demo/demo.lyx',path);
  const session=new NativeSession();
  const frame=(serial=-1,width=1000)=>session.call('frame',{width,height:650,serial});
  const eventually=async predicate=>{for(let i=0;i<25;i++){const result=await frame();if(predicate(result))return result;
    await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('Expected native frame state');};
  try{
    await session.start(path);
    const original=await session.call('selection'),disk=await readFile(path);
    let current=await frame();
    const main=current.surfaces.find(item=>item.main),rect=main.scrollViewport;
    assert.ok(rect.width>0 && rect.height>0 && rect.x>=0 && rect.y>=0);
    assert.ok(rect.x+rect.width<=main.width && rect.y+rect.height<=main.height);
    let unchanged;
    for(let i=0;i<10;i++){
      unchanged=await frame(current.serial);
      if(!unchanged.surfaces)break;
      current=unchanged;
    }
    assert.equal(unchanged.surfaces,undefined,'Unchanged polls omit the encoded surfaces');
    const replay=await frame(-1);
    assert.ok(replay.surfaces[0].png.length>0,'A new subscriber still receives complete PNGs');
    const resized=await frame(replay.serial,840);
    assert.equal(resized.width,840);assert.ok(resized.surfaces);
    assert.notEqual(resized.surfaces[0].png,replay.surfaces[0].png);
    await session.call('dispatch',{command:'file-open'});
    const dialog=await eventually(result=>result.surfaces.some(item=>!item.main && /FileDialog/.test(item.type)));
    assert.ok(dialog.surfaces.every(item=>Buffer.from(item.png,'base64').subarray(1,4).toString()==='PNG'));
    await session.call('input',{type:'keydown',key:0x1000000});await session.call('state');
    await session.call('input',{type:'keyup',key:0x1000000});await session.call('state');
    await eventually(result=>result.surfaces.length===1);
    assert.equal((await session.call('selection')).source,original.source);
    assert.deepEqual(await readFile(path),disk);
  }finally{session.stop();}
});
