import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {NativeSession} from '../lib/native-session.mjs';
import {createNativeIme} from '../web/native-ime.mjs';
import {createNativeInputQueue} from '../web/native-input-queue.mjs';

test('browser text and composition retain the filename editor while native completion is open',{timeout:60000},async()=>{
  const directory=await mkdtemp(resolve('.native/filename-ime-integration-'));
  const original=await readFile('demo/demo.lyx');
  const sourcePath=join(directory,'demo.lyx'),targetPath=join(directory,'typed 文档.lyx');
  await copyFile('demo/demo.lyx',sourcePath);await copyFile('demo/demo.lyx',targetPath);
  const session=new NativeSession(),records=[];
  const frame=()=>session.call('frame',{width:800,height:700,serial:-1});
  const input=async params=>{
    const result=await session.call('input',params);assert.ok(!result.error,result.message);
    return session.call('state');
  };
  const key=async(key,extra={})=>{
    await input({type:'keydown',key,...extra});return input({type:'keyup',key,...extra});
  };
  const eventually=async(predicate,message)=>{
    for(let attempt=0;attempt<40;attempt++){
      const current=await frame();if(predicate(current))return current;
      await new Promise(resolveWait=>setTimeout(resolveWait,10));
    }
    assert.fail(message);
  };
  const before=text=>({inputType:'insertText',data:text,cancelable:true,preventDefault(){}});
  try{
    await session.start(sourcePath);await frame();
    const baseline=await session.call('selection');
    const main=(await frame()).surfaces.find(surface=>surface.main);
    const fileMenu=main.menuActions.find(action=>action.text.replaceAll('&','')==='File');
    assert.ok(fileMenu);
    for(const type of ['pointerdown','pointerup'])await input({type,surface:main.id,
      x:Math.round(fileMenu.x+fileMenu.width/2),y:Math.round(fileMenu.y+fileMenu.height/2),
      button:0,buttons:type==='pointerdown'?1:0});
    const menu=await eventually(value=>value.surfaces.some(surface=>surface.isMenu),'Native File menu must open');
    assert.equal(menu.inputMethod.enabled,false,'A command menu is not a filename completion editor');
    await input({type:'commit',text:'Do not insert behind a menu'});
    const menuSnapshot=await session.call('selection');
    assert.equal(menuSnapshot.source,baseline.source,'IME commits in a command menu must not reach the document');
    assert.equal(menuSnapshot.modified,false);
    records.push({mode:'command menu blocks text',sourceUnchanged:true});
    await key(0x1000000);
    await eventually(value=>value.surfaces.length===1,'Escape must dismiss the command menu');
    for(const mode of ['bulk','rapid characters','completion keys','composition']){
      const opened=await session.call('dispatch',{command:'file-open'});assert.ok(!opened.error,opened.message);
      const initial=await eventually(value=>value.surfaces.some(surface=>/FileDialog/.test(surface.type)),'File Open must show its native chooser');
      const dialog=initial.surfaces.find(surface=>/FileDialog/.test(surface.type));
      await key(65,{text:'a',meta:true});await key(0x1000003);
      const {enqueue}=createNativeInputQueue(),pending=[],commits=[];
      const ime=createNativeIme({emit:params=>{
        if(params.type==='commit')commits.push(params.text);
        pending.push(enqueue(()=>input(params)));
      }});
      if(mode==='bulk')ime.beforeinput(before(targetPath));
      if(mode==='rapid characters'){
        // Queue every browser character without waiting on native round trips.
        // This reproduces the actual helper/transport ordering, not fake RPC.
        for(const character of targetPath){
          const event={key:character,code:character};
          assert.equal(ime.key({type:'keydown',...event}),'browser');
          ime.beforeinput(before(character));
          assert.equal(ime.key({type:'keyup',...event}),'ignore');
        }
      }
      if(mode==='completion keys'){
        ime.beforeinput(before(`${directory}/typed`));await Promise.all(pending);
        await eventually(value=>value.surfaces.some(surface=>surface.type==='QListView'),
          'A partial existing filename must open native completion');
        await key(0x1000015); // ArrowDown selects the native completion.
        await key(0x1000004); // Return accepts it through the popup.
        // QFileDialog accepts the completed existing file on this Return, not
        // just the popup item. Preserve that observed native keyboard behavior.
        const accepted=await eventually(value=>value.ready && value.path===targetPath && value.surfaces.length===1,
          'ArrowDown and Return must open the selected native filename completion');
        assert.equal(commits.join(''),`${directory}/typed`);
        const snapshot=await session.call('selection');
        assert.equal(snapshot.source,baseline.source);assert.equal(snapshot.modified,false);
        records.push({mode,expected:targetPath,opened:accepted.path,commitCount:commits.length});
        continue;
      }
      if(mode==='composition'){
        ime.beforeinput(before(`${directory}/`));await Promise.all(pending);
        const completion=await eventually(value=>value.surfaces.some(surface=>surface.type==='QListView'),
          'The existing directory must open a real filename completion popup');
        assert.equal(completion.inputMethod.enabled,true,'The completion popup must retain the filename IME target');
        assert.equal(completion.inputMethod.surface,dialog.id);
        const text='typed 文档.lyx';
        ime.compositionstart();
        ime.compositionupdate({data:text,target:{value:text,selectionStart:text.length,selectionEnd:text.length}});
        await Promise.all(pending);
        const composing=await session.call('selection');
        assert.equal(composing.inputMethod.composing,true);
        assert.equal(composing.inputMethod.surface,dialog.id);
        assert.equal(composing.source,baseline.source,'Filename preedit must not modify the document');
        ime.compositionend({data:text});ime.beforeinput(before(text));
        ime.input({inputType:'insertText',data:text});
      }
      await Promise.all(pending);
      assert.equal(commits.join(''),targetPath,'The frontend must emit exactly the requested text');
      let typed=await frame();
      if(typed.surfaces.some(surface=>surface.type==='QListView')){
        await key(0x1000000);typed=await frame();
        assert.ok(typed.surfaces.some(surface=>surface.id===dialog.id),'Escape dismisses completion without closing File Open');
      }
      const selected=await key(65,{text:'a',meta:true});
      records.push({mode,expected:targetPath,actual:selected.clipboardSelection?.text,commitCount:commits.length,
        inputMethod:typed.inputMethod});
      assert.equal(selected.clipboardSelection.kind,'widget');
      assert.equal(selected.clipboardSelection.text,targetPath,`${mode}: native filename must match every browser character`);
      const snapshot=await session.call('selection');
      assert.equal(snapshot.source,baseline.source);assert.equal(snapshot.modified,false);
      if(mode==='composition'){
        const shown=await frame();
        await writeFile(join(directory,'composed-filename.png'),Buffer.from(shown.surfaces.find(surface=>surface.id===dialog.id).png,'base64'));
        await key(0x1000004);
        await eventually(value=>value.ready && value.path===targetPath && value.surfaces.length===1,
          'Enter must open the exactly typed existing file');
      }else{
        await key(0x1000000);
        await eventually(value=>value.surfaces.length===1,'Escape must close the native filename dialog');
      }
    }
    assert.deepEqual(await readFile(sourcePath),original);assert.deepEqual(await readFile(targetPath),original);
    assert.deepEqual(await readFile('demo/demo.lyx'),original);
  }finally{
    await writeFile(join(directory,'results.json'),JSON.stringify(records,null,2)+'\n');
    console.log(`Native filename IME evidence: ${directory}`);
    const child=session.process,closed=child?.exitCode===null && child?.signalCode===null
      ?new Promise(resolveClosed=>child.once('close',resolveClosed)):Promise.resolve();
    session.stop();const timer=setTimeout(()=>{if(child?.exitCode===null && child?.signalCode===null)child.kill('SIGKILL');},1000);
    await closed;clearTimeout(timer);
  }
});
