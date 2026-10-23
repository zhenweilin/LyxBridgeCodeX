import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {addNativeSelectionToChat} from '../web/native-chat.mjs';

const selection={hasSelection:true,path:'/documents/example.lyx',selection:'First line\nx^{2}',
  selectionStart:[{paragraph:1,position:0,cell:0}],selectionEnd:[{paragraph:2,position:3,cell:0}],
  diskRevision:'disk-hash',modified:true,source:'Native source with an unsaved formula',
  clipboardSelection:{kind:'document',hasSelection:true,text:'First line\nx^{2}',
    start:[{paragraph:1,position:0,cell:0}],end:[{paragraph:2,position:3,cell:0}]}};

function assertSinglePassage(context,text){
  const encoded=JSON.stringify(text).slice(1,-1);
  assert.equal(JSON.stringify(context).split(encoded).length-1,1,'The complete attachment must include the passage exactly once');
}

test('add to chat attaches selection context without accessing the composer or including full document source',async()=>{
  let current;
  const result=await addNativeSelectionToChat({...selection,capabilities:{editSelection:true,compositionGuard:true}},{
    modelContext:{update:async value=>{current={...value,updateId:'accepted-1'};return {updateId:'accepted-1'};},getCurrent:()=>current},
    get message(){throw new Error('Selection context must not access the composer');}
  },{sessionId:'live-native-session'});
  assert.equal(Object.hasOwn(current.structuredContent,'source'),false);
  assert.ok(!JSON.stringify(current).includes(selection.source),'Full source is read on demand, not attached to each selection');
  assert.equal(current.structuredContent.file,selection.path);
  assert.equal(current.content[0].text,`LyX selection · example.lyx\n\n${selection.selection}`);
  assertSinglePassage(current,selection.selection);
  assert.equal(current.structuredContent.text,undefined);
  assert.equal(current.structuredContent.diskRevision,undefined);
  assert.equal(current.structuredContent.sessionId,'live-native-session');
  assert.equal(current.structuredContent.editingSupported,true);
  assert.equal(current.structuredContent.clipboardSelection,undefined);
  assert.deepEqual(current.structuredContent.range,{start:selection.selectionStart,end:selection.selectionEnd});
  assert.equal(current.structuredContent.bufferRevision,createHash('sha256').update(selection.source).digest('hex'));
  assert.doesNotMatch(current.content[0].text,/revision|session|undefined|\{"/);
  assert.deepEqual(result,{updateId:'accepted-1',contextVerified:true,contextAttached:true,snapshotAttached:false});
});

test('unconfirmed or unavailable context is not reported as add to chat success',async()=>{
  await assert.rejects(addNativeSelectionToChat(selection,{
    modelContext:{update:async()=>undefined}
  }),/not confirmed the selection context/);
  await assert.rejects(addNativeSelectionToChat(selection,{
    modelContext:{update:async()=>{throw new Error('Host rejected context');}}
  }),/Host rejected context/);
  await assert.rejects(addNativeSelectionToChat(selection,{}),/selection context interface/);
});

test('dialog-field selection cannot be attached as the document selection',async()=>{
  let called=false;
  const extensions={modelContext:{update:async()=>{called=true;}},message:{send:async()=>{called=true;}}};
  await assert.rejects(addNativeSelectionToChat({...selection,clipboardSelection:{kind:'widget'}},extensions),/LyX document/);
  assert.equal(called,false);
});

test('native snapshots attach a direct edit target without source hashing or repeating the selection',async()=>{
  let current;
  const snapshotId='94967851-1772-4cb8-a958-002606a48fab';
  await addNativeSelectionToChat({...selection,source:undefined,sourceRevision:undefined,snapshotId,selectionFormat:'text',
    modelCapabilities:{selectionSnapshots:true}},
    {modelContext:{update:async value=>{current=value;return {updateId:'compact'};}}},
    {sessionId:'session',crypto:{get subtle(){assert.fail('Native revision must avoid browser hashing');}}});
  assert.equal(current.structuredContent.snapshotId,snapshotId);
  assert.equal(current.structuredContent.format,'text');
  assert.equal(current.structuredContent.bufferRevision,undefined,'Revision validation stays in the native snapshot');
  assert.equal(current.structuredContent.clipboardSelection,undefined);
  assert.equal(current.content[0].text,`LyX selection · example.lyx\n\n${selection.selection}`);
  assertSinglePassage(current,selection.selection);
  assert.doesNotMatch(current.content[0].text,/replace_native|snapshot|revision|session/);
});

test('multiline Unicode and math selections are preserved once without display metadata',async()=>{
  for(const text of ['  中文 αβ\n\n第二段  ','\\frac{x_1}{x_2} + \\sum_{i=1}^n y_i']){
    let current;
    await addNativeSelectionToChat({...selection,selection:text,diskRevision:undefined,sourceRevision:'b'.repeat(64)},
      {modelContext:{update:async value=>{current=value;return {updateId:'unicode'};}}},{sessionId:'session'});
    assert.equal(current.content[0].text,`LyX selection · example.lyx\n\n${text}`);
    assertSinglePassage(current,text);
    assert.doesNotMatch(JSON.stringify(current),/undefined|diskRevision/);
  }
});

test('missing source and revision cannot fabricate a usable selection revision',async()=>{
  await assert.rejects(addNativeSelectionToChat({...selection,source:undefined},{modelContext:{}}),/document revision/);
});

for(const modelCapabilities of [undefined,{}, {selectionSnapshots:false},{selectionSnapshots:'true'}])
  test(`a new native engine behind an older MCP service uses available legacy editing (${JSON.stringify(modelCapabilities)})`,async()=>{
    let current;
    const result=await addNativeSelectionToChat({...selection,source:undefined,sourceRevision:'a'.repeat(64),
      snapshotId:'94967851-1772-4cb8-a958-002606a48fab',selectionFormat:'text',modelCapabilities,
      capabilities:{editSelection:true,compositionGuard:true,selectionSnapshots:true}},
      {modelContext:{update:async value=>{current=value;return {updateId:'legacy'};}}},
      {sessionId:'session'});
    assert.equal(current.structuredContent.snapshotId,undefined,'Native capabilities alone do not register a model tool');
    assert.equal(current.structuredContent.editingSupported,true);
    assert.deepEqual(current.structuredContent.range,{start:selection.selectionStart,end:selection.selectionEnd});
    assertSinglePassage(current,selection.selection);
    assert.doesNotMatch(current.content[0].text,/replace_native_lyx_snapshot/);
    assert.equal(result.snapshotAttached,false);
  });
