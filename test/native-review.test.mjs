import test from 'node:test';
import assert from 'node:assert/strict';
import {addNativeCommentsToChat} from '../web/native-review.mjs';

const comments=[{id:'a',text:'Add a citation.',quote:'First passage',resolved:false,anchor:[{paragraph:1,position:4,cell:0}]},
  {id:'b',text:'Explain the exponent. 中文',quote:'x^{2}',resolved:false,anchor:[{paragraph:4,position:9,cell:0}]}];
const snapshot={path:'/paper.lyx',sourceRevision:'revision',source:'Never attach the full document',modified:true,review:{comments}};
test('multiple annotation locations attach in one context update without touching or sending the draft',async()=>{
  const updates=[];
  const extensions={modelContext:{update:async value=>{updates.push(value);return {updateId:'batch-1'};}},
    get message(){throw new Error('Do not touch the composer or send messages');}};
  assert.deepEqual(await addNativeCommentsToChat(snapshot,['b','a'],extensions,{sessionId:'session'}),{updateId:'batch-1',count:2});
  assert.equal(updates.length,1);assert.deepEqual(updates[0].structuredContent.comments,[comments[1],comments[0]]);
  assert.equal(updates[0].structuredContent.sessionId,'session');assert.equal(updates[0].structuredContent.unsaved,true);
  assert.ok(!JSON.stringify(updates).includes(snapshot.source));
  assert.match(updates[0].content[0].text,/not replacement selections/);
});
test('missing, duplicated, empty and unconfirmed annotation batches never claim successful attachment',async()=>{
  let calls=0;const ext={modelContext:{update:async()=>{calls++;return {};}}};
  await assert.rejects(addNativeCommentsToChat(snapshot,[],ext),/at least one/);
  await assert.rejects(addNativeCommentsToChat(snapshot,['missing'],ext),/missing or duplicated/);
  await assert.rejects(addNativeCommentsToChat({...snapshot,review:{comments:[comments[0],comments[0]]}},['a'],ext),/duplicated/);
  assert.equal(calls,0);
  await assert.rejects(addNativeCommentsToChat(snapshot,['a'],ext),/not confirmed/);
  assert.equal(calls,1);
});
