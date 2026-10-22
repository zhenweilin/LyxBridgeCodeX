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
  return {sessionId,path,sourceRevision:hash(source),selection:structuredClone(selected),replacement:{format:'text',text:'Replacement'},...overrides};
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
function data(result){
  assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent,'Model text and structured output must agree');
  return result.structuredContent;
}

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
      {sessionId,method:'clipboard',params:{action:'replace-selection',path,sourceRevision:hash(source),selection:selected,replacement}},
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
