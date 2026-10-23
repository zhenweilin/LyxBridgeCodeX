import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {NativeSession} from '../lib/native-session.mjs';

test('native color split button preserves selection, supports arrows, Enter, Escape, outside dismissal and repeat',
  {timeout:90000},async()=>{
  const directory=await mkdtemp(resolve('.native/color-ui-test-')),path=join(directory,'palette.lyx');
  await writeFile(path,String.raw`#LyX 2.5 created this file.
\lyxformat 643
\begin_document
\begin_header
\textclass article
\language english
\inputencoding utf8
\end_header
\begin_body
\begin_layout Standard
Color palette demonstration
\end_layout
\end_body
\end_document
`);
  const original=await readFile(path,'utf8');
  const session=new NativeSession();
  const command=async command=>{const r=await session.call('command',{command});assert.ok(!r.error,`${command}: ${r.message}`);};
  const snapshot=()=>session.call('selection');
  const frame=async name=>{
    const r=await session.call('frame',{width:1100,height:800,serial:-1});
    if(name)for(const [i,s] of r.surfaces.entries())await writeFile(join(directory,`${name}-${i}.png`),Buffer.from(s.png,'base64'));
    return r;
  };
  const click=async(surface,x,y)=>{
    for(const type of ['pointerdown','pointerup'])
      await session.call('input',{type,surface:surface.id,x:Math.round(x),y:Math.round(y),button:0,buttons:type==='pointerdown'?1:0});
    await session.call('state');
  };
  const key=async(key,modifiers={})=>{
    for(const type of ['keydown','keyup'])await session.call('input',{type,key,text:'',...modifiers});
    await session.call('state');
  };
  const colorButton=async()=>{
    const info=await session.call('selection',{includeControls:true});
    const button=info.controls.find(x=>x.name==='standard').actions.find(x=>x.name==='codex-font-color');
    assert.equal(button.visible,true);return button;
  };
  const open=async name=>{
    const root=(await frame()).surfaces.find(x=>x.main),b=await colorButton();
    await click(root,b.x+b.width-7,b.y+b.height/2);
    const current=await frame(name);
    const palette=current.surfaces.find(x=>x.isMenu);
    assert.ok(palette,'Arrow opens the native color palette');
    return palette;
  };
  try{
    await session.start(path);await frame();await frame('toolbar');
    await command('buffer-begin');await command('line-end-select');
    const before=await snapshot();
    await open('palette');
    assert.deepEqual((await snapshot()).clipboardSelection,before.clipboardSelection);
    await key(0x1000000);
    assert.equal((await frame()).surfaces.length,1);
    assert.equal((await snapshot()).source,before.source);
    await open('palette-outside');
    const root=(await frame()).surfaces.find(x=>x.main);
    await click(root,root.width-15,root.height-70);
    assert.equal((await frame()).surfaces.length,1);
    assert.deepEqual((await snapshot()).clipboardSelection,before.clipboardSelection);
    await open();await key(0x1000014);await key(0x1000004);
    assert.equal((await frame('applied')).surfaces.length,1);
    const colored=await snapshot();
    assert.notEqual(colored.source,before.source);assert.equal(colored.selection,before.selection);
    await command('undo');assert.equal((await snapshot()).source,before.source);
    await command('buffer-begin');await command('line-end-select');
    const b=await colorButton();await click(root,b.x+10,b.y+b.height/2);
    assert.equal((await snapshot()).source,colored.source,'Main A reapplies the color chosen with Enter');
    const palette=await open('recent-colors');
    // The custom-color button is the bottom row of the palette.
    await click(palette,palette.width/2,palette.height-24);
    const custom=(await frame('custom-dialog')).surfaces.find(x=>x.modal && /ColorDialog/.test(x.type));
    assert.ok(custom,'More colors opens the native custom-color dialog');
    await key(0x1000000);
    assert.equal((await snapshot()).source,colored.source,'Cancel custom color leaves the document unchanged');
    assert.equal((await frame()).surfaces.length,1);
    const more=await open();await click(more,more.width/2,more.height-24);
    const dialog=(await frame('custom-apply')).surfaces.find(x=>x.modal && /ColorDialog/.test(x.type));
    assert.ok(dialog);
    // QColorDialog's HTML field is directly above its bottom button row.
    await click(dialog,dialog.width-145,dialog.height-67);
    await key(65,{meta:true});
    await session.call('input',{type:'commit',text:'#4a7b9c'});await session.call('state');
    await key(0x1000004);
    assert.equal((await frame('custom-applied')).surfaces.length,1);
    const customApplied=await snapshot();
    assert.match(customApplied.source,/\\customcolor codexcolor4a7b9c 4a7b9c/);
    assert.match(customApplied.source,/\\color codexcolor4a7b9c/);
    assert.equal(customApplied.selection,before.selection);
    await command('undo');assert.equal((await snapshot()).source,colored.source);
    assert.equal(await readFile(path,'utf8'),original,'Palette actions do not save implicitly');
    console.log(`Color UI evidence: ${directory}`);
  }finally{session.stop();}
});
