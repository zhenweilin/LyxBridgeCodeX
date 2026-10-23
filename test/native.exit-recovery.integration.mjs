import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,utimes} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {once} from 'node:events';
import {startBroker} from '../server/native-broker.mjs';
import {callNativeRpc,reopenNativeDocument} from '../lib/native-broker-client.mjs';

test('verified native exit reopens the Save As path with its recovery choice and preserves other unsaved editors',{timeout:90000},async()=>{
  const directory=await mkdtemp(resolve('.native/exit-recovery-integration-'));
  const source=await readFile('test/fixtures/demo.lyx','utf8');
  const original=join(directory,'original.lyx'),renamed=join(directory,'renamed.lyx'),other=join(directory,'other.lyx');
  const profile=join(directory,'empty-profile');await mkdir(profile);
  await Promise.all([original,other].map(path=>writeFile(path,source)));
  const previousProfile=process.env.LYX_USER_PROFILE;process.env.LYX_USER_PROFILE=profile;
  const broker=await startBroker({registryPath:null}),evidence={};
  try{
    const descriptor=await broker.open(original),session=broker.sessions.get(descriptor.sessionId);
    await session.waitForConfigurationCache();
    const saved=await session.call('command',{command:`buffer-write-as ${renamed}`});
    assert.equal(saved.error,false);assert.equal(session.lastKnownPath,renamed);
    const savedSource=await readFile(renamed,'utf8');
    const otherDescriptor=await broker.open(other),otherSession=broker.sessions.get(otherDescriptor.sessionId);
    await otherSession.call('input',{type:'commit',text:'Other editor retains unsaved content'});
    const otherBefore=await otherSession.call('selection');
    assert.equal(otherBefore.modified,true);assert.match(otherBefore.source,/Other editor retains unsaved content/);
    await assert.rejects(reopenNativeDocument(descriptor.sessionId,{broker:descriptor}),{code:'session_unavailable'});
    const exited=once(session.process,'exit');session.stop();await exited;
    assert.ok(session.exited,'Only a confirmed test-owned process exit permits recovery');
    await assert.rejects(callNativeRpc({sessionId:descriptor.sessionId,method:'state'},{broker:descriptor}),{code:'session_exited'});
    const backup=join(directory,'#renamed.lyx#'),marker='Newest text belongs to the renamed recovery file';
    const recoveredSource=savedSource.replace('Problem Setting',marker);assert.notEqual(recoveredSource,savedSource);
    await writeFile(backup,recoveredSource);
    const older=new Date(Date.now()-60000);await utimes(renamed,older,older);
    const reopened=await reopenNativeDocument(descriptor.sessionId,{broker:descriptor});
    assert.equal(reopened.path,renamed);assert.notEqual(reopened.sessionId,descriptor.sessionId);
    const recovered=broker.sessions.get(reopened.sessionId),prompt=await recovered.call('state');
    assert.equal(prompt.ready,false);assert.equal(prompt.interactionRequired,true);assert.match(prompt.interactionTitle,/backup/i);
    assert.equal((await reopenNativeDocument(descriptor.sessionId,{broker:descriptor})).sessionId,reopened.sessionId);
    const frame=await recovered.call('frame',{width:720,height:620,serial:-1});
    assert.ok(frame.surfaces.some(surface=>surface.modal),'The actual backup decision is visible');
    assert.equal(await readFile(backup,'utf8'),recoveredSource,'Reopen does not choose or remove recovery data');
    assert.equal(await readFile(renamed,'utf8'),savedSource);
    assert.equal(await readFile(original,'utf8'),source);
    assert.equal(await readFile(other,'utf8'),source);
    assert.equal((await otherSession.call('selection')).source,otherBefore.source);
    assert.equal(otherSession.process.killed,false);
    evidence.lastKnownPath=renamed;evidence.promptTitle=prompt.interactionTitle;
    evidence.originalUnchanged=true;evidence.recoveryUnchanged=true;evidence.otherUnsavedEditorPreserved=true;
  }finally{
    await writeFile(join(directory,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
    for(const session of broker.sessions.values())session.stop();
    const closed=new Promise(done=>broker.server.close(done));broker.server.closeAllConnections();await closed;
    if(previousProfile===undefined)delete process.env.LYX_USER_PROFILE;else process.env.LYX_USER_PROFILE=previousProfile;
    console.log(`Native exit recovery evidence: ${directory}`);
  }
});
