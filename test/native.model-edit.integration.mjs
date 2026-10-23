import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {copyFile,readFile,mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {startBroker,brokerFile} from '../server/native-broker.mjs';
import {addNativeSelectionToChat} from '../web/native-chat.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
async function registryHash(){
  try{return hash(await readFile(brokerFile));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}

async function stopDisposableSession(session,path){
  assert.equal(session.path,path,'Only this test\'s disposable native process may be terminated');
  const child=session.process;
  if(!child || child.exitCode!==null || child.signalCode!==null){session.stop();return;}
  // LyX may remain alive while handling SIGTERM/emergency-save for an unsaved
  // buffer. Await close, and bound that graceful path for this disposable copy.
  const closed=new Promise(done=>child.once('close',done));
  const force=setTimeout(()=>child.kill('SIGKILL'),1000);
  try{session.stop();await closed;}
  finally{clearTimeout(force);}
}

test('real stdio model tools safely edit an isolated native buffer, preserve unsaved work and use native undo', {timeout:120000},async()=>{
  const original=await readFile('demo/demo.lyx'),registryBefore=await registryHash();
  await mkdir('.native',{recursive:true});
  const directory=await mkdtemp(resolve('.native/model-edit-integration-'));
  const path=join(directory,'demo.lyx');
  await copyFile('demo/demo.lyx',path);
  const broker=await startBroker({port:0,registryPath:null});
  const client=new Client({name:'native-model-edit-integration',version:'1.0.0'});
  const exposed=[];
  let stderr='';
  try{
    const descriptor=await broker.open(path);
    const sessionId=descriptor.sessionId;
    const transport=new StdioClientTransport({
      command:process.execPath,args:[resolve('test/fixtures/native-rpc-stdio.mjs')],stderr:'pipe',
      env:{...process.env,LYX_TEST_BROKER:JSON.stringify(descriptor)},
    });
    transport.stderr.on('data',chunk=>{stderr+=chunk.toString();});
    await client.connect(transport);
    const call=async(name,arguments_)=>{
      const result=await client.callTool({name,arguments:arguments_});
      exposed.push(result);
      return result;
    };
    const rpc=async(method,params={})=>{
      const result=await call('native_lyx_rpc',{sessionId,method,params});
      assert.ok(!result.isError,result.content?.[0]?.text);
      return result._meta['lyx/rpc'];
    };
    const read=async()=>{
      const result=await call('read_native_lyx',{sessionId});
      assert.ok(!result.isError,result.content?.[0]?.text);
      const value=result.structuredContent;
      assert.deepEqual(JSON.parse(result.content[0].text),value);
      assert.equal(value.path,path);
      assert.equal(value.sessionId,sessionId);
      assert.equal(value.sourceRevision,hash(value.source));
      return value;
    };
    const settled=async()=>{
      for(let attempt=0;attempt<50;attempt++){
        const value=await read();
        if(value.inputPending!==true)return value;
        await new Promise(done=>setTimeout(done,10));
      }
      assert.fail('The disposable native input queue did not settle');
    };
    const command=async command=>{
      await rpc('dispatch',{command});
      return settled();
    };
    const key=async(key,text='',modifiers={})=>{
      await rpc('input',{type:'keydown',key,text,...modifiers});
      await rpc('input',{type:'keyup',key,text,...modifiers});
      return settled();
    };
    const request=(snapshot,replacement)=>({sessionId,trackChanges:false,path:snapshot.path,sourceRevision:snapshot.sourceRevision,
      selection:snapshot.clipboardSelection,replacement});
    const replace=async(snapshot,replacement)=>{
      const result=await call('replace_native_lyx_selection',request(snapshot,replacement));
      assert.ok(!result.isError,result.content?.[0]?.text);
      const value=result.structuredContent;
      assert.equal(value.applied,true);
      assert.equal(value.modified,true);
      assert.equal(value.previousSourceRevision,snapshot.sourceRevision);
      assert.equal(value.sourceRevision,hash(value.source));
      assert.equal(value.source,(await read()).source);
      assert.deepEqual(await readFile(path),original,'Model edits must not implicitly save');
      return value;
    };
    const capture=async()=>{
      const result=await call('read_native_lyx_selection',{sessionId});
      assert.ok(!result.isError,result.content?.[0]?.text);
      const target=result.structuredContent;
      assert.equal(target.editingSupported,true,'Build the snapshot-enabled native engine before running this test');
      assert.equal(target.source,undefined);
      assert.ok(target.snapshotId);
      return target;
    };
    const editTarget=(target,replacement)=>call('replace_native_lyx_snapshot',{sessionId,snapshotId:target.snapshotId,replacement,trackChanges:false});
    const rejectTarget=async(target,replacement,code)=>{
      const before=await read();
      const result=await editTarget(target,replacement);
      assert.equal(result.isError,true);
      assert.equal(result.structuredContent.code,code,result.content?.[0]?.text);
      assert.equal(result.structuredContent.applied,false);
      const after=await read();
      assert.equal(after.source,before.source);
      assert.deepEqual(after.cursor,before.cursor,'Rejection must not move the live cursor');
      assert.deepEqual(after.clipboardSelection,before.clipboardSelection,'Rejection must not change the live selection');
    };

    const initial=await read();
    assert.equal(initial.editingSupported,true,'Build the current native edit bridge before running this test');
    assert.equal(initial.modified,false);
    assert.equal(initial.inputPending,false);
    await rpc('frame',{width:1000,height:800});
    for(const action of ['buffer-end','paragraph-break','layout Standard','self-insert Unsaved user context survives model editing',
      'paragraph-break','self-insert Original MCP selected text','line-begin-select'])await command(action);
    const before=await read();
    assert.equal(before.selection,'Original MCP selected text');
    assert.equal(before.clipboardSelection.kind,'document');
    assert.equal(before.modified,true);
    for(const [code,changes] of [
      ['revision_conflict',{sourceRevision:initial.sourceRevision}],
      ['selection_conflict',{selection:{...before.clipboardSelection,text:'A stale selected string'}}],
    ]){
      const rejected=await call('replace_native_lyx_selection',{
        ...request(before,{format:'text',text:'Must never appear'}),...changes,
      });
      assert.equal(rejected.isError,true);
      assert.equal(rejected.structuredContent.code,code);
      assert.equal(rejected.structuredContent.applied,false);
      assert.equal(rejected.structuredContent.outcome,'not_applied');
      const unchanged=await read();
      assert.equal(unchanged.source,before.source);
      assert.deepEqual(unchanged.clipboardSelection,before.clipboardSelection);
    }

    // The terse legacy attachment must still carry everything needed for a
    // guarded write, without copying the passage into structured metadata.
    let legacyContext;
    await addNativeSelectionToChat(before,{modelContext:{update:async value=>{
      legacyContext=value;return {updateId:'legacy-native-integration'};
    }}},{sessionId});
    const legacyMetadata=legacyContext.structuredContent;
    const legacyText=legacyContext.content[0].text.split('\n\n').slice(1).join('\n\n');
    assert.equal(legacyText,before.selection);
    assert.equal(legacyMetadata.text,undefined);
    const changed=await replace({path:legacyMetadata.file,sourceRevision:legacyMetadata.bufferRevision,
      clipboardSelection:{kind:'document',hasSelection:true,text:legacyText,...legacyMetadata.range}},
      {format:'text',text:'Updated MCP selected text\nSecond line 中文'});
    assert.match(changed.source,/Unsaved user context survives model editing/);
    assert.doesNotMatch(changed.source,/Original MCP selected text/);
    assert.match(changed.source,/Updated MCP selected text/);
    assert.match(changed.source,/Second line 中文/);
    assert.equal((await command('undo')).source,before.source,'A single native undo restores the whole model edit');
    assert.equal((await command('redo')).source,changed.source);

    // Capture in the native process, then deliberately select unrelated content
    // before applying. The saved target must survive both collapsed and changed
    // selections without an external UI click or a second full-document read.
    await command('undo');
    const captured=await capture();
    const shared=await rpc('selection',{captureEdit:true});
    assert.deepEqual(shared.modelCapabilities,{selectionSnapshots:true});
    assert.equal(shared.source,undefined);
    let attached;
    const attachment=await addNativeSelectionToChat(shared,{modelContext:{update:async value=>{
      attached=value.structuredContent;return {updateId:'native-integration-selection'};
    }}},{sessionId});
    assert.equal(attachment.snapshotAttached,true);
    assert.equal(attached.sessionId,sessionId);
    assert.equal(attached.snapshotId,shared.snapshotId);
    const target={...captured,snapshotId:attached.snapshotId};
    assert.equal(target.selection.text,before.selection);
    assert.equal(target.sourceRevision,before.sourceRevision);
    await command('buffer-begin');
    await command('word-forward-select');
    assert.notEqual((await read()).selection,target.selection.text);
    await rejectTarget(target,{format:'math',text:'x'},'invalid_replacement');
    const replacement={format:'text',text:'Snapshot replacement survives cursor movement\nSecond paragraph 中文'};
    const writeStart=performance.now();
    const applied=await editTarget(target,replacement);
    const writeMs=performance.now()-writeStart;
    assert.ok(!applied.isError,applied.content?.[0]?.text);
    assert.equal(applied.structuredContent.applied,true);
    assert.equal(applied.structuredContent.replayed,false);
    assert.equal(applied.structuredContent.source,undefined);
    const afterTarget=await read();
    assert.match(afterTarget.source,/Unsaved user context survives model editing/);
    assert.match(afterTarget.source,/Snapshot replacement survives cursor movement/);
    assert.doesNotMatch(afterTarget.source,/Original MCP selected text/);
    assert.equal(applied.structuredContent.sourceRevision,afterTarget.sourceRevision);
    assert.deepEqual(await readFile(path),original,'Snapshot edits never save implicitly');
    assert.equal((await command('undo')).source,before.source,'Snapshot edit is one undo step');
    const replay=await editTarget(target,replacement);
    assert.equal(replay.structuredContent.replayed,true);
    assert.equal((await read()).source,before.source,'Retry returns the past receipt even after undo, without reapplying');
    await rejectTarget(target,{format:'text',text:'Different second edit'},'snapshot_used');
    assert.equal((await command('redo')).source,afterTarget.source);

    // The default MCP snapshot path must record revisions too. Its retry key
    // includes the review mode, so a direct edit cannot replay a tracked edit.
    await command('buffer-end');await command('line-begin-select');
    const reviewBefore=await read(),reviewTarget=await capture();
    await command('buffer-begin');
    const trackedArguments={sessionId,snapshotId:reviewTarget.snapshotId,
      replacement:{format:'text',text:'Proposed snapshot revision'}};
    const trackedResult=await call('replace_native_lyx_snapshot',trackedArguments);
    assert.ok(!trackedResult.isError,trackedResult.content?.[0]?.text);
    assert.equal(trackedResult.structuredContent.tracked,true);
    const trackedSource=(await read()).source;
    assert.match(trackedSource,/\\change_deleted/);assert.match(trackedSource,/\\change_inserted/);
    assert.ok(trackedSource.includes(reviewBefore.selection));
    assert.match(trackedSource,/Proposed snapshot revision/);
    const trackedReplay=await call('replace_native_lyx_snapshot',trackedArguments);
    assert.equal(trackedReplay.structuredContent.replayed,true);
    assert.equal((await read()).source,trackedSource,'A tracked retry cannot duplicate the proposed text');
    const wrongMode=await call('replace_native_lyx_snapshot',{...trackedArguments,trackChanges:false});
    assert.equal(wrongMode.structuredContent.code,'snapshot_used');
    assert.equal((await command('undo')).source,reviewBefore.source,'Tracked snapshot replacement is one undo step');

    // Revision conflicts must not silently redirect or rebase to similar text.
    await command('buffer-end');await command('line-begin-select');
    const conflictTarget=await capture();
    await command('buffer-begin');await command('self-insert Concurrent user edit ');
    await rejectTarget(conflictTarget,{format:'text',text:'Must never appear'},'revision_conflict');
    await command('undo');
    await rpc('input',{type:'composition',text:'candidate'});await settled();
    await rejectTarget(conflictTarget,{format:'text',text:'Must never appear'},'input_pending');
    const composingCapture=await call('read_native_lyx_selection',{sessionId});
    assert.equal(composingCapture.structuredContent.code,'input_pending');
    await rpc('input',{type:'composition',text:''});await settled();
    await command('dialog-show document');
    assert.ok((await rpc('frame',{width:1000,height:800})).surfaces.some(surface=>!surface.main),'The native document settings dialog must be visible');
    await rejectTarget(conflictTarget,{format:'text',text:'Must never appear'},'not_editable');
    await key(16777216); // Escape closes only the disposable native dialog.
    await command('buffer-end');await command('line-begin-select');
    const evicted=await capture();
    for(let index=0;index<32;index++)await capture();
    await rejectTarget(evicted,{format:'text',text:'Must never appear'},'snapshot_expired');
    await rejectTarget({snapshotId:'94967851-1772-4cb8-a958-002606a48fab'},
      {format:'text',text:'Must never appear'},'snapshot_expired');
    const fullResult=await call('read_native_lyx',{sessionId});
    const compactResult=await call('read_native_lyx_selection',{sessionId});
    const measurement={fullReadBytes:Buffer.byteLength(JSON.stringify(fullResult)),
      compactReadBytes:Buffer.byteLength(JSON.stringify(compactResult)),
      fullEditBytes:Buffer.byteLength(JSON.stringify({content:[{type:'text',text:JSON.stringify(changed)}],structuredContent:changed})),
      compactEditBytes:Buffer.byteLength(JSON.stringify(applied)),compactEditMs:writeMs};
    assert.ok(measurement.compactReadBytes<measurement.fullReadBytes/2);
    assert.ok(measurement.compactEditBytes<measurement.fullEditBytes/2);
    await writeFile(join(directory,'snapshot-measurement.json'),JSON.stringify(measurement,null,2)+'\n');
    console.log(`Snapshot payload/latency comparison: ${JSON.stringify(measurement)}`);

    // Preserve the captured caret's font, including backwards selections. A
    // restored target must produce the same source as the legacy native edit.
    for(const direction of ['backward','forward']){
      for(const action of ['buffer-end','paragraph-break','layout Standard','font-bold','self-insert Bold ',
        'font-bold','self-insert plain','line-begin-select'])await command(action);
      if(direction==='forward'){await command('line-begin');await command('line-end-select');}
      const styledBefore=await read();
      const styledReplacement={format:'text',text:`Styled ${direction} replacement`};
      const styledExpected=await replace(styledBefore,styledReplacement);
      await command('undo');
      const styledTarget=await capture();
      await command('buffer-begin');
      const styledResult=await editTarget(styledTarget,styledReplacement);
      assert.ok(!styledResult.isError,styledResult.content?.[0]?.text);
      assert.equal((await read()).source,styledExpected.source,`Font and source match for ${direction} selection`);
    }

    for(const action of ['buffer-end','paragraph-break','layout Standard'])await command(action);
    await key(77,'m',{meta:true});await key(88,'x');await key(94,'^',{shift:true});await key(50,'2');
    const mathBefore=await command('char-backward-select');
    assert.equal(mathBefore.selection,'2');
    assert.ok(mathBefore.selectionStart.length>=3,'The replacement must target a native nested math cell');
    const mathAfter=await replace(mathBefore,{format:'math',text:'\\frac{a}{b}'});
    assert.match(mathAfter.source,/\\begin_inset Formula \$x\^\{\\frac\{a\}\{b\}\}\$/);
    assert.equal((await command('undo')).source,mathBefore.source);
    assert.equal((await command('redo')).source,mathAfter.source);
    await command('undo');
    const mathTarget=await capture();
    assert.equal(mathTarget.selectionFormat,'math');
    assert.ok(mathTarget.selection.start.length>=3);
    await command('buffer-begin');
    const mathResult=await editTarget(mathTarget,{format:'math',text:'\\frac{a}{b}'});
    assert.ok(!mathResult.isError,mathResult.content?.[0]?.text);
    assert.equal((await read()).source,mathAfter.source,'Restoring a nested math target reproduces the native current-selection edit');
    assert.equal((await command('undo')).source,mathBefore.source);
    assert.equal((await command('redo')).source,mathAfter.source);

    const missing=await call('read_native_lyx',{sessionId:'missing-model-edit-session'});
    assert.equal(missing.isError,true);
    const extraUrl=await call('replace_native_lyx_selection',{
      ...request(mathBefore,{format:'math',text:'z'}),url:'https://example.invalid',
    });
    assert.equal(extraUrl.isError,true);
    assert.equal((await read()).source,mathAfter.source);
    const finalFrame=await rpc('frame',{width:1000,height:800,serial:-1});
    await writeFile(join(directory,'model-edited-native.png'),Buffer.from(finalFrame.surfaces.find(surface=>surface.main).png,'base64'));
    await writeFile(join(directory,'model-edit-results.json'),JSON.stringify({before,changed,mathBefore,mathAfter},null,2)+'\n');
    assert.ok(!JSON.stringify(exposed).includes(descriptor.token),'Model and UI results must not expose the broker token');
    assert.ok(!JSON.stringify(exposed).includes(descriptor.url),'Model and UI results must not expose the private transport URL');
    assert.ok(!stderr.includes(descriptor.token));
    assert.deepEqual(await readFile(path),original);
    assert.deepEqual(await readFile('demo/demo.lyx'),original);
    assert.equal(await registryHash(),registryBefore,'The production broker registry must remain unchanged');
    console.log(`MCP native edit evidence: ${directory}`);
  }finally{
    try{await client.close();}
    finally{
      const closed=new Promise(done=>broker.server.close(done));
      broker.server.closeAllConnections();
      await Promise.all([closed,...[...broker.sessions.values()].map(session=>stopDisposableSession(session,path))]);
    }
  }
});
