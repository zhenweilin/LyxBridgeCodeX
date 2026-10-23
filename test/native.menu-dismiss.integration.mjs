import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,readFile,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {NativeSession} from '../lib/native-session.mjs';

test('outside clicks dismiss native menus and submenus without activating the underlying document', {timeout:60000},async()=>{
  const fixture='test/fixtures/demo.lyx',original=await readFile(fixture);
  const directory=await mkdtemp(resolve('.native/menu-dismiss-')),path=join(directory,'demo.lyx');
  await copyFile(fixture,path);
  const session=new NativeSession();
  const frame=()=>session.call('frame',{width:880,height:700,serial:-1});
  const snapshot=()=>session.call('selection');
  const label=text=>text.replaceAll('&','').split('\t')[0];
  const point=(surface,item)=>({surface:surface.id,x:Math.round(item.x+item.width/2),y:Math.round(item.y+item.height/2),button:0});
  const click=async p=>{
    for(const type of ['pointerdown','pointerup'])await session.call('input',{type,...p,buttons:type==='pointerdown'?(p.button===2?2:1):0});
    await session.call('state');
  };
  const menu=async name=>{
    const root=(await frame()).surfaces.find(x=>x.main);
    const item=root.menuActions.find(x=>label(x.text)===name);assert.ok(item,name);
    await click(point(root,item));
    const popup=(await frame()).surfaces.find(x=>x.isMenu);assert.ok(popup,`${name} opens`);
    return popup;
  };
  const outside=async()=>{
    const f=await frame(),root=f.surfaces.find(x=>x.main),popups=f.surfaces.filter(x=>x.isMenu);
    for(let y=150;y<600;y+=50)for(let x=30;x<850;x+=50){
      if(popups.every(p=>x<p.x||x>=p.x+p.width||y<p.y||y>=p.y+p.height))return {surface:root.id,x,y,button:0};
    }
    assert.fail('Find a document point outside the complete menu chain');
  };
  const dismiss=async()=>{
    const before=await snapshot();await click(await outside());
    assert.ok(!(await frame()).surfaces.some(x=>x.isMenu),'One outside click closes the complete menu chain');
    const after=await snapshot();assert.equal(after.source,before.source);
    assert.deepEqual(after.cursor,before.cursor,'Dismissal does not click through into the document');
    assert.equal(after.modified,before.modified);
  };
  try{
    await session.start(path);await frame();
    await session.call('command',{command:'buffer-begin'});
    const baseline=await snapshot();
    await menu('Insert');await dismiss();
    const insert=await menu('Insert'),math=insert.menuActions.find(x=>label(x.text)==='Math');
    await click(point(insert,math));await new Promise(done=>setTimeout(done,300));
    assert.ok((await frame()).surfaces.filter(x=>x.isMenu).length>=2,'A real submenu opens');
    await dismiss();
    const root=(await frame()).surfaces.find(x=>x.main);
    await click({surface:root.id,x:150,y:230,button:2});
    assert.ok((await frame()).surfaces.some(x=>x.isMenu),'Context menu opens');await dismiss();
    // Menu-bar routing must still switch menus instead of consuming the click.
    await menu('Insert');
    const edit=await menu('Edit');assert.ok(edit.menuActions.some(x=>x.clipboardAction==='copy'));
    await dismiss();
    // Both gestures can reach the socket before Qt handles the first press.
    const current=(await frame()).surfaces.find(x=>x.main);
    const insertPoint=point(current,current.menuActions.find(x=>label(x.text)==='Insert'));
    const dismissPoint={surface:current.id,x:850,y:650,button:0};
    let replies;session.socket.cork();
    try{replies=Promise.all([insertPoint,dismissPoint].flatMap(p=>['pointerdown','pointerup'].map(type=>
      session.call('input',{type,...p,buttons:type==='pointerdown'?1:0}))));}finally{session.socket.uncork();}
    await replies;await session.call('state');
    assert.ok(!(await frame()).surfaces.some(x=>x.isMenu),'Queued open and outside-click retain event order');
    // A subsequent ordinary click still reaches the document.
    const before=await snapshot();await click({surface:current.id,x:300,y:260,button:0});
    assert.notDeepEqual((await snapshot()).cursor,before.cursor);
    assert.equal((await snapshot()).source,baseline.source);
    assert.deepEqual(await readFile(path),original);
    console.log(`Menu dismissal evidence: ${directory}`);
  }finally{session.stop();}
});
