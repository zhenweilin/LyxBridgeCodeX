import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverExternalLyxFormats} from '../lib/system-clipboard.mjs';
import {externalLyxPasteParams,encodeClipboardText} from '../web/native-clipboard.mjs';
import {createServer} from '../server/mcp.mjs';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';

const plain='Here f:\\mbb R^{d}\\to\\mbb R is finite and convex.';
const formats={'text/plain':encodeClipboardText(plain),'text/html':encodeClipboardText(
  '<meta name="generator" content="LyX 2.4.4"><div id="magicparlabel-12">Here <math>x</math></div>')};
const lyx=Buffer.from('#LyX 2.4\n\\lyxformat 620\n\\begin_document\n\\begin_body\n\\end_body\n\\end_document\n').toString('base64');

test('desktop LyX paste requires the original representation and old hosts cannot flatten its formulas',()=>{
  assert.equal(externalLyxPasteParams({formats},{externalLyxPaste:true}).recoverExternalLyx,'required');
  assert.throws(()=>externalLyxPasteParams({formats},{}),/Reload the plugin connection/);
  const ordinary={formats:{'text/plain':encodeClipboardText('ordinary text')}};
  assert.equal(externalLyxPasteParams(ordinary,{}),ordinary);
  assert.equal(externalLyxPasteParams(ordinary,{externalLyxPaste:true}).recoverExternalLyx,'prefer');
  for(const payload of [{copyId:'native-snapshot',formats},{formats:{'application/x-lyx':lyx}},
    {formats:{'text/html':formats['text/html']}}])assert.equal(externalLyxPasteParams(payload,{}),payload);
});

test('native MIME bytes are recovered only for the browser event text; no HTML importer is involved',async()=>{
  const result=await recoverExternalLyxFormats(formats,{required:true,read:async text=>{
    assert.equal(text,plain);return {status:'matched',lyx};
  }});
  assert.deepEqual(result,{'application/x-lyx':lyx});
  const binary=Buffer.from([0xff,0x80,0,0x61]).toString('base64');
  assert.equal((await recoverExternalLyxFormats(formats,{read:async()=>({status:'matched',lyx:binary})}))['application/x-lyx'],binary);
});

test('changed and unavailable system clipboards cannot turn a known LyX paste into plain text',async()=>{
  for(const status of ['mismatch','unavailable']){
    await assert.rejects(recoverExternalLyxFormats(formats,{required:true,read:async()=>({status})}),/no longer matches/);
    assert.equal(await recoverExternalLyxFormats(formats,{read:async()=>({status})}),formats);
  }
  await assert.rejects(recoverExternalLyxFormats(formats,{read:async()=>({status:'invalid'})}),/invalid or exceeds/);
  await assert.rejects(recoverExternalLyxFormats(formats,{read:async()=>({status:'matched',lyx:'bad base64'})}),/Invalid/);
  await assert.rejects(recoverExternalLyxFormats(formats,{read:async()=>({status:'unexpected'})}),/Invalid native/);
  await assert.rejects(recoverExternalLyxFormats({'text/plain':'bad base64'},{read:async()=>assert.fail('Invalid input must not read the system clipboard')}),/Invalid/);
});

async function relay(t,{rpc,externalClipboard,externalClipboardAvailable=true}){
  const server=createServer({rpc,externalClipboard,externalClipboardAvailable});
  const client=new Client({name:'external-paste-test',version:'1.0'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  t.after(async()=>{await client.close();await server.close();});
  await server.connect(a);await client.connect(b);
  return params=>client.callTool({name:'native_lyx_rpc',arguments:{sessionId:'paste-target',method:'clipboard',params}});
}

test('the real MCP relay forwards recovered bytes to the existing engine once and preserves target guards',async t=>{
  const calls=[];
  const call=await relay(t,{externalClipboard:async(value,options)=>{
    assert.deepEqual(value,formats);assert.equal(options.required,true);return {'application/x-lyx':lyx};
  },rpc:async request=>{calls.push(request);return {ready:true,path:'/target.lyx'};}});
  const result=await call({action:'paste',formats,recoverExternalLyx:'required',expectedPath:'/target.lyx'});
  assert.equal(result.isError,undefined);
  assert.deepEqual(calls,[{sessionId:'paste-target',method:'clipboard',params:{action:'paste',formats:{'application/x-lyx':lyx},expectedPath:'/target.lyx'}}]);
  assert.equal(result._meta['lyx/ui'].externalLyxPaste,true);
  assert.deepEqual(result._meta['lyx/rpc'],{ready:true,path:'/target.lyx'});
});

test('failed recovery and unsupported hosts issue no native paste; ordinary and native-copy pastes do not read the system clipboard',async t=>{
  let writes=0,reads=0;
  const call=await relay(t,{rpc:async()=>{writes++;return {ready:true};},externalClipboard:async()=>{reads++;throw new Error('Clipboard changed');}});
  assert.equal((await call({action:'paste',formats,recoverExternalLyx:'required'})).isError,true);
  assert.equal(writes,0);assert.equal(reads,1);
  for(const params of [{action:'paste',formats},{action:'paste',copyId:'id',formats}])await call(params);
  assert.equal(writes,2);assert.equal(reads,1);
  for(const extra of [{copyId:'id'},{image:{}},{action:'copy'},{recoverExternalLyx:'yes'}])
    assert.equal((await call({action:'paste',formats,recoverExternalLyx:'required',...extra})).isError,true);
  assert.equal(writes,2);assert.equal(reads,1);
  const unavailable=await relay(t,{externalClipboardAvailable:false,rpc:async()=>assert.fail('No paste'),externalClipboard:async()=>assert.fail('No clipboard read')});
  assert.equal((await unavailable({action:'paste',formats,recoverExternalLyx:'required'})).isError,true);
});
