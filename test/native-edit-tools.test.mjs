import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {createServer} from '../server/mcp.mjs';

const sessionId='isolated-native-edit-session';
const path='/isolated/native-edit-document.lyx';
const source='#LyX 2.4\n\\begin_document\n\\begin_body\n\\begin_layout Standard\nOriginal α text\n\\end_layout\n\\end_body\n\\end_document\n';
const hash=value=>createHash('sha256').update(value,'utf8').digest('hex');
const start=[{paragraph:0,position:0,cell:0}],end=[{paragraph:0,position:8,cell:0}];
const selected={kind:'document',hasSelection:true,text:'Original',start,end};
function snapshot(overrides={}){
  return {
    ready:true,path,source,sourceRevision:hash(source),diskRevision:hash('older disk content'),
    modified:true,externalModified:false,hasSelection:true,selection:'Original',
    selectionStart:start,selectionEnd:end,cursor:end,clipboardSelection:selected,
    capabilities:{editSelection:true,compositionGuard:true},...overrides,
  };
}
function args(overrides={}){
  return {sessionId,path,sourceRevision:hash(source),selection:structuredClone(selected),replacement:{format:'text',text:'Replacement'},trackChanges:false,...overrides};
}
async function connect(t,rpc){
  // Exercise real MCP serialization/schema validation, but inject the only
  // native RPC dependency. No broker discovery or user process is reachable.
  const server=createServer({rpc,openNative:async()=>{throw new Error('This test must not open a native process');}});
  const client=new Client({name:'native-edit-protocol-test',version:'1.0.0'});
  const [serverTransport,clientTransport]=InMemoryTransport.createLinkedPair();
  t.after(async()=>{await client.close();await server.close();});
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const read=client=>client.callTool({name:'read_native_lyx',arguments:{sessionId}});
const replace=(client,arguments_=args())=>client.callTool({name:'replace_native_lyx_selection',arguments:arguments_});
const targetId='94967851-1772-4cb8-a958-002606a48fab';
const compactRead=client=>client.callTool({name:'read_native_lyx_selection',arguments:{sessionId}});
const compactWrite=(client,extra={})=>client.callTool({name:'replace_native_lyx_snapshot',arguments:{
  sessionId,snapshotId:targetId,replacement:{format:'text',text:'Replacement'},trackChanges:false,...extra}});
const receipt=()=>({applied:true,path,modified:true,sourceRevision:hash('after'),previousSourceRevision:hash(source),
  snapshotId:targetId,replayed:false});
function data(result){
  assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent,'Model text and structured output must agree');
  return result.structuredContent;
}

test('compact selection captures once without full source, transport metadata or duplicated selected text',async t=>{
  const calls=[];
  const client=await connect(t,async call=>{calls.push(call);return snapshot({
    snapshotId:targetId,snapshotTtlSeconds:1800,selectionFormat:'text',token:'private-secret',
  });});
  const result=await compactRead(client);
  assert.ok(!result.isError);
  assert.deepEqual(calls,[{sessionId,method:'selection',params:{captureEdit:true,compact:true}}]);
  assert.deepEqual(data(result),{sessionId,path,modified:true,sourceRevision:hash(source),selection:selected,
    snapshotId:targetId,snapshotTtlSeconds:1800,selectionFormat:'text',editingSupported:true});
  assert.ok(!JSON.stringify(result).includes('private-secret'));
  assert.equal(data(result).source,undefined);
});

test('compact read of a legacy engine remains available without advertising a saved edit target',async t=>{
  const client=await connect(t,async()=>snapshot());
  assert.equal(data(await compactRead(client)).editingSupported,false);
});

test('a verified compact capture eliminates the tracked edit capability round trip',async t=>{
  const calls=[];
  const client=await connect(t,async call=>{
    calls.push(call);
    if(call.method==='selection')return snapshot({snapshotId:targetId,snapshotTtlSeconds:1800,selectionFormat:'text',
      capabilities:{trackedReplacement:true}});
    assert.equal(call.method,'clipboard');return {...receipt(),tracked:true};
  });
  await compactRead(client);
  const result=await compactWrite(client,{trackChanges:true});
  assert.ok(!result.isError);assert.equal(data(result).tracked,true);
  assert.deepEqual(calls.map(call=>call.method),['selection','clipboard']);
});

test('the panel capture warms tracked support, but never grants it to another session',async t=>{
  const calls=[];
  const client=await connect(t,async call=>{
    calls.push(call);
    if(call.method==='selection')return snapshot({capabilities:{trackedReplacement:true}});
    if(call.method==='state')return {ready:true,capabilities:{}};
    return {...receipt(),tracked:true};
  });
  await client.callTool({name:'native_lyx_rpc',arguments:{sessionId,method:'selection',params:{captureEdit:true}}});
  assert.ok(!(await compactWrite(client,{trackChanges:true})).isError);
  const other=await compactWrite(client,{sessionId:'different-engine',trackChanges:true});
  assert.equal(other.isError,true);assert.equal(data(other).outcome,'not_applied');
  assert.deepEqual(calls.map(call=>call.method),['selection','clipboard','state']);
});

test('the UI selection relay identifies snapshot tools registered by this MCP service',async t=>{
  const calls=[];
  const client=await connect(t,async call=>{calls.push(call);return snapshot({snapshotId:targetId,selectionFormat:'text'});});
  const result=await client.callTool({name:'native_lyx_rpc',arguments:{sessionId,method:'selection',params:{captureEdit:true}}});
  assert.deepEqual(result.content,[],'Capability negotiation stays in the UI response');
  assert.deepEqual(result._meta['lyx/rpc'].modelCapabilities,{selectionSnapshots:true});
  assert.equal(result._meta['lyx/rpc'].snapshotId,targetId);
  assert.deepEqual(calls,[{sessionId,method:'selection',params:{captureEdit:true}}]);
  const {tools}=await client.listTools();
  assert.ok(tools.some(tool=>tool.name==='replace_native_lyx_snapshot' && tool._meta.ui.visibility.includes('model')));
});

test('legacy UI selection reads retain their prior relay response',async t=>{
  const client=await connect(t,async()=>snapshot());
  const result=await client.callTool({name:'native_lyx_rpc',arguments:{sessionId,method:'selection',params:{}}});
  assert.deepEqual(result._meta['lyx/rpc'],snapshot());
});

test('a failed selection capture cannot advertise an attached snapshot',async t=>{
  const rejected={error:true,code:'input_pending',message:'Finish composition'};
  const client=await connect(t,async()=>rejected);
  const result=await client.callTool({name:'native_lyx_rpc',arguments:{sessionId,method:'selection',params:{captureEdit:true}}});
  assert.deepEqual(result._meta['lyx/rpc'],rejected);
});

test('snapshot edit uses one native call and returns only its bounded receipt',async t=>{
  const calls=[];
  const client=await connect(t,async call=>{calls.push(call);return {...snapshot(),...receipt(),token:'private-secret'};});
  const result=await compactWrite(client);
  assert.ok(!result.isError);
  assert.deepEqual(calls,[{sessionId,method:'clipboard',params:{action:'replace-snapshot',snapshotId:targetId,
    replacement:{format:'text',text:'Replacement'},trackChanges:false}}]);
  assert.deepEqual(data(result),{sessionId,...receipt()});
  assert.ok(!JSON.stringify(result).includes('private-secret'));
  assert.equal(data(result).source,undefined);
  const {tools}=await client.listTools();
  const tool=tools.find(item=>item.name==='replace_native_lyx_snapshot');
  assert.equal(tool.annotations.idempotentHint,true);
  assert.deepEqual(tool._meta.ui.visibility,['model']);
  assert.equal(tool.inputSchema.additionalProperties,false);
});

test('strict snapshot arguments reject extra actions, invalid IDs and oversized replacements before RPC',async t=>{
  const client=await connect(t,async()=>assert.fail('Invalid snapshot arguments must not reach native RPC'));
  for(const extra of [{snapshotId:'not-a-uuid'},{url:'http://private.invalid'},
    {replacement:{format:'text',text:'x',save:true}},{replacement:{format:'text',text:'x'.repeat(128*1024+1)}},
    {replacement:{format:'text',text:'bad\0text'}},{replacement:{format:'source',text:'x'}}])
    assert.equal((await compactWrite(client,extra)).isError,true);
});

test('snapshot receipt replay is reported explicitly without extra reads',async t=>{
  let calls=0;
  const client=await connect(t,async()=>{calls++;return {...receipt(),replayed:true};});
  assert.equal(data(await compactWrite(client)).replayed,true);
  assert.equal(calls,1);
});

for(const code of ['revision_conflict','snapshot_expired','snapshot_used','input_pending'])
  test(`snapshot ${code} rejects without claiming an edit or advising blind recapture`,async t=>{
    const client=await connect(t,async()=>({error:true,code,message:'Native rejection'}));
    const result=await compactWrite(client);
    assert.equal(result.isError,true);
    assert.equal(data(result).applied,false);
    assert.equal(data(result).outcome,'not_applied');
    assert.equal(data(result).retrySameSnapshot,undefined);
  });

for(const response of [null,{ready:true},{...receipt(),snapshotId:'60f24d74-10d5-4b1c-a27a-79429de4dec1'},
  {error:true,applied:true,code:'snapshot_failed',message:'Edited but result unavailable'}])
  test(`snapshot receipt failures distinguish unknown writes from confirmed mutations (${JSON.stringify(response)})`,async t=>{
    let calls=0;
    const client=await connect(t,async()=>{calls++;return response;});
    const result=await compactWrite(client);
    assert.equal(result.isError,true);
    assert.equal(data(result).outcome,response?.applied?'applied':'unknown');
    assert.equal(data(result).retrySameSnapshot,response?.applied?undefined:true);
    assert.equal(data(result).readBeforeRetry,response?.applied?true:undefined);
    assert.equal(calls,1,'No automatic retry');
  });

test('snapshot transport timeout keeps the outcome unknown and permits the same target retry',async t=>{
  const client=await connect(t,async()=>{throw new Error('Native request timed out');});
  const result=await compactWrite(client);
  assert.equal(data(result).outcome,'unknown');
  assert.equal(data(result).retrySameSnapshot,true);
  assert.equal(data(result).applied,undefined);
});

test('edit tools are model visible with accurate annotations and strict bounded input schemas',async t=>{
  const client=await connect(t,async()=>{assert.fail('Listing tools must not touch native sessions');});
  const {tools}=await client.listTools();
  const readTool=tools.find(tool=>tool.name==='read_native_lyx');
  const writeTool=tools.find(tool=>tool.name==='replace_native_lyx_selection');
  assert.deepEqual(readTool._meta.ui.visibility,['model']);
  assert.deepEqual(writeTool._meta.ui.visibility,['model']);
  assert.deepEqual(readTool.annotations,{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});
  assert.deepEqual(writeTool.annotations,{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false});
  assert.equal(readTool.inputSchema.additionalProperties,false);
  const schema=writeTool.inputSchema;
  assert.equal(schema.additionalProperties,false);
  assert.equal(schema.properties.selection.additionalProperties,false);
  assert.equal(schema.properties.selection.properties.start.items.additionalProperties,false);
  assert.equal(schema.properties.replacement.additionalProperties,false);
  assert.equal(schema.properties.selection.properties.start.maxItems,64);
  assert.equal(schema.properties.selection.properties.text.maxLength,128*1024);
  assert.equal(schema.properties.replacement.properties.text.maxLength,128*1024);
  const relay=tools.find(tool=>tool.name==='native_lyx_rpc');
  assert.deepEqual(relay._meta.ui.visibility,['app']);
  assert.deepEqual(relay.inputSchema.properties.method.enum,['frame','input','selection','state','dispatch','clipboard']);
  assert.equal(tools.find(tool=>tool.name==='view_lyx_file')._meta.ui.resourceUri,'ui://lyx-preview/native-editor-v3');
});

test('read returns the active unsaved native snapshot, exact source revision and selection positions',async t=>{
  const calls=[];
  const client=await connect(t,async call=>{calls.push(call);return snapshot({token:'must not escape',url:'http://private.invalid'});});
  const result=await read(client);
  assert.ok(!result.isError);
  assert.deepEqual(calls,[{sessionId,method:'selection',params:{}}]);
  assert.deepEqual(data(result),{...snapshot(),sessionId,editingSupported:true});
  assert.equal(data(result).modified,true,'The snapshot is not replaced with the saved disk file');
  assert.equal(JSON.stringify(result).includes('must not escape'),false);
});

test('read hashes source from an old kernel and reports replacement unsupported',async t=>{
  const previous=snapshot();
  delete previous.sourceRevision;
  delete previous.capabilities;
  const client=await connect(t,async()=>previous);
  const result=await read(client);
  assert.ok(!result.isError);
  assert.equal(data(result).sourceRevision,hash(source));
  assert.equal(data(result).source,source);
  assert.equal(data(result).editingSupported,false);
});

for(const capabilities of [{editSelection:true},{editSelection:true,compositionGuard:false},{compositionGuard:true}])
  test(`read keeps older sessions available without advertising safe model editing (${JSON.stringify(capabilities)})`,async t=>{
    const client=await connect(t,async()=>snapshot({capabilities}));
    const result=await read(client);
    assert.ok(!result.isError);
    assert.equal(data(result).source,source);
    assert.deepEqual(data(result).capabilities,capabilities);
    assert.equal(data(result).editingSupported,false);
  });

test('read preserves the native inputPending signal without declaring pending edits applied',async t=>{
  const responses=[true,false];
  const client=await connect(t,async()=>snapshot({inputPending:responses.shift()}));
  assert.equal(data(await read(client)).inputPending,true);
  assert.equal(data(await read(client)).inputPending,false);
});

test('read preserves unfinished composition after queued input ends without exposing UI geometry',async t=>{
  const states=[true,false];
  const client=await connect(t,async()=>snapshot({inputPending:false,inputMethod:{
    enabled:true,composing:states.shift(),surface:'native-widget-id',
    rect:{x:10,y:20,width:1,height:18},surroundingText:'must not escape',
  }}));
  for(const composing of [true,false]){
    const result=await read(client);
    assert.ok(!result.isError);
    assert.equal(data(result).inputPending,false);
    assert.deepEqual(data(result).inputMethod,{enabled:true,composing});
    assert.equal(JSON.stringify(result).includes('must not escape'),false);
    assert.equal(JSON.stringify(result).includes('native-widget-id'),false);
  }
});

test('read refuses a native source revision that does not match the returned source',async t=>{
  const client=await connect(t,async()=>snapshot({sourceRevision:'a'.repeat(64)}));
  const result=await read(client);
  assert.equal(result.isError,true);
  assert.match(data(result).message,/does not match its source revision/);
});

test('read rejects incomplete and explicit-error responses instead of reporting a snapshot',async t=>{
  const responses=[undefined,{ok:true},{ready:false},{error:true,message:'session unavailable'},snapshot({sourceRevision:'invalid'})];
  const client=await connect(t,async()=>responses.shift());
  for(let index=0;index<5;index++){
    const result=await read(client);
    assert.equal(result.isError,true);
    assert.equal(data(result).error,true);
    assert.equal(data(result).source,undefined);
  }
});

test('read and write reject unknown sessions without opening documents or dispatching edits',async t=>{
  const calls=[];
  const client=await connect(t,async call=>{calls.push(call);throw new Error('LyX session not found');});
  const readResult=await read(client),writeResult=await replace(client);
  for(const result of [readResult,writeResult]){
    assert.equal(result.isError,true);
    assert.match(data(result).message,/session not found/);
  }
  assert.equal(data(writeResult).applied,false);
  assert.deepEqual(calls.map(call=>call.method),['selection','state']);
});

test('strict schemas reject extra URLs, invalid selection data, unbounded text and invalid revisions before RPC',async t=>{
  let calls=0;
  const client=await connect(t,async()=>{calls++;assert.fail('Invalid arguments must not reach native RPC');});
  for(const extra of [{url:'https://example.invalid'},{sessionId:''},{sessionId:'x'.repeat(129)}]){
    const result=await client.callTool({name:'read_native_lyx',arguments:{sessionId,...extra}});
    assert.equal(result.isError,true);
  }
  const edits=[
    value=>{value.url='https://example.invalid';},
    value=>{value.selection.url='https://example.invalid';},
    value=>{value.selection.start[0].command='buffer-write';},
    value=>{value.replacement.save=true;},
    value=>{value.selection.kind='widget';},
    value=>{value.selection.hasSelection=false;},
    value=>{value.selection.start=[];},
    value=>{value.selection.start=Array.from({length:65},()=>({...start[0]}));},
    value=>{value.selection.start[0].position=-1;},
    value=>{value.selection.start[0].position=1.5;},
    value=>{value.selection.start[0].cell=2147483648;},
    value=>{value.selection.text='x'.repeat(128*1024+1);},
    value=>{value.replacement.text='x'.repeat(128*1024+1);},
    value=>{value.replacement.text='bad\0text';},
    value=>{value.replacement.format='latex-source';},
    value=>{value.sourceRevision='not a source hash';},
    value=>{value.path='x'.repeat(4097);},
  ];
  for(const edit of edits){
    const value=args();edit(value);
    const result=await replace(client,value);
    assert.equal(result.isError,true,edit.toString());
  }
  assert.equal(calls,0);
});

for(const capabilities of [undefined,{}, {editSelection:false},{editSelection:'true'},
  {editSelection:true},{editSelection:true,compositionGuard:false},
  {editSelection:true,compositionGuard:'true'},{compositionGuard:true}])
  test(`write refuses an old or unsupported kernel (${JSON.stringify(capabilities)}) before mutation`,async t=>{
    const calls=[];
    const client=await connect(t,async call=>{calls.push(call);return {ready:true,capabilities};});
    const result=await replace(client);
    assert.equal(result.isError,true);
    assert.equal(data(result).applied,false);
    assert.equal(data(result).outcome,'not_applied');
    assert.match(data(result).message,/does not support guarded model replacement/);
    assert.match(data(result).message,/Reading and manual editing remain available/);
    assert.deepEqual(calls,[{sessionId,method:'state',params:{}}]);
  });

for(const format of ['text','math'])
  test(`write forwards guarded ${format} replacement and returns the atomic native result without saving`,async t=>{
    const calls=[],replacement={format,text:format==='math'?'x^{2}+α':'New α text'};
    const changedSource=source.replace('Original',replacement.text);
    const final=snapshot({source:changedSource,sourceRevision:hash(changedSource),hasSelection:false,selection:'',selectionStart:end,
      clipboardSelection:{kind:'document',hasSelection:false,text:'',start:end,end},applied:true,previousSourceRevision:hash(source)});
    const client=await connect(t,async call=>{
      calls.push(call);
      if(call.method==='state')return {ready:true,capabilities:{editSelection:true,compositionGuard:true}};
      return final;
    });
    const result=await replace(client,args({replacement,sourceRevision:hash(source).toUpperCase()}));
    assert.ok(!result.isError);
    assert.deepEqual(calls,[
      {sessionId,method:'state',params:{}},
      {sessionId,method:'clipboard',params:{action:'replace-selection',path,sourceRevision:hash(source),selection:selected,replacement,trackChanges:false}},
    ]);
    assert.equal(data(result).applied,true);
    assert.equal(data(result).source,changedSource);
    assert.equal(data(result).sourceRevision,hash(changedSource));
    assert.equal(data(result).previousSourceRevision,hash(source));
    assert.equal(data(result).modified,true);
    assert.deepEqual(data(result).clipboardSelection,final.clipboardSelection);
  });

test('an empty text replacement remains a valid explicit deletion',async t=>{
  let replacement;
  const client=await connect(t,async call=>{
    if(call.method==='state')return {ready:true,capabilities:{editSelection:true,compositionGuard:true}};
    replacement=call.params.replacement;
    return {...snapshot(),applied:true};
  });
  const result=await replace(client,args({replacement:{format:'text',text:''}}));
  assert.ok(!result.isError);
  assert.deepEqual(replacement,{format:'text',text:''});
});

for(const code of ['revision_conflict','selection_conflict','document_mismatch','input_pending'])
  test(`native ${code} is a clear rejection and never an applied result`,async t=>{
    const client=await connect(t,async call=>call.method==='state'?{ready:true,capabilities:{editSelection:true,compositionGuard:true}}
      :{error:true,code,message:'Read the latest native state before editing'});
    const result=await replace(client);
    assert.equal(result.isError,true);
    assert.equal(data(result).code,code);
    assert.equal(data(result).applied,false);
    assert.equal(data(result).outcome,'not_applied');
  });

test('transport-preserved native conflict errors are rejected just like direct native errors',async t=>{
  const client=await connect(t,async call=>{
    if(call.method==='state')return {ready:true,capabilities:{editSelection:true,compositionGuard:true}};
    throw Object.assign(new Error('Selection changed'),{code:'selection_conflict'});
  });
  const result=await replace(client);
  assert.equal(result.isError,true);
  assert.equal(data(result).applied,false);
  assert.equal(data(result).code,'selection_conflict');
});

test('a write timeout has an unknown outcome and must be read before any retry',async t=>{
  const client=await connect(t,async call=>{
    if(call.method==='state')return {ready:true,capabilities:{editSelection:true,compositionGuard:true}};
    throw new Error('Native request timed out');
  });
  const result=await replace(client);
  assert.equal(result.isError,true);
  assert.equal(data(result).outcome,'unknown');
  assert.equal(data(result).readBeforeRetry,true);
  assert.equal(Object.hasOwn(data(result),'applied'),false,'A timeout does not prove that no edit happened');
  assert.match(data(result).message,/read_native_lyx/);
});

for(const response of [{ready:true},{error:true,message:'unknown native failure'},null])
  test(`an unconfirmed native write response is never treated as success (${JSON.stringify(response)})`,async t=>{
    const client=await connect(t,async call=>call.method==='state'?{ready:true,capabilities:{editSelection:true,compositionGuard:true}}:response);
    const result=await replace(client);
    assert.equal(result.isError,true);
    assert.equal(data(result).outcome,'unknown');
    assert.equal(data(result).readBeforeRetry,true);
    assert.equal(Object.hasOwn(data(result),'applied'),false);
  });

for(const kind of ['direct-error','transport-error','invalid-snapshot'])
  test(`a confirmed mutation with a failed snapshot forbids blind retry (${kind})`,async t=>{
    const client=await connect(t,async call=>{
      if(call.method==='state')return {ready:true,capabilities:{editSelection:true,compositionGuard:true}};
      const error={error:true,applied:true,code:'snapshot_failed',message:'Native edit completed but snapshot failed'};
      if(kind==='transport-error')throw Object.assign(new Error(error.message),{applied:true,code:error.code});
      return kind==='invalid-snapshot'?{applied:true,source:'incomplete'}:error;
    });
    const result=await replace(client);
    assert.equal(result.isError,true);
    assert.equal(data(result).applied,true);
    assert.equal(data(result).outcome,'applied');
    assert.equal(data(result).readBeforeRetry,true);
    assert.match(data(result).message,/The edit was applied/);
  });

test('AI edits default to tracked changes and refuse silent fallback on an older engine',async t=>{
  const calls=[];let supported=false;
  const client=await connect(t,async call=>{
    calls.push(call);
    if(call.method==='state')return snapshot({capabilities:{editSelection:true,compositionGuard:true,trackedReplacement:supported}});
    return {...snapshot(),applied:true,tracked:true};
  });
  const input=args();delete input.trackChanges;
  let result=await replace(client,input);
  assert.equal(result.isError,true);assert.equal(calls.length,1);assert.equal(data(result).outcome,'not_applied');
  supported=true;result=await replace(client,input);
  assert.ok(!result.isError);assert.equal(calls.at(-1).params.trackChanges,true);assert.equal(data(result).tracked,true);
});

test('compact AI edits default to tracking and check engine support before any mutation',async t=>{
  const calls=[];let supported=false;
  const client=await connect(t,async call=>{
    calls.push(call);
    if(call.method==='state')return {ready:true,capabilities:{trackedReplacement:supported}};
    return {...receipt(),tracked:true};
  });
  const input={sessionId,snapshotId:targetId,replacement:{format:'text',text:'Replacement'}};
  let result=await client.callTool({name:'replace_native_lyx_snapshot',arguments:input});
  assert.equal(result.isError,true);assert.equal(data(result).outcome,'not_applied');
  assert.equal(calls.length,1);assert.equal(calls[0].method,'state');
  supported=true;
  result=await client.callTool({name:'replace_native_lyx_snapshot',arguments:input});
  assert.ok(!result.isError);assert.equal(data(result).tracked,true);
  assert.equal(calls.at(-1).method,'clipboard');assert.equal(calls.at(-1).params.trackChanges,true);
});

test('review tools preserve anchored comments and report stale or uncertain operations accurately',async t=>{
  const calls=[];let outcome='success';
  const comment={id:'8aa32010-d5ec-4da3-997e-01a603b84321',quote:'Original',text:'Add evidence.',resolved:false,anchor:start};
  const client=await connect(t,async call=>{
    calls.push(call);
    if(call.method==='state')return snapshot({capabilities:{review:true,compositionGuard:true}});
    if(outcome==='stale')return {error:true,code:'revision_conflict',message:'Read again'};
    if(outcome==='unknown')throw new Error('Lost reply');
    return {...snapshot(),applied:true,review:{tracking:false,comments:[comment]}};
  });
  const input={sessionId,path,sourceRevision:hash(source),operation:'comment-add',selection:selected,text:comment.text};
  let result=await client.callTool({name:'review_native_lyx',arguments:input});
  assert.ok(!result.isError);assert.deepEqual(data(result).review.comments,[comment]);
  assert.equal(calls.at(-1).params.action,'review');assert.equal(calls.at(-1).params.text,comment.text);
  outcome='stale';result=await client.callTool({name:'review_native_lyx',arguments:input});
  assert.equal(data(result).outcome,'not_applied');
  outcome='unknown';result=await client.callTool({name:'review_native_lyx',arguments:input});
  assert.equal(data(result).outcome,'unknown');assert.equal(data(result).readBeforeRetry,true);
});

for(const code of ['revision_conflict','selection_conflict','document_mismatch','input_pending'])
  test(`native ${code} is a clear rejection and never an applied result`,async t=>{
    const client=await connect(t,async call=>call.method==='state'?{ready:true,capabilities:{editSelection:true,compositionGuard:true}}
      :{error:true,code,message:'Read the latest native state before editing'});
    const result=await replace(client);
    assert.equal(result.isError,true);
    assert.equal(data(result).code,code);
    assert.equal(data(result).applied,false);
    assert.equal(data(result).outcome,'not_applied');
  });
