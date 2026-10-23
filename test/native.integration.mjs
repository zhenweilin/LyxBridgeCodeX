import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile, readFile, writeFile, mkdtemp, mkdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {NativeSession} from '../lib/native-session.mjs';
import {createNativeIme} from '../web/native-ime.mjs';

test('real LyX: text input, native shortcuts, formula model, selection, save and reopen', {timeout: 120000}, async () => {
  const original = await readFile('demo/demo.lyx');
  assert.match(original.toString(), /\\lyxformat 620\b/, 'The fixture exercises LyX 2.4 import');
  await mkdir('.native', {recursive:true});
  const directory = await mkdtemp(resolve('.native/integration-'));
  const path = join(directory, 'demo.lyx');
  await copyFile('demo/demo.lyx', path);
  let session = new NativeSession();
  const command = async value => {
    const result = await session.call('command', {command:value});
    assert.ok(!result.error, `${value}: ${result.message}`);
    return result;
  };
  const key = async (key, text = '', modifiers = {}) => {
    await session.call('input', {type:'keydown',key,text,...modifiers});
    await session.call('input', {type:'keyup',key,text,...modifiers});
  };
  // Exercise the shipped DOM key mapping, not hand-written Qt key constants.
  // Only DOM delivery is injected; the resulting events reach the real LyX model.
  const frontend=await readFile('web/native-app.mjs','utf8'),handlers=new Map(),tabInputs=[];
  const keyboardStart=frontend.indexOf('const keys='),keyboardEnd=frontend.indexOf("for(const type of ['compositionstart'");
  assert.ok(keyboardStart>=0 && keyboardEnd>keyboardStart,'The native keyboard event block must be present');
  const browserInput={value:'',addEventListener:(type,handler)=>handlers.set(type,handler)};
  runInNewContext(`let composing=false;${frontend.slice(keyboardStart,keyboardEnd)}`,{
    $:()=>browserInput,createNativeIme,state:undefined,connectionPhase:'connected',
    queue:(method,params)=>{assert.equal(method,'input');tabInputs.push(params);},
    modifiers:event=>({shift:event.shiftKey,alt:event.altKey,ctrl:event.ctrlKey,meta:event.metaKey}),
  });
  const browserTab=async shiftKey=>{
    for(const type of ['keydown','keyup']){
      let prevented=false;
      handlers.get(type)({type,key:'Tab',code:'Tab',shiftKey,altKey:false,ctrlKey:false,metaKey:false,
        repeat:false,preventDefault:()=>{prevented=true;}});
      assert.equal(prevented,true,'Tab stays in the native editor');
      await session.call('input',tabInputs.at(-1));
      await session.call('state');
    }
  };
  try {
    await session.start(path);
    await session.call('frame', {width:1000,height:800});
    await command('buffer-end');
    await key(0x1000004);
    await command('layout Standard');
    await session.call('input', {type:'composition',text:'中'});
    await session.call('input', {type:'commit',text:'中文 Native selection'});
    await command('word-backward-select');
    const selection = await session.call('selection');
    assert.equal(selection.selection, 'selection');
    assert.equal(selection.modified, true);
    assert.ok(selection.selectionStart.length > 0);
    assert.match(selection.source, /中文 Native selection/);
    assert.equal(await readFile(path,'utf8'), original.toString());
    await key('Z'.codePointAt(0), 'z', {meta:true});
    assert.doesNotMatch((await session.call('selection')).source, /中文 Native selection/);
    await key('Z'.codePointAt(0), 'Z', {meta:true,shift:true});
    assert.match((await session.call('selection')).source, /中文 Native selection/);
    await command('buffer-end');
    await key(0x1000004);
    await command('layout Standard');
    await key('M'.codePointAt(0), 'm', {meta:true});
    await key('X'.codePointAt(0), 'x');
    await key('^'.codePointAt(0), '^', {shift:true});
    await key('2'.codePointAt(0), '2');
    const formula = await session.call('selection');
    assert.match(formula.source, /\\begin_inset Formula \$x\^\{2\}\$/);
    await command('math-insert \\frac{a}{b}');
    const fraction=await session.call('selection');
    await browserTab(false);
    const forward=await session.call('selection');
    assert.notDeepEqual(forward.cursor,fraction.cursor,'Tab moves to another native fraction cell');
    await browserTab(true);
    const backward=await session.call('selection');
    assert.deepEqual(backward.cursor,fraction.cursor,'Shift+Tab returns to the previous native fraction cell');
    for(const current of [forward,backward]){
      assert.equal(current.source,fraction.source,'Formula cell navigation must not edit source');
      assert.equal(current.modified,fraction.modified);
    }
    assert.equal(tabInputs[2].key,tabInputs[3].key,'Backtab press and release use the same native key');
    await writeFile(join(directory,'tab-navigation.json'),JSON.stringify({tabInputs,
      before:fraction.cursor,forward:forward.cursor,backward:backward.cursor,
      sourceUnchanged:backward.source===fraction.source},null,2)+'\n');
    await command('undo');
    assert.equal((await session.call('selection')).source,formula.source,'Undo removes only the temporary fraction');
    // Save using the user's Mac key binding, not a handwritten LyX serializer.
    await key('S'.codePointAt(0), 's', {meta:true});
    const saved = await session.call('selection');
    assert.equal(saved.modified, false);
    const savedSource=await readFile(path,'utf8');
    assert.match(savedSource, /\\begin_inset Formula \$x\^\{2\}\$/);
    assert.match(savedSource, /\\lyxformat 643\b/, 'Saving uses the LyX 2.5 native format');
    const frame = await session.call('frame', {width:1000,height:800});
    await writeFile(join(directory,'edited.png'), Buffer.from(frame.surfaces[0].png,'base64'));
    // A modal Qt dialog must not block the transport that supplies its input.
    await session.call('dispatch', {command:'dialog-show document'});
    let dialogFrame;
    for(let i=0;i<20;i++){
      dialogFrame=await session.call('frame',{width:1000,height:800});
      if(dialogFrame.surfaces?.length>1)break;
      await new Promise(r=>setTimeout(r,50));
    }
    assert.ok(dialogFrame.surfaces?.length>1,'The native document dialog is rendered');
    await key(0x1000000);
    const closedDialog=await session.call('frame',{width:1000,height:800});
    assert.equal(closedDialog.surfaces.length,1,'Escape closes the native dialog without blocking the bridge');
    session.stop();
    session = new NativeSession();
    await session.start(path);
    const reopened = await session.call('selection');
    assert.match(reopened.source, /中文 Native selection/);
    assert.match(reopened.source, /\\begin_inset Formula \$x\^\{2\}\$/);
    assert.equal(reopened.modified,false);
    assert.deepEqual(await readFile('demo/demo.lyx'), original);
    console.log(`Native evidence: ${directory}`);
  } finally {session.stop();}
});
