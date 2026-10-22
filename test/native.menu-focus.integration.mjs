import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,readFile,mkdtemp,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {NativeSession} from '../lib/native-session.mjs';

test('offscreen menu focus and clipboard prefetch retain enabled document Copy/Cut', {timeout:60000}, async () => {
  const original=await readFile('demo/demo.lyx');
  await mkdir('.native',{recursive:true});
  const directory=await mkdtemp(resolve('.native/menu-focus-integration-'));
  const path=join(directory,'demo.lyx');
  await copyFile('demo/demo.lyx',path);
  const session=new NativeSession();
  const frame=()=>session.call('frame',{width:1000,height:800});
  const label=value=>value.replaceAll('&','').split('\t')[0];
  const key=async code=>{
    await session.call('input',{type:'keydown',key:code});
    await session.call('input',{type:'keyup',key:code});
  };
  const pointer=(surface,item)=>({surface:surface.id,
    x:Math.round(item.x+item.width/2),y:Math.round(item.y+item.height/2),button:0});
  const click=async(surface,item)=>{
    await session.call('input',{type:'pointerdown',...pointer(surface,item),buttons:1});
    await session.call('input',{type:'pointerup',...pointer(surface,item),buttons:0});
  };
  const editMenu=async()=>{
    const root=(await frame()).surfaces.find(surface=>surface.main);
    const edit=root.menuActions.find(item=>label(item.text)==='Edit');
    assert.ok(edit,'The native Edit menu is available');
    await click(root,edit);
    const popup=(await frame()).surfaces.find(surface=>surface.isMenu
      && surface.menuActions.some(item=>item.clipboardAction==='copy'));
    assert.ok(popup,'The actual native Edit popup is open');
    return popup;
  };
  const assertActions=popup=>{
    for(const action of ['copy','cut'])
      assert.equal(popup.menuActions.find(item=>item.clipboardAction===action)?.enabled,true,
        `${action} remains enabled while an offscreen menu owns input`);
  };
  try{
    await session.start(path);
    await frame();
    await session.call('command',{command:'buffer-begin'});
    await session.call('command',{command:'word-forward-select'});
    const selected=await session.call('selection');
    assert.equal(selected.hasSelection,true);
    await session.call('clipboard',{action:'copy',expectedPath:selected.path,expectedSelection:selected.clipboardSelection});

    for(const action of ['copy','cut']){
      let popup=await editMenu();
      assertActions(popup);
      const item=popup.menuActions.find(item=>item.clipboardAction===action);
      // Route actual pointer and keyboard input to the open native popup, then
      // exercise the prefetch that formerly ran again when the menu opened.
      await session.call('input',{type:'pointermove',...pointer(popup,item),buttons:0});
      await key(0x1000015); // Down, handled by the active QMenu.
      const copied=await session.call('clipboard',{action:'copy',expectedPath:selected.path,expectedSelection:selected.clipboardSelection});
      assert.ok(!copied.error,copied.message);
      popup=(await frame()).surfaces.find(surface=>surface.id===popup.id);
      assert.ok(popup,'Copy prefetch must leave the native popup open');
      assertActions(popup);
      await click(popup,popup.menuActions.find(item=>item.clipboardAction===action));
      const result=await session.call('state');
      assert.equal(result.menuClipboard?.action,action,'Native dispatch accepts the focused menu action');
      assert.equal((await session.call('selection')).source,selected.source,'Menu Cut waits for confirmation');
      await session.call('clipboard',{action:'menu-cancel',requestId:result.menuClipboard.id});
    }
    // Keep a document selection but move Qt focus into a real native field.
    // This deterministically exercises GuiView::hasFocus()==false without a
    // testing-only focus API. On Cocoa the global menu requires the document
    // focus restriction; an offscreen in-window menu follows normal Qt rules.
    await session.call('dispatch',{command:'dialog-show findreplace'});
    const field=await session.call('state');
    assert.equal(field.clipboardSelection.kind,'widget','A native field owns Qt focus');
    assert.equal(field.hasSelection,true,'The document retains its selection');
    assertActions(await editMenu());
    await key(0x1000000); // Close the menu without invoking a document action.
    assert.equal((await session.call('selection')).source,selected.source);
    assert.deepEqual(await readFile(path),original);
    assert.deepEqual(await readFile('demo/demo.lyx'),original);
    console.log(`Native menu focus evidence: ${directory}`);
  }finally{session.stop();}
});
