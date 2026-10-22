import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile, readFile, writeFile, mkdtemp, mkdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {NativeSession} from '../lib/native-session.mjs';

test('native context menus accept right click, hover and Mac Control-click without blocking', {timeout:60000}, async () => {
  const original = await readFile('demo/demo.lyx');
  await mkdir('.native', {recursive:true});
  const directory = await mkdtemp(resolve('.native/pointer-integration-'));
  const path = join(directory, 'demo.lyx');
  await copyFile('demo/demo.lyx', path);
  const session = new NativeSession();
  const frame = () => session.call('frame',{width:1000,height:800});
  try {
    await session.start(path);
    const initial = await frame();
    assert.equal(initial.externalModified,false);
    for (const modifiers of [{button:2,buttons:2}, ...(process.platform==='darwin'?[{button:0,buttons:1,ctrl:true}]:[])]) {
      const root = (await frame()).surfaces.find(surface=>surface.main);
      const pointer = {surface:root.id,x:250,y:200,...modifiers};
      await session.call('input',{type:'pointerdown',...pointer});
      await session.call('input',{type:'pointerup',...pointer,buttons:0});
      let next = await frame();
      const menu = next.surfaces.find(surface=>!surface.main);
      assert.ok(menu,'A native context menu is rendered');
      let hoverChanged = false;
      for (let y=12;y<menu.height && !hoverChanged;y+=20) {
        await session.call('input',{type:'pointermove',surface:menu.id,x:20,y,buttons:0});
        next = await frame();
        hoverChanged = next.surfaces.find(surface=>surface.id===menu.id)?.png!==menu.png;
      }
      assert.ok(hoverChanged,'Native menu hover paints an active item');
      await session.call('input',{type:'keydown',key:0x1000000});
      await session.call('input',{type:'keyup',key:0x1000000});
      assert.equal((await frame()).surfaces.length,1,'Escape closes the native popup');
    }
    // Disk-change warning is derived from LyX's own buffer/checksum state.
    await writeFile(path,original.toString().replace('Problem Setting','Externally changed section'));
    assert.equal((await session.call('state')).externalModified,true);
    assert.deepEqual(await readFile('demo/demo.lyx'),original);
    console.log(`Native pointer evidence: ${directory}`);
  } finally {session.stop();}
});
