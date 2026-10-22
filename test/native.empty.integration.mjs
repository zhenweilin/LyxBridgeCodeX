import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,readFile,writeFile,mkdtemp,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {NativeSession} from '../lib/native-session.mjs';

test('an empty native window supports file-dialog text input and creating another document', {timeout:60000},async()=>{
  const original=await readFile('demo/demo.lyx');
  await mkdir('.native',{recursive:true});
  const directory=await mkdtemp(resolve('.native/empty-integration-'));
  const path=join(directory,'original.lyx'),created=join(directory,'created.lyx');
  await copyFile('demo/demo.lyx',path);
  const session=new NativeSession(),records=[];
  const command=async command=>{
    const result=await session.call('command',{command});
    assert.ok(!result.error,result.message);return result;
  };
  const input=async params=>{await session.call('input',params);return session.call('state');};
  const key=async(key,text='',modifiers={})=>{
    await input({type:'keydown',key,text,...modifiers});
    return input({type:'keyup',key,text,...modifiers});
  };
  const frame=()=>session.call('frame',{width:900,height:700,serial:-1});
  try{
    await session.start(path);await frame();
    await command('buffer-end');await command('word-backward-select');
    assert.equal((await session.call('state')).hasSelection,true);
    await command('buffer-close');
    const empty=await session.call('state');records.push({name:'empty',state:empty});
    assert.equal(empty.ready,false);
    assert.equal(empty.hasSelection,false);
    assert.equal(empty.selection,'');
    assert.equal(empty.path,undefined);
    assert.equal(empty.clipboardSelection.kind,'document');
    assert.equal(empty.clipboardSelection.hasSelection,false);
    assert.equal(empty.inputMethod.composing,false);
    assert.ok((await frame()).surfaces.some(surface=>surface.main),'Native menus remain available with no document');

    await session.call('dispatch',{command:'file-open'});
    let dialog;
    for(let index=0;index<30;index++){
      dialog=await frame();
      if(dialog.surfaces.some(surface=>/FileDialog/.test(surface.type)))break;
      await new Promise(done=>setTimeout(done,20));
    }
    const chooser=dialog.surfaces.find(surface=>/FileDialog/.test(surface.type));
    assert.ok(chooser);
    assert.equal(dialog.ready,false);
    assert.equal(dialog.inputMethod.enabled,true);
    assert.equal(dialog.inputMethod.surface,chooser.id);
    await input({type:'composition',text:'filename',cursor:8});
    assert.equal((await session.call('state')).inputMethod.composing,true);
    await input({type:'composition',text:''});
    await input({type:'commit',text:'temporary filename.lyx'});
    const selected=await key(65,'a',{meta:true});
    assert.equal(selected.clipboardSelection.kind,'widget');
    assert.equal(selected.clipboardSelection.text,'temporary filename.lyx');
    const copied=await session.call('clipboard',{action:'copy',expectedSelection:selected.clipboardSelection});
    assert.ok(!copied.error,copied.message);
    assert.equal(copied.clipboard.text,'temporary filename.lyx');
    records.push({name:'filename-selection',state:selected});
    await key(0x1000000);
    assert.equal((await session.call('state')).ready,false);

    await command(`buffer-new ${created}`);
    const opened=await session.call('selection');
    assert.equal(opened.ready,true);
    assert.equal(opened.path,created);
    await command('buffer-end');await command('layout Standard');
    await input({type:'commit',text:'Created from an empty native window.'});
    assert.match((await session.call('selection')).source,/Created from an empty native window\./);
    await command('buffer-write');
    const saved=await session.call('selection');
    assert.equal(saved.modified,false);
    assert.equal(saved.source,await readFile(created,'utf8'));
    assert.deepEqual(await readFile(path),original);
    assert.deepEqual(await readFile('demo/demo.lyx'),original);
    records.push({name:'created',path:saved.path,modified:saved.modified});
  }finally{
    await writeFile(join(directory,'records.json'),JSON.stringify(records,null,2));
    console.log(`Native empty-window evidence: ${directory}`);
    assert.ok(!session.path || session.path===path,'Cleanup is restricted to this fixture');
    session.stop();
    if(session.process && !session.exited){
      let timer;
      await Promise.race([new Promise(done=>session.process.once('exit',done)),new Promise(done=>{timer=setTimeout(done,750);})]);
      clearTimeout(timer);
      if(!session.exited)session.process.kill('SIGKILL');
    }
  }
});
