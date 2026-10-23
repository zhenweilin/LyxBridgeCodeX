import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,copyFile,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {startBroker,brokerFile} from '../server/native-broker.mjs';
import {callNativeRpc} from '../lib/native-broker-client.mjs';
import {createNativeEditor} from '../lib/native-editor.mjs';
import {createCli} from '../lib/native-cli.mjs';

test('real CLI streaming and merged edits preserve revisions, formulas, formatting, unsaved buffers and one-step undo', {timeout:120000},async()=>{
  const registry=await readFile(brokerFile).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
  const directory=await mkdtemp(resolve('.native/cli-integration-')),path=join(directory,'test.lyx');
  await copyFile('demo/demo.lyx',path);const disk=await readFile(path);
  const broker=await startBroker({port:0,registryPath:null});let session,child,lines;
  const ok=value=>{assert.ok(!value.error,value.message);return value;};
  try{
    const descriptor=await broker.open(path),sessionId=descriptor.sessionId;
    session=broker.sessions.get(sessionId);await session.call('frame',{width:1100,height:800,serial:-1});
    child=spawn(process.execPath,['test/fixtures/native-cli.mjs'],{stdio:['pipe','pipe','pipe'],env:{...process.env,LYX_TEST_BROKER:JSON.stringify(descriptor)}});
    let stderr='';child.stderr.on('data',data=>stderr+=data);
    lines=createInterface({input:child.stdout});const iterator=lines[Symbol.asyncIterator]();
    const call=async(command,args={})=>{
      child.stdin.write(JSON.stringify({id:'real-cli',command,args:{sessionId,...args}})+'\n');
      const line=await iterator.next();assert.ok(!line.done,stderr);return JSON.parse(line.value);
    };
    const read=()=>session.call('selection');
    const command=async command=>{ok(await session.call('command',{command}));return read();};
    const append=async text=>{await command('buffer-end');await command('paragraph-break');await command('layout Standard');await command(`self-insert ${text}`);return command('line-begin-select');};
    const before=await append('Alpha and beta are original.');
    assert.equal(ok(await call('selection')).plainTextSelection,true);
    const edits=[{find:'Alpha',replace:'Gamma'},{find:'beta',replace:'delta'}];
    const applied=ok(await call('apply',{edits}));assert.equal(applied.tracked,true);assert.equal(applied.source,undefined);
    const after=await read();assert.match(after.source,/Gamma and delta are original/);
    assert.match(after.source,/Alpha and beta are original/);assert.match(after.source,/\\change_deleted/);assert.match(after.source,/\\change_inserted/);
    assert.equal((await command('undo')).source,before.source);
    assert.equal((await command('redo')).source,after.source);await command('undo');
    const retry=ok(await call('replace',{snapshotId:applied.snapshotId,replacement:{format:'text',text:'Gamma and delta are original.'}}));
    assert.equal(retry.replayed,true);assert.equal((await read()).source,before.source);

    // The real native version check rejects a concurrent user mutation.
    const stale=ok(await call('selection'));await command('buffer-begin');await command('self-insert Concurrent edit ');
    const userSource=(await read()).source;
    const conflict=await call('replace',{snapshotId:stale.snapshotId,replacement:{format:'text',text:'Must not appear'}});
    assert.equal(conflict.code,'revision_conflict');assert.equal((await read()).source,userSource);await command('undo');

    // Compact native transport contains exactly one selected-text field.
    await command('buffer-end');await command('line-begin-select');
    const full=ok(await session.call('selection',{captureEdit:true}));
    const compact=ok(await session.call('selection',{captureEdit:true,compact:true}));
    assert.equal(compact.selection,undefined);assert.deepEqual(compact.clipboardSelection,full.clipboardSelection);
    assert.ok(Buffer.byteLength(JSON.stringify(compact))<Buffer.byteLength(JSON.stringify(full)));

    // Mixed formatting is explicitly ineligible for whole-string batching.
    await append('Bold ');await command('line-end');await command('font-bold');await command('self-insert mixed');await command('font-bold');
    const mixed=await command('line-begin-select');
    assert.equal(ok(await call('selection')).plainTextSelection,false);
    assert.equal((await call('apply',{edits:[{find:'Bold',replace:'New'}]})).error,true);
    assert.equal((await read()).source,mixed.source);

    // An inline formula stays editable and intact when text batching refuses it.
    await append('Text ');await command('line-end');await command('math-insert x^2');
    await command('escape');await command('line-end');const formula=await command('line-begin-select');
    assert.match(formula.source,/Formula/);
    assert.equal(ok(await call('selection')).plainTextSelection,false);
    assert.equal((await call('apply',{edits:[{find:'Text',replace:'Updated'}]})).error,true);
    assert.equal((await read()).source,formula.source);

    // Simulate only a lost response, after the actual native operation succeeds.
    await append('Recover this sentence.');let lose=true;
    const recover=createCli({editor:createNativeEditor({rpc:async(args,options)=>{
      const result=await callNativeRpc(args,{...options,broker:descriptor});
      if(args.method==='clipboard'&&lose){lose=false;throw new Error('Simulated lost reply');}return result;
    }})});
    const lost=await recover({command:'apply',args:{sessionId,edits:[{find:'Recover',replace:'Recovered'}]}});
    assert.equal(lost.outcome,'unknown');assert.equal(lost.retrySameSnapshot,true);
    const recoveredSource=(await read()).source;
    assert.equal(ok(await recover(lost.retryRequest)).replayed,true);
    assert.equal((await read()).source,recoveredSource);
    assert.deepEqual(await readFile(path),disk);
    assert.ok(!stderr.includes(descriptor.token));
    assert.deepEqual(await readFile(brokerFile).catch(e=>{if(e.code!=='ENOENT')throw e;return null;}),registry);
    console.log(`CLI native evidence: ${directory}`);
  }finally{
    if(child){child.stdin.end();await once(child,'close');lines?.close();}
    const closed=new Promise(done=>broker.server.close(done));broker.server.closeAllConnections();
    if(session){const done=once(session.process,'close');const timer=setTimeout(()=>session.process.kill('SIGKILL'),1000);session.stop();await done;clearTimeout(timer);}
    await closed;
  }
});
