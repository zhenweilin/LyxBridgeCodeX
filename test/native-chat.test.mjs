import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {addNativeSelectionToChat} from '../web/native-chat.mjs';

const selection={hasSelection:true,path:'/documents/example.lyx',selection:'First line\nx^{2}',
  selectionStart:[{paragraph:1,position:0}],selectionEnd:[{paragraph:2,position:3}],
  diskRevision:'disk-hash',modified:true,source:'Native source with an unsaved formula',
  clipboardSelection:{kind:'document',hasSelection:true}};

test('add to chat attaches selection context without accessing the composer or including full document source',async()=>{
  let current;
  const result=await addNativeSelectionToChat({...selection,capabilities:{editSelection:true,compositionGuard:true}},{
    modelContext:{update:async value=>{current={...value,updateId:'accepted-1'};return {updateId:'accepted-1'};},getCurrent:()=>current},
    get message(){throw new Error('Selection context must not access the composer');}
  },{sessionId:'live-native-session'});
  assert.equal(Object.hasOwn(current.structuredContent,'source'),false);
  assert.ok(!JSON.stringify(current).includes(selection.source),'Full source is read on demand, not attached to each selection');
  assert.equal(current.structuredContent.file,selection.path);
  assert.equal(current.structuredContent.text,selection.selection);
  assert.equal(current.structuredContent.diskRevision,selection.diskRevision);
  assert.equal(current.structuredContent.unsaved,true);
  assert.equal(current.structuredContent.sessionId,'live-native-session');
  assert.equal(current.structuredContent.editingSupported,true);
  assert.deepEqual(current.structuredContent.clipboardSelection,selection.clipboardSelection);
  assert.deepEqual(current.structuredContent.start,selection.selectionStart);
  assert.deepEqual(current.structuredContent.end,selection.selectionEnd);
  assert.equal(current.structuredContent.bufferRevision,createHash('sha256').update(selection.source).digest('hex'));
  assert.deepEqual(result,{updateId:'accepted-1',contextVerified:true,contextAttached:true});
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
