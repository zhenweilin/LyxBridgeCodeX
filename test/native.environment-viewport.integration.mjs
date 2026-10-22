import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {NativeSession} from '../lib/native-session.mjs';

test('environment list stays within the panel and reaches Standard and the final layout', {timeout:60000},async()=>{
  const fixture='test/fixtures/demo.lyx',original=await readFile(fixture,'utf8');
  const directory=await mkdtemp(resolve('.native/environment-viewport-'));
  const path=join(directory,'demo.lyx');await copyFile(fixture,path);
  const session=new NativeSession();
  let size={width:900,height:800};
  const frame=()=>session.call('frame',{...size,serial:-1});
  const snapshot=()=>session.call('selection');
  const command=async command=>{
    const result=await session.call('command',{command});assert.ok(!result.error,result.message);
  };
  const key=async key=>{
    for(const type of ['keydown','keyup'])await session.call('input',{type,key});
    await session.call('state');
  };
  const lastLayout=source=>[...source.matchAll(/\\begin_layout (.*)/g)].at(-1)[1];
  const popup=async()=>{
    const current=await frame();
    const list=current.surfaces.find(surface=>surface.type==='QComboBoxPrivateContainer');
    assert.ok(list,'The native environment list is visible');
    assert.ok(list.x>=0 && list.y>=0,`The top-left of the list must be visible: ${JSON.stringify({x:list.x,y:list.y})}`);
    assert.ok(list.x+list.width<=current.width && list.y+list.height<=current.height,
      `The list must fit the panel: ${JSON.stringify({panel:[current.width,current.height],list:[list.x,list.y,list.width,list.height]})}`);
    return list;
  };
  try{
    await session.start(path);await frame();
    await command('buffer-end');await command('layout Section');
    const baseline=await snapshot();
    for(const dimensions of [{width:900,height:800},{width:480,height:300},{width:620,height:420}]){
      size=dimensions;await frame();
      await command('drop-layouts-choice');await popup();
      await key(0x1000010); // Home scrolls to the first item, Standard.
      const top=await popup();
      await writeFile(join(directory,`top-${size.width}-${size.height}.png`),Buffer.from(top.png,'base64'));
      assert.equal((await snapshot()).source,baseline.source);
      await key(0x1000004);
      assert.equal((await frame()).surfaces.length,1);
      assert.equal(lastLayout((await snapshot()).source),'Standard','Standard remains reachable at the top');
      await command('undo');assert.equal((await snapshot()).source,baseline.source);

      await command('drop-layouts-choice');await popup();
      await key(0x1000011); // End must reach the last item through native scrolling.
      const bottom=await popup();
      await writeFile(join(directory,`bottom-${size.width}-${size.height}.png`),Buffer.from(bottom.png,'base64'));
      await key(0x1000004);
      assert.equal((await frame()).surfaces.length,1);
      const last=await snapshot();
      assert.notEqual(lastLayout(last.source),'Section');
      assert.notEqual(lastLayout(last.source),'Standard');
      await command('undo');assert.equal((await snapshot()).source,baseline.source);
    }
    // Scrolling and mouse hit testing must use the resized native list too.
    size={width:480,height:300};await frame();await command('drop-layouts-choice');
    await key(0x1000010);const first=await popup();
    const wheel=async dy=>{
      await session.call('input',{type:'wheel',surface:first.id,x:50,y:100,deltaMode:0,dx:0,dy});
      await session.call('state');
    };
    await wheel(-1200);const scrolled=await popup();
    assert.notEqual(scrolled.png,first.png,'The short list scrolls to reveal more environments');
    assert.equal((await snapshot()).source,baseline.source);
    // The popup's arrow controls appear/disappear as the view reaches an edge.
    for(let i=0;i<3;i++){await wheel(1200);await popup();}
    const wheelTop=await popup();
    await writeFile(join(directory,'wheel-top.png'),Buffer.from(wheelTop.png,'base64'));
    // QComboBox ignores mouse releases during its opening animation interval.
    await new Promise(resolve=>setTimeout(resolve,200));
    for(const type of ['pointerdown','pointerup'])
      await session.call('input',{type,surface:first.id,x:50,y:10,button:0,buttons:type==='pointerdown'?1:0});
    await session.call('state');
    assert.equal((await frame()).surfaces.length,1);
    assert.equal(lastLayout((await snapshot()).source),'Standard','The visible first row remains clickable after scrolling');
    await command('undo');assert.equal((await snapshot()).source,baseline.source);

    // Resizing while open must constrain the existing popup too.
    size={width:900,height:800};await frame();await command('drop-layouts-choice');await popup();
    size={width:480,height:300};await popup();await key(0x1000000);
    assert.equal((await snapshot()).source,baseline.source);
    assert.equal(await readFile(path,'utf8'),original);
    console.log(`Environment viewport artifacts: ${directory}`);
  }finally{session.stop();}
});
