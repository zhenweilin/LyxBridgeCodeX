import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {createCli,executeLines,replaceSelectedText} from '../lib/native-cli.mjs';
import {createNativeEditor} from '../lib/native-editor.mjs';

const sessionId='cli-test',snapshotId='94967851-1772-4cb8-a958-002606a48fab';
const target={ready:true,path:'/test.lyx',modified:true,sourceRevision:'a'.repeat(64),snapshotId,snapshotTtlSeconds:1800,
  selectionFormat:'text',plainTextSelection:true,capabilities:{trackedReplacement:true},clipboardSelection:{kind:'document',hasSelection:true,
    text:'Alpha and beta.',start:[{paragraph:0,position:0,cell:0}],end:[{paragraph:0,position:15,cell:0}]}};
const receipt={applied:true,path:'/test.lyx',modified:true,sourceRevision:'b'.repeat(64),previousSourceRevision:'a'.repeat(64),snapshotId,replayed:false,tracked:true};
const noOpen=async()=>assert.fail('Existing-session commands cannot open another engine');
function fixture(rpc){return createCli({editor:createNativeEditor({rpc}),openNative:noOpen});}

test('apply resolves all exact edits against the original and emits one tracked native replacement',async()=>{
  const calls=[];
  const execute=fixture(async call=>{calls.push(call);return call.method==='selection'?target:receipt;});
  const result=await execute({id:'batch',command:'apply',args:{sessionId,edits:[
    {find:'Alpha',replace:'Beta'},{find:'beta.',replace:'gamma.'}]}});
  assert.deepEqual(result,{id:'batch',sessionId,...receipt});
  assert.deepEqual(calls.map(x=>x.method),['selection','clipboard']);
  assert.deepEqual(calls[1].params,{action:'replace-snapshot',snapshotId,replacement:{format:'text',text:'Beta and gamma.'},trackChanges:true});
});

test('ambiguous, overlapping, missing and invalid text edits never issue a mutation',async()=>{
  for(const edits of [[{find:'absent',replace:'x'}],[{find:'a',replace:'x'}],
    [{find:'Alpha',replace:'x'},{find:'lpha',replace:'y'}],[],[{find:'Alpha',replace:'x',save:true}],
    [{find:'Alpha',replace:'\0'}],[{find:'Alpha',replace:'x'.repeat(128*1024)}]]){
    const execute=fixture(async call=>{assert.equal(call.method,'selection');return target;});
    assert.equal((await execute({command:'apply',args:{sessionId,edits}})).error,true);
  }
  assert.equal(replaceSelectedText('a b',[{find:'a',replace:'b'},{find:'b',replace:'c'}]),'b c');
});

test('an uncertain apply result retains its exact snapshot and replacement for idempotent recovery',async()=>{
  const execute=fixture(async call=>{if(call.method==='selection')return target;throw new Error('Lost reply');});
  const result=await execute({command:'apply',args:{sessionId,edits:[{find:'Alpha',replace:'New'}]}});
  assert.equal(result.outcome,'unknown');assert.equal(result.retrySameSnapshot,true);
  assert.deepEqual(result.retryRequest,{command:'replace',args:{sessionId,snapshotId,
    replacement:{format:'text',text:'New and beta.'},trackChanges:true}});
});

test('apply preserves revision conflicts instead of recapturing or retrying automatically',async()=>{
  let writes=0;
  const execute=fixture(async call=>{
    if(call.method==='selection')return target;
    writes++;return {error:true,code:'revision_conflict',message:'User edited meanwhile'};
  });
  const result=await execute({command:'apply',args:{sessionId,edits:[{find:'Alpha',replace:'New'}]}});
  assert.equal(result.outcome,'not_applied');assert.equal(writes,1);
});

test('apply refuses old engines, mixed formatting and math before mutation',async()=>{
  for(const extra of [{plainTextSelection:undefined},{plainTextSelection:false},{selectionFormat:'math'}]){
    const execute=fixture(async call=>{assert.equal(call.method,'selection');return {...target,...extra};});
    assert.equal((await execute({command:'apply',args:{sessionId,edits:[{find:'Alpha',replace:'New'}]}})).error,true);
  }
});

test('stream preserves request order, Unicode chunk boundaries and bounded invalid-input results',async()=>{
  const seen=[];
  const text='{"id":1,"command":"selection","args":{"text":"中文"}}\ninvalid\n{"id":2}\n';
  const bytes=Buffer.from(text);
  const results=[];
  for await(const result of executeLines(Readable.from([...bytes].map(byte=>Buffer.from([byte]))),async request=>{
    await new Promise(done=>setImmediate(done));seen.push(request.id);return {id:request.id};
  }))results.push(result);
  assert.deepEqual(seen,[1,2]);assert.equal(results[1].error,true);
  await assert.rejects(async()=>{for await(const r of executeLines(Readable.from(['x'.repeat(1024*1024+1)]),async()=>({})))void r;},/1 MiB/);
});

test('open strips broker credentials and invalid commands cannot reach transport',async()=>{
  const execute=createCli({editor:createNativeEditor({rpc:async()=>assert.fail('Unexpected RPC')}),
    openNative:async()=>({path:'/test.lyx',sessionId,token:'secret',url:'private'})});
  assert.deepEqual(await execute({command:'open',args:{path:'/test.lyx'}}),{path:'/test.lyx',sessionId});
  for(const request of [{command:'dispatch',args:{}},{command:'replace',args:{sessionId,snapshotId,save:true}},
    {command:'read',args:{sessionId},extra:true},{command:'apply',args:{sessionId,trackChanges:'false'}}])
    assert.equal((await execute(request)).error,true);
});

test('the shipped CLI exposes help and rejects invalid arguments with JSON and nonzero exit status',()=>{
  const help=spawnSync(process.execPath,['scripts/lyxctl.mjs','--help'],{encoding:'utf8'});
  assert.equal(help.status,0);assert.match(help.stdout,/serve/);
  for(const args of [['read'],['selection','--session','x','--direct'],['serve','unexpected']]){
    const failed=spawnSync(process.execPath,['scripts/lyxctl.mjs',...args],{encoding:'utf8'});
    assert.equal(failed.status,1);assert.equal(JSON.parse(failed.stdout).error,true);
  }
});
