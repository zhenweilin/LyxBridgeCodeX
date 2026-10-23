import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,utimes} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {startBroker} from '../server/native-broker.mjs';

const delay=ms=>new Promise(done=>setTimeout(done,ms));

// Each fixture supplies its own original and newer recovery copy. No existing
// document, broker registry or running user's native process is touched.
for(const choice of ['backup','original','cancel'])
test(`startup recovery prompt is interactive before loading a document: ${choice}`,{timeout:90000},async()=>{
  await mkdir('.native',{recursive:true});
  const directory=await mkdtemp(resolve('.native/recovery-integration-'));
  const path=join(directory,'recover.lyx'),backupPath=join(directory,'#recover.lyx#');
  const original=await readFile('test/fixtures/demo.lyx','utf8');
  const marker='Recovery fixture contains the newest unsaved text';
  const backup=original.replace('Problem Setting',marker);
  assert.notEqual(backup,original);
  await writeFile(path,original);await writeFile(backupPath,backup);
  const earlier=new Date(Date.now()-60000);await utimes(path,earlier,earlier);
  const broker=await startBroker({port:0,registryPath:null});
  const records=[];
  try{
    const descriptor=await broker.open(path);
    const session=broker.sessions.get(descriptor.sessionId);
    const state=()=>session.call('state');
    const frame=()=>session.call('frame',{width:720,height:620,serial:-1});
    const eventually=async(predicate,message)=>{
      for(let i=0;i<100;i++){
        const current=await state();if(predicate(current))return current;
        await delay(25);
      }
      assert.fail(message);
    };
    const key=async(key,text='')=>{
      for(const type of ['keydown','keyup'])await session.call('input',{type,key,text});
      return state();
    };
    const initial=await state();
    assert.equal(initial.ready,false);assert.equal(initial.uiReady,true);
    assert.equal(initial.interactionRequired,true);assert.match(initial.interactionTitle,/backup/i);
    assert.equal(session.startupPending,true);
    assert.equal((await broker.open(path)).sessionId,descriptor.sessionId,
      'Repeated opening must preserve the same unanswered prompt');
    assert.equal(broker.sessions.size,1);
    const promptFrame=await frame();
    assert.ok(!promptFrame.surfaces.some(surface=>/SplashScreen/i.test(surface.type)),
      'Native startup splash screens must not obscure the recovery decision');
    const prompt=promptFrame.surfaces.find(surface=>surface.modal && /backup/i.test(surface.message??surface.title));
    assert.ok(prompt,'The actual native recovery dialog is capturable before setBuffer');
    assert.ok(prompt.png.length>100,'The user receives real prompt pixels');
    await writeFile(join(directory,'prompt.png'),Buffer.from(prompt.png,'base64'));
    const main=promptFrame.surfaces.find(surface=>surface.main);
    await writeFile(join(directory,'editor-background.png'),Buffer.from(main.png,'base64'));
    records.push({phase:'prompt',state:initial,surfaces:promptFrame.surfaces.map(({png,...surface})=>surface)});
    assert.equal(await readFile(path,'utf8'),original);
    assert.equal(await readFile(backupPath,'utf8'),backup,'Polling/opening must not choose or alter recovery');
    if(choice==='backup')await key(0x1000004); // Default native Load backup button.
    else if(choice==='original'){
      await key(0x1000001);await key(0x20,' '); // Focus and press Load original.
    }else await key(0x1000000); // Native Cancel/escape button.
    if(choice==='cancel'){
      const empty=await eventually(value=>!value.interactionRequired,'Cancel must dismiss the native recovery prompt');
      assert.equal(empty.ready,false);assert.equal(empty.uiReady,true);
      assert.equal(session.startupPending,false);
      assert.equal(await readFile(backupPath,'utf8'),backup,'Cancel preserves the recovery file');
      const emptyFrame=await frame();
      assert.ok(emptyFrame.surfaces.some(surface=>surface.main),'An empty editor remains usable');
      await session.call('dispatch',{command:'file-open'});
      const chooser=await eventually(value=>value.interactionRequired,'The empty native editor can open a file chooser');
      assert.equal(chooser.ready,false);assert.equal(chooser.inputMethod.enabled,true);
      await key(0x1000000);
      await eventually(value=>!value.interactionRequired,'The empty editor file chooser can be canceled');
    }else{
      const loaded=await eventually(value=>value.ready,`The ${choice} decision must finish document loading`);
      assert.equal(loaded.path,path);assert.equal(loaded.interactionRequired,false);
      assert.equal(session.startupPending,false);
      const snapshot=await session.call('selection');
      assert.equal(snapshot.source.includes(marker),choice==='backup');
      assert.equal(snapshot.modified,choice==='backup');
      assert.equal(await readFile(path,'utf8'),original,'Choosing either source does not save over the original');
      records.push({phase:'loaded',path:snapshot.path,modified:snapshot.modified,recovered:snapshot.source.includes(marker)});
      // Resolve the fixture's dirty state without a save prompt, then verify
      // closing the last buffer does not look like another startup decision.
      if(choice==='backup')await session.call('command',{command:'buffer-write'});
      await session.call('command',{command:'buffer-close'});
      const empty=await state();
      assert.equal(empty.ready,false);assert.equal(empty.uiReady,true);
      assert.equal(empty.interactionRequired,false);assert.equal(session.startupPending,false);
    }
    // Recovery itself must never write the original. The explicit Save above
    // is restricted to this disposable backup-choice fixture.
    if(choice!=='backup')assert.equal(await readFile(path,'utf8'),original);
  }finally{
    await writeFile(join(directory,'evidence.json'),JSON.stringify({choice,records},null,2)+'\n');
    for(const session of broker.sessions.values())session.stop();
    const closed=new Promise(done=>broker.server.close(done));broker.server.closeAllConnections();await closed;
    console.log(`Native recovery evidence: ${directory}`);
  }
});
