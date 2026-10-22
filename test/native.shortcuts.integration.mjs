import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {NativeSession} from '../lib/native-session.mjs';
import {createNativeIme} from '../web/native-ime.mjs';

test('real LyX: browser-confirmed Space and letters complete native layout shortcuts', {timeout:120000},async()=>{
  const directory=await mkdtemp(resolve('.native/shortcuts-integration-'));
  const path=join(directory,'demo.lyx');
  const original=await readFile('demo/demo.lyx','utf8');
  await copyFile('demo/demo.lyx',path);
  const session=new NativeSession(),handlers=new Map(),inputs=[];
  const frontend=await readFile('web/native-app.mjs','utf8');
  const start=frontend.indexOf('const keys='),end=frontend.indexOf("$('input').addEventListener('blur'");
  assert.ok(start>=0 && end>start);
  const browserInput={value:'',addEventListener:(type,handler)=>handlers.set(type,handler)};
  runInNewContext(`let composing=false;${frontend.slice(start,end)}`,{
    $:()=>browserInput,createNativeIme,state:undefined,
    queue:(method,params)=>{assert.equal(method,'input');inputs.push(params);},
    modifiers:event=>({shift:event.shiftKey,alt:event.altKey,ctrl:event.ctrlKey,meta:event.metaKey}),
  });
  const flush=async()=>{
    for(const params of inputs.splice(0))await session.call('input',params);
    await session.call('state');
  };
  const browserKey=async(value,mods={})=>{
    const event={key:value,code:value===' '?'Space':`Key${value.toUpperCase()}`,
      shiftKey:false,altKey:false,ctrlKey:false,metaKey:false,repeat:false,...mods,
      preventDefault(){this.defaultPrevented=true;}};
    handlers.get('keydown')({...event,type:'keydown'});
    if(!mods.ctrlKey && !mods.metaKey && value.length===1){
      handlers.get('beforeinput')({inputType:'insertText',data:value,cancelable:true,
        preventDefault(){this.defaultPrevented=true;}});
    }
    handlers.get('keyup')({...event,type:'keyup'});
    await flush();
  };
  const command=async command=>{
    const result=await session.call('command',{command});
    assert.ok(!result.error,result.message);
  };
  const snapshot=()=>session.call('selection');
  const frame=()=>session.call('frame',{width:1000,height:800,serial:-1});
  try{
    await session.start(path);await frame();
    await command('buffer-end');
    const baseline=await snapshot();
    // Exercise the ordinary browser key/beforeinput path, not hand-written Qt
    // keys. The popup must open without a space being inserted into the paper.
    await browserKey('p',{ctrlKey:true});await browserKey(' ');
    const opened=await frame();
    assert.ok(opened.surfaces.length>1,'Control-P then Space opens the environment chooser');
    assert.equal((await snapshot()).source,baseline.source);
    await writeFile(join(directory,'environment-chooser.png'),Buffer.from(opened.surfaces[0].png,'base64'));
    await browserKey('Home');await browserKey('ArrowDown');
    assert.equal((await snapshot()).source,baseline.source,'Highlighting an environment does not apply it');
    await browserKey('Enter');
    assert.equal((await frame()).surfaces.length,1,'Enter accepts the highlighted environment and closes the chooser');
    const accepted=await snapshot();
    assert.notEqual(accepted.source,baseline.source,'Enter applies the highlighted environment');
    assert.equal(accepted.source.split('\\begin_layout').length,baseline.source.split('\\begin_layout').length,
      'Confirming the chooser must not insert a paragraph in the document');
    await browserKey('q');
    assert.notEqual((await snapshot()).source,accepted.source,'Typing after confirmation returns to the document');
    await command('undo');
    assert.equal((await snapshot()).source,accepted.source,'Typing has its own undo step');
    await command('undo');
    assert.equal((await snapshot()).source,baseline.source,'One undo restores the environment change exactly');
    await browserKey('p',{ctrlKey:true});await browserKey(' ');
    await browserKey('Home');await browserKey('ArrowDown');
    await browserKey('Escape');
    assert.equal((await frame()).surfaces.length,1);
    assert.equal((await snapshot()).source,baseline.source,'Escape cancels a highlighted environment without applying it');
    await browserKey('p',{ctrlKey:true});await browserKey(' ');
    await browserKey('Home');await browserKey('ArrowDown');
    await browserKey('Enter',{code:'NumpadEnter'});
    assert.equal((await frame()).surfaces.length,1,'Numeric keypad Enter also accepts the environment');
    assert.equal((await snapshot()).source,accepted.source);
    await command('undo');
    assert.equal((await snapshot()).source,baseline.source);
    session.socket.cork();
    const rapid=[
      session.call('input',{type:'keydown',key:80,text:'p',ctrl:true}),
      session.call('input',{type:'keyup',key:80,text:'p',ctrl:true}),
      session.call('input',{type:'commit',text:' ',key:32,shift:false}),
    ];
    session.socket.uncork();await Promise.all(rapid);
    assert.ok((await frame()).surfaces.length>1,'A prefix and continuation in one socket batch retain event ordering');
    assert.equal((await snapshot()).source,baseline.source);
    await browserKey('Escape');
    // A letter, a shifted letter, and a third key must also reach LyX's
    // current keymap instead of being inserted as standalone text.
    for(const [keys,layout] of [
      [[['t',{}]],'Title'],
      [[['A',{shiftKey:true}]],'Author'],
      [[['*',{shiftKey:true}],['2',{}]],'Section*'],
    ]){
      await browserKey('p',{ctrlKey:true});
      for(const [value,mods] of keys)await browserKey(value,mods);
      const changed=await snapshot();
      const layouts=[...changed.source.matchAll(/\\begin_layout (.*)/g)].map(match=>match[1]);
      assert.equal(layouts.at(-1),layout);
      await command('undo');
      assert.equal((await snapshot()).source,baseline.source,'One undo restores the layout and all content');
    }
    await browserKey('p',{ctrlKey:true});await browserKey('Escape');
    await browserKey('t');
    assert.notEqual((await snapshot()).source,baseline.source,'Typing after Escape is ordinary text');
    await command('undo');assert.equal((await snapshot()).source,baseline.source);
    await browserKey('m',{metaKey:true});
    for(const [value,mods] of [['x',{}],['^',{shiftKey:true}],['2',{}]])await browserKey(value,mods);
    assert.match((await snapshot()).source,/\\begin_inset Formula \$x\^\{2\}\$/);
    assert.equal(await readFile(path,'utf8'),original,'Shortcut checks never save the fixture');
    console.log(`Shortcut regression artifacts: ${directory}`);
  }finally{session.stop();}
});
