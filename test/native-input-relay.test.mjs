import test from 'node:test';
import assert from 'node:assert/strict';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {createServer} from '../server/mcp.mjs';

async function connect(t,rpc,{reopenNative=async()=>assert.fail('No native process may be reopened')}={}){
  const server=createServer({rpc,reopenNative,openNative:async()=>assert.fail('No native process may be opened')});
  const client=new Client({name:'native-input-relay-test',version:'1.0.0'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  t.after(async()=>{await client.close();await server.close();});
  await server.connect(a);await client.connect(b);return client;
}
const relay=(client,method,params)=>client.callTool({name:'native_lyx_rpc',arguments:{sessionId:'origin-session',method,params}});
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('one MCP input call returns the subsequent state from the same native session, after its acknowledgement',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve),calls=[];
  const after={ready:true,path:'/origin.lyx',inputPending:false,selection:'Updated selection'};
  const client=await connect(t,async(args,options)=>{
    calls.push({args,options});
    if(args.method==='input'){await gate;return {ready:true,inputPending:true,selection:'Old selection'};}
    return after;
  });
  const pending=relay(client,'input',{type:'wheel',dy:-25,replyWithState:true});
  await flush();
  assert.deepEqual(calls.map(call=>call.args),[
    {sessionId:'origin-session',method:'input',params:{type:'wheel',dy:-25}},
  ],'The option stays in the relay, and state cannot overtake the input acknowledgement');
  release();const result=await pending;
  assert.ok(!result.isError);assert.deepEqual(result.content,[]);assert.equal(result.structuredContent,undefined);
  assert.deepEqual(result._meta['lyx/rpc'],{...after,stateAfterInput:true});
  assert.deepEqual(calls[1].args,{sessionId:'origin-session',method:'state',params:{}});
  assert.strictEqual(calls[0].options.signal,calls[1].options.signal,'Cancellation scope covers both native requests');
});

test('ordinary input and non-input operations keep their original single native request',async t=>{
  const calls=[],ack={ready:true,inputPending:true};
  const client=await connect(t,async args=>{calls.push(args);return ack;});
  for(const [method,params] of [['input',{type:'pointermove'}],['input',{type:'wheel',replyWithState:false}],['state',{replyWithState:true}]]){
    const result=await relay(client,method,params);
    assert.deepEqual(result._meta['lyx/rpc'],ack);
  }
  assert.deepEqual(calls.map(call=>call.method),['input','input','state']);
});

test('a failed post-input state read does not replay the input or claim a settled response',async t=>{
  const calls=[];
  const client=await connect(t,async args=>{
    calls.push(args.method);
    if(args.method==='state')throw new Error('State unavailable');
    return {inputPending:true};
  });
  const result=await relay(client,'input',{type:'commit',text:'Once only',replyWithState:true});
  assert.equal(result.isError,true);assert.match(result._meta['lyx/rpc'].message,/State unavailable/);
  assert.equal(result._meta['lyx/rpc'].stateAfterInput,undefined);
  assert.deepEqual(calls,['input','state']);
});

test('an input error is preserved instead of being masked by a later state read',async t=>{
  const calls=[];
  const client=await connect(t,async args=>{calls.push(args.method);return {error:true,message:'Input rejected'};});
  const result=await relay(client,'input',{type:'wheel',replyWithState:true});
  assert.deepEqual(result._meta['lyx/rpc'],{error:true,message:'Input rejected'});
  assert.deepEqual(calls,['input']);
});

test('verified exit codes survive the MCP relay without replaying uncertain input',async t=>{
  const calls=[];
  const client=await connect(t,async args=>{
    calls.push(args.method);
    if(args.method==='state')throw Object.assign(new Error('The native LyX process exited'),{code:'session_exited'});
    return {inputPending:true};
  });
  const result=await relay(client,'input',{type:'commit',text:'Exactly once',replyWithState:true});
  assert.equal(result.isError,true);
  assert.equal(result._meta['lyx/rpc'].code,'session_exited');
  assert.equal(result._meta['lyx/rpc'].applied,undefined,'An uncertain write must not be labelled unapplied');
  assert.deepEqual(calls,['input','state']);
});

test('the explicit reopen tool stays app-only and returns no service credentials',async t=>{
  const calls=[];
  const client=await connect(t,async()=>assert.fail('Reopen must not replay an RPC'),{reopenNative:async(id,options)=>{
    calls.push({id,options});
    return {sessionId:'replacement',path:'/renamed.lyx',url:'http://127.0.0.1:54321',token:'private-service-token'};
  }});
  const tool=(await client.listTools()).tools.find(item=>item.name==='reopen_native_lyx');
  assert.deepEqual(tool._meta.ui.visibility,['app']);
  const result=await client.callTool({name:'reopen_native_lyx',arguments:{sessionId:'departed'}});
  assert.equal(calls.length,1);assert.equal(calls[0].id,'departed');
  assert.deepEqual(result._meta['lyx/native'],{sessionId:'replacement',path:'/renamed.lyx'});
  assert.deepEqual(result.structuredContent,result._meta['lyx/native']);
  assert.match(result.content[0].text,/session ready/);
  assert.doesNotMatch(JSON.stringify(result),/private-service-token|127\.0\.0\.1|editor opened/);
});

test('reopen refusal preserves safe error codes and rejects arbitrary path overrides',async t=>{
  let calls=0;
  const client=await connect(t,async()=>assert.fail('No RPC expected'),{reopenNative:async()=>{
    calls++;throw Object.assign(new Error('The original editor is still running'),{code:'session_not_exited'});
  }});
  const rejected=await client.callTool({name:'reopen_native_lyx',arguments:{sessionId:'live',path:'/another.lyx'}});
  assert.equal(rejected.isError,true);assert.equal(calls,0);
  const result=await client.callTool({name:'reopen_native_lyx',arguments:{sessionId:'live'}});
  assert.equal(result.isError,true);assert.equal(result._meta['lyx/rpc'].code,'session_not_exited');
  assert.equal(calls,1);
});
