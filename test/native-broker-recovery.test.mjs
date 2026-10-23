import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises,{mkdtemp,mkdir,writeFile,readFile,cp,rm,access,realpath,readdir,stat} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {startBroker} from '../server/native-broker.mjs';
import {callNativeRpc,reopenNativeDocument} from '../lib/native-broker-client.mjs';

async function fixture(t){
  const directory=await realpath(await mkdtemp(join(tmpdir(),'lyx-broker-recovery-')));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const original=join(directory,'original.lyx'),renamed=join(directory,'renamed.lyx'),other=join(directory,'other.lyx');
  await Promise.all([original,renamed,other].map(path=>writeFile(path,'synthetic path fixture')));
  const broker=await startBroker({registryPath:null});
  t.after(async()=>{const closed=new Promise(done=>broker.server.close(done));broker.server.closeAllConnections();await closed;});
  const owner={id:'original-owner',path:original,lastKnownPath:renamed,async call(){return {ready:true,path:original,modified:true};}};
  broker.sessions.set(owner.id,owner);
  const endpoint=await broker.open(original);
  return {directory,broker,owner,endpoint,original,renamed,other};
}

test('only confirmed native exit authorizes reopening, and unknown sessions remain distinct',async t=>{
  const f=await fixture(t);
  f.owner.call=async()=>{throw new Error('Temporarily disconnected');};
  await assert.rejects(reopenNativeDocument(f.owner.id,{broker:f.endpoint}),{code:'session_unavailable'});
  await assert.rejects(callNativeRpc({sessionId:f.owner.id,method:'frame'},{broker:f.endpoint}),error=>error.code!=='session_exited');
  await assert.rejects(reopenNativeDocument('missing',{broker:f.endpoint}),{code:'session_not_found'});
  await assert.rejects(callNativeRpc({sessionId:'missing',method:'state'},{broker:f.endpoint}),{code:'session_not_found'});
  assert.equal(f.broker.sessions.size,1,'No unavailable engine is replaced');
  f.owner.exited={code:1};
  await assert.rejects(callNativeRpc({sessionId:f.owner.id,method:'input',params:{type:'commit',text:'never replay'}},{broker:f.endpoint}),{code:'session_exited'});
});

test('reopen uses the last verified Save As path and preserves its existing recovery prompt',async t=>{
  const f=await fixture(t);f.owner.exited={signal:'SIGTERM'};
  const prompt={id:'renamed-recovery',path:f.renamed,startupPending:true,async call(method){
    assert.equal(method,'state');return {ready:false,uiReady:true,interactionRequired:true};
  }};
  f.broker.sessions.set(prompt.id,prompt);
  const result=await reopenNativeDocument(f.owner.id,{broker:f.endpoint});
  assert.equal(result.sessionId,prompt.id);assert.equal(result.path,f.renamed);
  assert.equal(f.broker.sessions.get(prompt.id),prompt);
});

test('probing unrelated documents retains proof of a previous native exit',async t=>{
  const f=await fixture(t);f.owner.exited={code:2};
  f.broker.sessions.set('other',{id:'other',async call(){return {ready:true,path:f.other};}});
  await f.broker.open(f.other);
  assert.equal(f.broker.sessions.has(f.owner.id),false);
  await assert.rejects(callNativeRpc({sessionId:f.owner.id,method:'state'},{broker:f.endpoint}),{code:'session_exited'});
  f.broker.sessions.set('renamed',{id:'renamed',async call(){return {ready:true,path:f.renamed};}});
  assert.equal((await reopenNativeDocument(f.owner.id,{broker:f.endpoint})).sessionId,'renamed');
});

test('exit during an operation carries a typed exit without replaying the operation',async t=>{
  const f=await fixture(t);let calls=0;
  f.owner.call=async()=>{calls++;f.owner.exited={code:3};throw Object.assign(new Error('Exited after uncertain edit'),{applied:true});};
  await assert.rejects(callNativeRpc({sessionId:f.owner.id,method:'input',params:{}},{broker:f.endpoint}),{code:'session_exited',applied:true});
  assert.equal(calls,1);
});

async function clientFixture(t){
  const directory=await mkdtemp(join(tmpdir(),'lyx-client-recovery-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await mkdir(join(directory,'lib'));await mkdir(join(directory,'.native'));
  for(const name of ['native-broker-client.mjs','native-rpc-limits.mjs'])
    await cp(new URL('../lib/'+name,import.meta.url),join(directory,'lib',name));
  return {directory,registry:join(directory,'.native/broker.json'),client:await import(pathToFileURL(join(directory,'lib/native-broker-client.mjs')).href)};
}
const endpoint=(port,pid=process.pid)=>({url:`http://127.0.0.1:${port}`,token:'a'.repeat(64),pid});

test('opened sessions remain bound to their broker after the registry changes, with no health probes',async t=>{
  const f=await clientFixture(t),first=endpoint(42101),replacement=endpoint(42102),calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push({url,body:JSON.parse(options.body)});
    if(url.endsWith('/open'))return Response.json({sessionId:'bound',path:'/original.lyx'});
    if(url.endsWith('/reopen'))return Response.json({sessionId:'reopened',path:'/renamed.lyx'});
    return Response.json({ready:true});
  });
  await f.client.openNativeDocument('/original.lyx',{broker:first});
  await writeFile(f.registry,JSON.stringify(replacement));
  await f.client.callNativeRpc({sessionId:'bound',method:'state'});
  await f.client.reopenNativeDocument('bound');
  await f.client.callNativeRpc({sessionId:'reopened',method:'frame'});
  assert.ok(calls.every(call=>call.url.startsWith(first.url)));
  assert.deepEqual(calls.map(call=>new URL(call.url).pathname),['/open','/rpc','/reopen','/rpc']);
  await assert.rejects(access(join(f.directory,'.native/broker-start.lock')),{code:'ENOENT'});
});

test('an unknown owner uses only validated registry routing, never broker startup',async t=>{
  const f=await clientFixture(t),broker=endpoint(42103),calls=[];
  await writeFile(f.registry,JSON.stringify(broker));
  t.mock.method(globalThis,'fetch',async(url)=>{calls.push(url);return Response.json({error:'Missing',code:'session_not_found'},{status:400});});
  await assert.rejects(f.client.callNativeRpc({sessionId:'unknown',method:'state'}),{code:'session_not_found'});
  await assert.rejects(f.client.reopenNativeDocument('unknown'),{code:'session_not_found'});
  assert.deepEqual(calls,[broker.url+'/rpc',broker.url+'/reopen']);
  await rm(f.registry);
  await assert.rejects(f.client.callNativeRpc({sessionId:'unknown',method:'state'}),{code:'broker_unavailable'});
  await assert.rejects(f.client.reopenNativeDocument('unknown'),{code:'broker_unavailable'});
  await assert.rejects(access(join(f.directory,'.native/broker.log')),{code:'ENOENT'});
});

for(const kind of ['live','unknown','invalid'])test(`explicit open cannot replace an unresponsive ${kind} registry owner`,async t=>{
  const f=await clientFixture(t),broker=endpoint(42104);
  if(kind==='unknown')delete broker.pid;
  const original=kind==='invalid'?'unfinished registry':JSON.stringify(broker);
  await writeFile(f.registry,original);
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('Health unavailable');});
  await assert.rejects(f.client.openNativeDocument('/document.lyx'),{code:'broker_unavailable'});
  assert.equal(await readFile(f.registry,'utf8'),original);
  await assert.rejects(access(join(f.directory,'.native/broker.log')),{code:'ENOENT'});
  await assert.rejects(access(join(f.directory,'.native/broker-start.lock')),{code:'ENOENT'});
});

test('a bound broker transport failure is reported without writing to another endpoint',async t=>{
  const f=await clientFixture(t),calls=[];
  t.mock.method(globalThis,'fetch',async(url)=>{
    calls.push(url);
    if(url.endsWith('/open'))return Response.json({sessionId:'bound-failure'});
    throw new Error('Connection refused');
  });
  await f.client.openNativeDocument('/original.lyx',{broker:endpoint(42105)});
  await writeFile(f.registry,JSON.stringify(endpoint(42106)));
  await assert.rejects(f.client.callNativeRpc({sessionId:'bound-failure',method:'input',params:{text:'once'}}),{code:'broker_unavailable'});
  await assert.rejects(f.client.reopenNativeDocument('bound-failure'),{code:'broker_unavailable'});
  assert.deepEqual(calls,['http://127.0.0.1:42105/open','http://127.0.0.1:42105/rpc','http://127.0.0.1:42105/reopen']);
});

for(const fail of [false,true])test(`broker registry publication is atomic and cleans staging on ${fail?'failure':'success'}`,async t=>{
  const f=await clientFixture(t),old=JSON.stringify(endpoint(42107));await writeFile(f.registry,old);
  let release,entered,staging;
  const gate=new Promise(done=>{release=done;}),held=new Promise(done=>{entered=done;});
  const originalRename=fsPromises.rename;
  t.mock.method(fsPromises,'rename',async(source,target)=>{
    if(target===f.registry){staging=source;entered();await gate;if(fail)throw Object.assign(new Error('Simulated rename failure'),{code:'EACCES'});}
    return originalRename(source,target);
  });
  syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  const starting=startBroker({registryPath:f.registry});starting.catch(()=>{});
  try{
    await held;
    assert.equal(await readFile(f.registry,'utf8'),old,'Readers retain the previous complete record until rename');
    assert.equal((await stat(staging)).mode&0o777,0o600);
    const staged=await readFile(staging,'utf8');assert.doesNotThrow(()=>JSON.parse(staged));
  }finally{release();}
  if(fail){await assert.rejects(starting,{code:'EACCES'});assert.equal(await readFile(f.registry,'utf8'),old);}
  else{
    const broker=await starting;t.after(async()=>{const closed=new Promise(done=>broker.server.close(done));broker.server.closeAllConnections();await closed;});
    assert.equal(JSON.parse(await readFile(f.registry,'utf8')).url,broker.url);
  }
  assert.deepEqual((await readdir(join(f.directory,'.native'))).filter(name=>name.endsWith('.tmp')),[]);
});
