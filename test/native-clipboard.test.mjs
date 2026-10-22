import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {NativeClipboardStore} from '../lib/native-clipboard.mjs';
import {writeBrowserClipboard,readBrowserClipboard,captureBrowserPaste,maxClipboardImageBytes,encodeClipboardText,decodeClipboardText} from '../web/native-clipboard.mjs';
import {createNativeInputQueue} from '../web/native-input-queue.mjs';

test('fast copy/paste waits for the exact native snapshot, not a stale selection cache',async()=>{
  const store=new NativeClipboardStore(),copyId=randomUUID();
  let complete;
  const nativeOperation=new Promise(resolve=>complete=resolve);
  store.copy(copyId,()=>nativeOperation);
  const values=new Map(),data={setData:(k,v)=>values.set(k,v),getData:k=>values.get(k)??''};
  writeBrowserClipboard(data,{text:'中文 x²',copyId});
  const paste=readBrowserClipboard(data);
  const resolving=store.resolve(paste.copyId,paste.formats);
  const formats={'application/x-lyx':encodeClipboardText('\\begin_inset Formula $x^{2}$')};
  complete({clipboard:{formats}});
  assert.deepEqual(await resolving,formats);
  assert.equal(values.get('text/plain'),'中文 x²');
});
test('prepared native MIME survives reconnect; external multiline paste retains text and HTML',async()=>{
  const copyId=randomUUID(),formats={'application/x-lyx':encodeClipboardText('公式 α²'),'text/html':encodeClipboardText('<b>α²</b>')};
  const values=new Map(),data={setData:(k,v)=>values.set(k,v),getData:k=>values.get(k)??''};
  writeBrowserClipboard(data,{copyId,text:'α²',clipboard:{formats}});
  const pasted=readBrowserClipboard(data);
  assert.deepEqual(await new NativeClipboardStore().resolve(pasted.copyId,pasted.formats),formats);
  assert.equal(values.get('application/x-lyx'),'公式 α²');
  const external=readBrowserClipboard({getData:k=>k==='text/plain'?'第一段\n第二段':''});
  assert.equal(decodeClipboardText(external.formats['text/plain']),'第一段\n第二段');
});
test('expired native reference is reported rather than silently flattening formulas',async()=>{
  await assert.rejects(new NativeClipboardStore().resolve(randomUUID()),/copy the selection again/);
});
test('retrying a cut request does not cut the document twice',async()=>{
  const store=new NativeClipboardStore(),copyId=randomUUID();let calls=0;
  const cut=()=>{calls++;return {clipboard:{formats:{'text/plain':encodeClipboardText('cut once')}}};};
  await Promise.all([store.copy(copyId,cut),store.copy(copyId,cut)]);
  assert.equal(calls,1);
  assert.throws(()=>store.copy('invalid',cut),/Invalid clipboard ID/);
  assert.equal(calls,1);
});

test('paste captures its image during the browser event and reads bytes in the reserved queue position',async()=>{
  let eventActive=true,reads=0,release;
  const pending=new Promise(resolve=>{release=resolve;});
  const file={type:'image/png',size:3,arrayBuffer(){reads++;return pending;}};
  const paste=captureBrowserPaste({getData:()=>'',items:[{kind:'file',getAsFile(){
    assert.equal(eventActive,true);return file;
  }}]});
  eventActive=false;
  assert.equal(reads,0,'Capturing a File must not start an unordered asynchronous operation');
  const queue=createNativeInputQueue(),events=[];
  const image=queue.enqueue(async()=>{events.push('image-start');const result=await paste.prepare();events.push(result.image);});
  const typing=queue.enqueue(()=>events.push('typing-after-paste'));
  await Promise.resolve();
  assert.deepEqual(events,['image-start']);
  release(Uint8Array.of(137,80,78).buffer);
  await Promise.all([image,typing]);
  assert.deepEqual(events,['image-start',{mimeType:'image/png',data:'iVBO'},'typing-after-paste']);
});

test('native and normal rich text keep priority over clipboard files',()=>{
  for(const mime of ['application/x-lyx','text/html','text/plain']){
    const result=captureBrowserPaste({getData:type=>type===mime?'existing rich content':'',get items(){assert.fail('Text paste must not read image items');}});
    assert.equal(result.prepare,undefined);
    assert.equal(decodeClipboardText(result.payload.formats[mime]),'existing rich content');
  }
  const copyId=randomUUID();
  assert.equal(captureBrowserPaste({getData:type=>type==='application/x-lyx-codex'?JSON.stringify({version:1,copyId}):'',
    get items(){assert.fail('Native snapshot takes priority');}}).payload.copyId,copyId);
});

test('image paste reports unsupported, multiple, empty, oversized and unreadable files',async()=>{
  const file=(type,size,arrayBuffer=async()=>new ArrayBuffer(size))=>({type,size,arrayBuffer});
  const capture=(...files)=>captureBrowserPaste({getData:()=>'',items:files.map(file=>({kind:'file',getAsFile:()=>file}))});
  assert.throws(()=>capture(file('image/gif',10)),/PNG and JPEG/);
  assert.throws(()=>capture(file('image/png',1),file('image/jpeg',1)),/one PNG or JPEG/);
  assert.throws(()=>capture(null),/PNG and JPEG/);
  assert.throws(()=>capture(file('image/png',0)),/empty or invalid/);
  assert.throws(()=>capture(file('image/png',maxClipboardImageBytes+1)),/8 MiB/);
  await assert.rejects(capture(file('image/png',2,async()=>new ArrayBuffer(1))).prepare(),/size changed/);
  await assert.rejects(capture(file('image/jpeg',2,async()=>{throw new Error('Clipboard file is unreadable');})).prepare(),/unreadable/);
  assert.deepEqual(captureBrowserPaste({getData:()=>'',items:[]}),{payload:{formats:{}}});
  const fallback=captureBrowserPaste({getData:()=>'',files:[file('image/jpeg',1)]});
  assert.equal((await fallback.prepare()).image.mimeType,'image/jpeg');
});
