import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {NativeSession} from '../lib/native-session.mjs';
import {createNativeIme} from '../web/native-ime.mjs';

test('macOS browser Command-? opens native Help without changing the document',
  {timeout:60000,skip:process.platform!=='darwin'},async()=>{
  const directory=await mkdtemp(resolve('.native/help-shortcut-')),path=join(directory,'demo.lyx');
  await copyFile('test/fixtures/demo.lyx',path);
  const original=await readFile(path),session=new NativeSession(),handlers=new Map(),inputs=[];
  const frontend=await readFile('web/native-app.mjs','utf8');
  const start=frontend.indexOf('const keys='),end=frontend.indexOf("$('input').addEventListener('blur'");
  assert.ok(start>=0 && end>start);
  const input={value:'',addEventListener:(type,handler)=>handlers.set(type,handler)};
  runInNewContext(`let composing=false;const connectionPhase='connected';${frontend.slice(start,end)}`,{
    $:()=>input,createNativeIme,state:undefined,
    queue:(method,params)=>{assert.equal(method,'input');inputs.push(params);},
    modifiers:event=>({shift:event.shiftKey,alt:event.altKey,ctrl:event.ctrlKey,meta:event.metaKey}),
  });
  const key=async(value,mods={})=>{
    const event={key:value,code:['?','/'].includes(value)?'Slash':value,
      metaKey:false,shiftKey:false,ctrlKey:false,altKey:false,repeat:false,...mods,
      preventDefault(){this.defaultPrevented=true;}};
    handlers.get('keydown')({...event,type:'keydown'});
    if(!event.metaKey && !event.ctrlKey && value.length===1)
      handlers.get('beforeinput')({inputType:'insertText',data:value,cancelable:true,preventDefault(){}});
    handlers.get('keyup')({...event,type:'keyup'});
    for(const params of inputs.splice(0))await session.call('input',params);
    await session.call('state');
  };
  const frame=()=>session.call('frame',{width:697,height:737,serial:-1});
  const snapshot=()=>session.call('selection');
  const label=text=>text.replaceAll('&','').split('\t')[0];
  const help=async()=>{
    const f=await frame(),menus=f.surfaces.filter(x=>x.isMenu);
    assert.equal(menus.length,1,'The shortcut opens one native Help menu');
    for(const text of ['Introduction','Tutorial',"User's Guide"])
      assert.ok(menus[0].menuActions.some(x=>label(x.text)===text && x.enabled),text);
    const root=f.surfaces.find(x=>x.main),menu=menus[0];
    assert.ok(menu.x>=0 && menu.y>=0 && menu.x+menu.width<=root.width && menu.y+menu.height<=root.height,
      'Help is visible inside the narrow editor panel');
    return menu;
  };
  try{
    await session.start(path);await frame();
    await session.call('command',{command:'buffer-begin'});
    await session.call('command',{command:'word-forward-select'});
    const before=await snapshot();assert.ok(before.hasSelection);
    await key('?',{metaKey:true,shiftKey:true});const opened=await help();
    await writeFile(join(directory,'help-menu.png'),Buffer.from(opened.png,'base64'));
    await key('?',{metaKey:true,shiftKey:true,repeat:true});
    assert.equal((await help()).id,opened.id,'Held shortcut does not replace or dismiss the menu');
    // Choose Tutorial using only the keyboard, then close the unmodified
    // manual to return to the original document and its selection.
    await key('ArrowDown');await key('Enter');
    assert.match((await snapshot()).path,/\/doc\/Tutorial\.lyx$/);
    await session.call('command',{command:'buffer-close'});
    assert.equal((await snapshot()).path,path);
    await key('?',{metaKey:true,shiftKey:true});await help();await key('Escape');
    assert.ok(!(await frame()).surfaces.some(x=>x.isMenu),'Escape closes Help');
    const after=await snapshot();
    assert.equal(after.source,before.source);assert.equal(after.modified,before.modified);
    assert.deepEqual(after.cursor,before.cursor);assert.deepEqual(after.clipboardSelection,before.clipboardSelection);
    await key('/',{metaKey:true,shiftKey:true});await help();
    const root=(await frame()).surfaces.find(x=>x.main);
    for(const type of ['pointerdown','pointerup'])await session.call('input',{
      type,surface:root.id,x:30,y:650,button:0,buttons:type==='pointerdown'?1:0});
    assert.ok(!(await frame()).surfaces.some(x=>x.isMenu),'Outside click also closes keyboard-opened Help');
    await key('?',{shiftKey:true});
    assert.ok(!(await frame()).surfaces.some(x=>x.isMenu),'Ordinary question mark stays text input');
    assert.notEqual((await snapshot()).source,before.source);
    await session.call('command',{command:'undo'});
    assert.equal((await snapshot()).source,before.source);
    await session.call('dispatch',{command:'file-open'});await frame();
    await key('?',{metaKey:true,shiftKey:true});
    const dialog=await frame();
    assert.ok(dialog.surfaces.some(x=>/FileDialog/.test(x.type)));
    assert.ok(!dialog.surfaces.some(x=>x.isMenu),'Help must not steal input from a modal file dialog');
    await key('Escape');
    assert.deepEqual(await readFile(path),original);
    console.log(`Help shortcut evidence: ${directory}`);
  }finally{session.stop();}
});
