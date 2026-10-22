import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {NativeSession} from '../lib/native-session.mjs';

test('Insert menus fit the panel and keep first, last, and submenu actions reachable', {timeout:60000},async()=>{
  const fixture='test/fixtures/demo.lyx',original=await readFile(fixture,'utf8');
  const directory=await mkdtemp(resolve('.native/menu-viewport-'));
  const path=join(directory,'demo.lyx');await copyFile(fixture,path);
  const session=new NativeSession();
  let size={width:880,height:830};
  const frame=()=>session.call('frame',{...size,serial:-1});
  const source=async()=>(await session.call('selection')).source;
  const label=value=>value.replaceAll('&','').split('\t')[0];
  const key=async key=>{
    for(const type of ['keydown','keyup'])await session.call('input',{type,key});
    await session.call('state');
  };
  const click=async(surface,item)=>{
    assert.ok(item,'The requested native menu action exists');
    assert.ok(item.y>=0 && item.y+item.height<=surface.height,'The action is entirely visible before clicking');
    for(const type of ['pointerdown','pointerup'])await session.call('input',{
      type,surface:surface.id,x:Math.round(item.x+item.width/2),y:Math.round(item.y+item.height/2),
      button:0,buttons:type==='pointerdown'?1:0});
    await session.call('state');
  };
  const menus=async()=>{
    const current=await frame(),popups=current.surfaces.filter(surface=>surface.isMenu);
    assert.ok(popups.length,'A native menu is open');
    for(const popup of popups){
      assert.ok(popup.x>=0 && popup.y>=0 && popup.x+popup.width<=current.width && popup.y+popup.height<=current.height,
        `Menu fits panel: ${JSON.stringify({panel:[current.width,current.height],menu:[popup.x,popup.y,popup.width,popup.height]})}`);
    }
    return popups;
  };
  const insert=async()=>{
    const root=(await frame()).surfaces.find(surface=>surface.main);
    await click(root,root.menuActions.find(item=>label(item.text)==='Insert'));
    return (await menus()).find(surface=>surface.menuActions.some(item=>label(item.text)==='Math'));
  };
  try{
    await session.start(path);await frame();
    await session.call('command',{command:'buffer-end'});
    await key(0x1000004);
    await session.call('command',{command:'layout Standard'});
    const baseline=await source();
    for(const dimensions of [{width:880,height:830},{width:480,height:300},{width:620,height:420}]){
      size=dimensions;const popup=await insert();
      const math=popup.menuActions.find(item=>label(item.text)==='Math');
      assert.equal(math.enabled,true);
      assert.ok(math.y>=0 && math.y+math.height<=popup.height,'The first Insert item is visible');
      assert.equal(new Set(popup.menuActions.filter(item=>item.height>0).map(item=>item.x)).size,1,
        'Long menus scroll vertically instead of overflowing in extra columns');
      await writeFile(join(directory,`insert-${size.width}.png`),Buffer.from(popup.png,'base64'));
      await click(popup,math);
      // Qt opens submenus after its native hover delay.
      await new Promise(resolve=>setTimeout(resolve,300));
      const nested=await menus();
      assert.ok(nested.length>=2,'The Math submenu opens with a mouse click');
      await key(0x1000000); // Back to Insert.
      await key(0x1000011); // End scrolls to Preview, the last item.
      const bottom=(await menus()).find(surface=>surface.id===popup.id);
      const preview=bottom.menuActions.find(item=>label(item.text)==='Preview');
      assert.equal(preview.enabled,true);
      await writeFile(join(directory,`bottom-${size.width}.png`),Buffer.from(bottom.png,'base64'));
      await click(bottom,preview);
      assert.match(await source(),/\\begin_inset Preview/,'The last menu action remains clickable');
      await session.call('command',{command:'undo'});
      assert.equal(await source(),baseline,'Menu insertion retains native undo');
    }
    // Exercise mouse-wheel scrolling in the smallest panel.
    size={width:480,height:300};const top=await insert();
    for(let index=0;index<8;index++){
      await session.call('input',{type:'wheel',surface:top.id,x:80,y:100,dx:0,dy:-120,deltaMode:0});
      await session.call('state');
    }
    const scrolled=(await menus()).find(surface=>surface.id===top.id);
    assert.notEqual(scrolled.png,top.png,'The long native menu responds to the wheel');
    await key(0x1000010); // Home returns to Math.
    const returned=(await menus()).find(surface=>surface.id===top.id);
    const math=returned.menuActions.find(item=>label(item.text)==='Math');
    assert.ok(math.y>=0 && math.y+math.height<=returned.height);
    await key(0x1000000);
    // Reflow an already open menu chain without rebuilding its native actions.
    size={width:880,height:830};const beforeResize=await insert();
    await click(beforeResize,beforeResize.menuActions.find(item=>label(item.text)==='Math'));
    await new Promise(resolve=>setTimeout(resolve,300));
    const chain=await menus();assert.equal(chain.length,2);
    size={width:480,height:300};const resized=await menus();
    assert.deepEqual(new Set(resized.map(menu=>menu.id)),new Set(chain.map(menu=>menu.id)),
      'Resizing retains the native parent and child menus');
    await key(0x1000011);await menus(); // Native submenu keyboard navigation still works.
    await key(0x1000000);
    await key(0x1000011);
    const parent=(await menus()).find(menu=>menu.id===beforeResize.id);
    await click(parent,parent.menuActions.find(item=>label(item.text)==='Preview'));
    assert.match(await source(),/\\begin_inset Preview/);
    await session.call('command',{command:'undo'});
    assert.equal(await source(),baseline);
    assert.equal(await readFile(path,'utf8'),original);
    assert.equal(await readFile(fixture,'utf8'),original);
    console.log(`Menu viewport artifacts: ${directory}`);
  }finally{session.stop();}
});
