import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,realpath,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startBroker} from '../server/native-broker.mjs';
import {NativeSession} from '../lib/native-session.mjs';

const deferred=()=>{
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
};
const flush=()=>new Promise(done=>setImmediate(done));
async function promptly(promise) {
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error('A healthy editor waited for an unrelated pending probe')),1000);
  })]);}finally{clearTimeout(timer);}
}
async function fixture(t) {
  const directory=await realpath(await mkdtemp(join(tmpdir(),'lyx-broker-open-')));
  const path=join(directory,'document.lyx');
  await writeFile(path,'Disposable broker path fixture');
  const broker=await startBroker({registryPath:null});
  t.after(async()=>{
    const closed=new Promise(done=>broker.server.close(done));
    broker.server.closeAllConnections();
    await closed;
    await rm(directory,{recursive:true,force:true});
  });
  return {broker,path};
}

test('a matching editor opens before unrelated state probes settle',async t=>{
  const {broker,path}=await fixture(t),gate=deferred(),calls=[];
  let slowSettled=false;
  t.after(()=>gate.resolve());
  for(const id of ['slow-one','slow-two'])broker.sessions.set(id,{id,async call(method){
    assert.equal(method,'state');calls.push(id);
    await gate.promise;slowSettled=true;throw new Error('Unrelated unavailable editor');
  }});
  broker.sessions.set('matching',{id:'matching',async call(method){
    assert.equal(method,'state');calls.push('matching');return {ready:true,path};
  }});
  const opened=await promptly(broker.open(path));
  assert.equal(opened.sessionId,'matching');
  assert.deepEqual(calls,['slow-one','slow-two','matching'],'Every independent probe starts concurrently');
  assert.equal(slowSettled,false,'The healthy match does not await unrelated failures');
  assert.equal(broker.sessions.size,3,'Unresponsive editors remain available for recovery');
  gate.resolve();await flush();
});

test('reopening verifies the known owner before probing unrelated editors',async t=>{
  const {broker,path}=await fixture(t),calls=[];
  const owner={id:'owner',async call(method){calls.push(['owner',method]);return {ready:true,path};}};
  broker.sessions.set(owner.id,owner);
  assert.equal((await broker.open(path)).sessionId,owner.id);
  broker.sessions.clear();
  broker.sessions.set('unrelated',{id:'unrelated',async call(){
    calls.push(['unrelated','state']);throw new Error('Must not query an unrelated editor');
  }});
  broker.sessions.set(owner.id,owner);
  assert.equal((await promptly(broker.open(path))).sessionId,owner.id);
  assert.deepEqual(calls,[['owner','state'],['owner','state']]);
});

test('reopening an unanswered startup prompt reuses its original process without switching a buffer',async t=>{
  const {broker,path}=await fixture(t),calls=[];
  const owner={id:'recovery-owner',path,startupPending:true,async call(method){
    calls.push(method);assert.equal(method,'state');
    return {ready:false,uiReady:true,interactionRequired:true,interactionTitle:'Load backup?'};
  }};
  broker.sessions.set(owner.id,owner);
  assert.equal((await broker.open(path)).sessionId,owner.id);
  assert.equal((await broker.open(path)).sessionId,owner.id);
  assert.deepEqual(calls,['state','state']);
  assert.equal(broker.sessions.size,1);
});

test('a changed active buffer invalidates the known-owner shortcut',async t=>{
  const {broker,path}=await fixture(t),calls=[];
  let active=path;
  const previous={id:'previous',async call(method){
    calls.push(['previous',method]);return {ready:true,path:active,modified:true};
  }};
  broker.sessions.set(previous.id,previous);
  await broker.open(path);
  active=join(path,'renamed.lyx');
  broker.sessions.set('current',{id:'current',async call(method){
    calls.push(['current',method]);return {ready:true,path};
  }});
  assert.equal((await broker.open(path)).sessionId,'current');
  assert.deepEqual(calls,[['previous','state'],['previous','state'],['current','state']]);
  assert.equal(broker.sessions.get(previous.id),previous,'The renamed unsaved editor is retained');
});

test('an unavailable known owner rejects without switching or replacing its unsaved editor',async t=>{
  const {broker,path}=await fixture(t),calls=[];
  let fail=false;
  const owner={id:'owner',async call(method){
    calls.push(method);
    if(fail)throw new Error('Known editor connection unavailable');
    return {ready:true,path,modified:true};
  }};
  broker.sessions.set(owner.id,owner);
  await broker.open(path);fail=true;
  broker.sessions.set('other',{id:'other',async call(method){
    assert.equal(method,'state');return {ready:false};
  }});
  await assert.rejects(broker.open(path),/Known editor connection unavailable/);
  assert.deepEqual(calls,['state','state'],'No switch or destructive operation is attempted');
  assert.equal(broker.sessions.get(owner.id),owner);
  assert.equal(broker.sessions.size,2,'No replacement engine is created');
});

for(const ownership of ['lastKnownPath','path'])test(`an unavailable unindexed ${ownership} owner blocks competing open and reopen`,async t=>{
  const {broker,path}=await fixture(t),alias=path+'.alias.lyx',other=path+'.other.lyx',initial=path+'.initial.lyx',calls=[];
  await symlink(path,alias);await writeFile(other,'unrelated fixture');
  const owner={id:'unindexed-live',path:initial,lastKnownPath:initial,[ownership]:alias,async call(method){
    calls.push(method);throw new Error('Temporarily disconnected after Save As');
  }};
  broker.sessions.set(owner.id,owner);
  await assert.rejects(broker.open(path),{code:'session_unavailable'});
  assert.equal(broker.sessions.size,1,'An unindexed live owner cannot be replaced');
  const departed={id:'departed',path,lastKnownPath:path,exited:{code:1}};broker.sessions.set(departed.id,departed);
  await assert.rejects(broker.reopen(departed.id),{code:'session_unavailable'});
  assert.equal(broker.sessions.get(owner.id),owner);
  assert.deepEqual(calls,['state','state'],'No buffer switch or input is sent to the unavailable owner');
  t.mock.method(NativeSession.prototype,'start',async function(requested){
    assert.equal(requested,other);this.id='new-unrelated';this.path=requested;return this;
  });
  assert.equal((await promptly(broker.open(other))).sessionId,'new-unrelated','An unrelated document can still open a new editor');
});

test('a pending matching owner is not treated as absent after other probes finish',async t=>{
  const {broker,path}=await fixture(t),gate=deferred(),started=deferred();
  t.after(()=>gate.resolve());
  broker.sessions.set('unrelated',{id:'unrelated',async call(){return {ready:false};}});
  broker.sessions.set('slow-owner',{id:'slow-owner',async call(method){
    assert.equal(method,'state');started.resolve();await gate.promise;return {ready:true,path,modified:true};
  }});
  let settled=false;
  const opening=broker.open(path).then(result=>{settled=true;return result;});
  await started.promise;await flush();
  assert.equal(settled,false,'A negative fast probe must not cause a new engine to open');
  assert.equal(broker.sessions.size,2);
  gate.resolve();
  assert.equal((await promptly(opening)).sessionId,'slow-owner');
  assert.equal(broker.sessions.size,2);
});

test('a known owner that switched buffers is restored only after all other probes finish',async t=>{
  const {broker,path}=await fixture(t),gate=deferred(),started=deferred(),commands=[];
  t.after(()=>gate.resolve());
  let active=path;
  const owner={id:'owner',async call(method,params){
    if(method==='command'){commands.push(params.command);active=path;return {};}
    return {ready:true,path:active,modified:true};
  }};
  broker.sessions.set(owner.id,owner);await broker.open(path);
  active=join(path,'different.lyx');
  broker.sessions.set('slow-nonmatch',{id:'slow-nonmatch',async call(){
    started.resolve();await gate.promise;return {ready:false};
  }});
  const opening=broker.open(path);
  await started.promise;await flush();
  assert.deepEqual(commands,[],'A pending probe could still be the active owner');
  gate.resolve();
  assert.equal((await promptly(opening)).sessionId,'owner');
  assert.deepEqual(commands,[`buffer-switch ${path}`]);
  assert.equal(broker.sessions.size,2);
});
