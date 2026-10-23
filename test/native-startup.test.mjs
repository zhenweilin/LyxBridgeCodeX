import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises,{mkdtemp,mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {syncBuiltinESMExports} from 'node:module';
import {NativeSession} from '../lib/native-session.mjs';

// A real child process and local socket model LyX's early socket creation,
// synchronous first-run configuration, readiness polling, and process exits.
const engine=String.raw`
import {createServer} from 'node:net';
import {readFile} from 'node:fs/promises';
const settings=JSON.parse(await readFile(process.argv.at(-1),'utf8'));
console.log('fixture started');
if(settings.exitBeforeSocketMs!==undefined)setTimeout(()=>process.exit(23),settings.exitBeforeSocketMs);
let stateRequests=0,prompt=!!settings.interactionRequired;
const server=createServer(socket=>{
  let buffer='';socket.setEncoding('utf8');
  socket.on('error',()=>{});
  socket.on('data',chunk=>{
    buffer+=chunk;
    let at;
    while((at=buffer.indexOf('\n'))>=0){
      const request=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);
      console.log('request '+request.method);
      if(settings.exitOnState&&request.method==='state'){process.exit(24);return;}
      if(request.params.silent)continue;
      if(request.params.dismissPrompt)prompt=false;
      const count=request.method==='state'?++stateRequests:0;
      const wait=count===1?(settings.firstStateDelayMs??0):(request.params.delayMs??0);
      setTimeout(()=>{
        if(!socket.destroyed)socket.write(JSON.stringify({id:request.id,result:{ready:request.params.ready??(!prompt&&count>(settings.notReadyCount??0)),
          path:request.params.currentPath??settings.currentPath,
          uiReady:settings.uiReady??false,interactionRequired:prompt,request:count}})+'\n');
      },wait);
    }
  });
});
setTimeout(()=>server.listen(process.env.LYX_CODEX_SOCKET,()=>console.log('socket listening')),settings.socketDelayMs??0);
`;

async function fixture(t,settings={},options={}) {
  const directory=await mkdtemp(join(tmpdir(),'lyx-startup-test-'));
  const binary=join(directory,'engine.mjs'),profile=join(directory,'profile'),path=join(directory,'fixture.lyx');
  const library=join(directory,'fake-library');await mkdir(library);
  await mkdir(profile);
  await writeFile(binary,`#!${process.execPath}\n${engine}`,{mode:0o700});
  await writeFile(path,JSON.stringify(settings));
  const old={binary:process.env.LYX_CODEX_BINARY,profile:process.env.LYX_USER_PROFILE,library:process.env.LYX_CODEX_LIBRARY};
  process.env.LYX_CODEX_BINARY=binary;process.env.LYX_USER_PROFILE=profile;process.env.LYX_CODEX_LIBRARY=library;
  const session=new NativeSession(options);
  t.after(async()=>{
    t.mock.timers.reset();
    const child=session.process;
    const closed=child&&child.exitCode===null&&child.signalCode===null?once(child,'close'):Promise.resolve();
    session.stop();await closed;
    for(const [key,value] of [['LYX_CODEX_BINARY',old.binary],['LYX_USER_PROFILE',old.profile],['LYX_CODEX_LIBRARY',old.library]])
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    await rm(directory,{recursive:true,force:true});
    if(session.directory)await rm(session.directory,{recursive:true,force:true});
  });
  return {session,path,library,log:()=>readFile(join(session.directory,'engine.log'),'utf8')};
}

// Hold real cache-publication I/O after the native process starts. Preparation
// completes before spawn, so its filesystem reads remain unaffected.
// This exercises the integration without adding a production injection hook.
async function holdCachePublication(t,library,session) {
  const configure=join(await realpath(library),'configure.py');
  await writeFile(configure,'lyxrc_fileformat = 39\n');
  let release,entered,held=false;
  const gate=new Promise(done=>{release=done;});
  const blocked=new Promise(done=>{entered=done;});
  const original=fsPromises.readFile;
  t.mock.method(fsPromises,'readFile',async(file,...args)=>{
    if(file===configure&&session.process&&!held){held=true;entered();await gate;}
    return original(file,...args);
  });
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  return {release,blocked};
}

for(const phase of ['startup','recovery'])test(`slow cache publication does not delay a ready ${phase} result`,{timeout:5000},async t=>{
  const {session,path,library}=await fixture(t,phase==='recovery'?{uiReady:true,interactionRequired:true}:{},
    {startupTimeoutMs:1500,requestTimeoutMs:75});
  const publication=await holdCachePublication(t,library,session);
  let response,timeout;
  try{
    if(phase==='recovery'){
      await session.start(path);
      assert.equal(await session.waitForConfigurationCache(),false,'A prompt does not start publication');
    }
    let completed=false;
    response=(phase==='startup'?session.start(path):session.call('state',{dismissPrompt:true}))
      .then(result=>{completed=true;return result;});
    // Attach a rejection handler while observing I/O, so a startup regression
    // reports as an assertion instead of an unrelated unhandled rejection.
    response.catch(()=>{});
    await Promise.race([publication.blocked,new Promise((_,reject)=>{
      timeout=setTimeout(()=>reject(new Error('Cache publication did not reach the held I/O')),2500);
    })]);
    await new Promise(setImmediate);
    assert.equal(completed,true,'The native result must resolve while optional cache I/O is still blocked');
    let published=false;
    session.waitForConfigurationCache().then(()=>{published=true;});
    await Promise.resolve();
    assert.equal(published,false,'The fixture must still be holding the publication');
    assert.equal((await session.call('state')).ready,true,'The live editor remains responsive during publication');
    assert.equal(session.process.killed,false);
  }finally{
    clearTimeout(timeout);publication.release();
    await response?.catch(()=>{});
    await session.waitForConfigurationCache();
  }
  // This fixture intentionally creates no generated TeX metadata: cache
  // publication declines after release, but the successful editor stays alive.
  assert.equal(await session.waitForConfigurationCache(),false);
  assert.equal((await session.call('state')).ready,true);
  assert.equal(session.process.killed,false);
});

test('startup waits beyond ordinary RPC timeout for first-run configuration', {timeout:5000},async t=>{
  const {session,path,log}=await fixture(t,{firstStateDelayMs:250},{startupTimeoutMs:1500,requestTimeoutMs:75});
  assert.equal(await session.start(path),session);
  assert.match(await log(),/socket listening[\s\S]*request state/);
  assert.equal((await session.call('state')).ready,true);
});

test('last known document path follows only validated ready native replies',async t=>{
  const {session,path}=await fixture(t);await session.start(path);
  assert.equal(session.lastKnownPath,session.path,'The original canonical path is the fallback');
  const renamed=join(tmpdir(),'native-save-as.lyx');
  await session.call('state',{currentPath:renamed});assert.equal(session.lastKnownPath,renamed);
  for(const invalid of ['relative.lyx','/not-a-document.txt','/invalid\0.lyx']){
    await session.call('state',{currentPath:invalid});assert.equal(session.lastKnownPath,renamed);
  }
  await session.call('state',{currentPath:'/unloaded.lyx',ready:false});
  assert.equal(session.lastKnownPath,renamed,'An unloaded prompt cannot replace the last active document');
});

test('a timed-out Save As reply still updates recovery path without resolving or replaying its RPC',async t=>{
  const {session,path,log}=await fixture(t,{}, {requestTimeoutMs:40});await session.start(path);
  const renamed=join(tmpdir(),'late-save-as.lyx');let outcomes=0;
  const operation=session.call('command',{command:'buffer-write-as',ready:true,currentPath:renamed,delayMs:130})
    .then(()=>{outcomes++;assert.fail('The expired operation cannot resolve successfully');},error=>{outcomes++;throw error;});
  await assert.rejects(operation,/command request timed out/);
  assert.equal(session.lastKnownPath,session.path);
  const observed=new Promise((done,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Late native path was not observed')),1500);
    const check=()=>{if(session.lastKnownPath===renamed){clearTimeout(timeout);session.socket.off('data',check);done();}};
    session.socket.on('data',check);check();
  });
  await observed;
  assert.equal(outcomes,1);assert.equal(session.pending.size,0);
  assert.equal((await log()).match(/request command/g)?.length,1,'The Save As command is sent only once');
});

test('a renderable startup prompt returns its live session before document readiness', {timeout:5000},async t=>{
  const {session,path}=await fixture(t,{uiReady:true,interactionRequired:true},{startupTimeoutMs:1500});
  assert.equal(await session.start(path),session);
  assert.equal(session.startupPending,true);
  const waiting=await session.call('state');
  assert.equal(waiting.ready,false);assert.equal(waiting.interactionRequired,true);
  assert.equal(session.startupPending,true,'Read-only polling does not dismiss the user decision');
  const loaded=await session.call('state',{dismissPrompt:true});
  assert.equal(loaded.ready,true);assert.equal(session.startupPending,false);
});

test('a prompt without a renderable native root cannot bypass startup readiness', {timeout:5000},async t=>{
  const {session,path}=await fixture(t,{uiReady:false,interactionRequired:true},{startupTimeoutMs:450});
  await assert.rejects(session.start(path),/startup timed out/);
  assert.equal(session.startupPending,false);
});

test('socket discovery and first readiness response share one startup deadline', {timeout:5000},async t=>{
  const {session,path,log}=await fixture(t,{socketDelayMs:150,firstStateDelayMs:350},{startupTimeoutMs:450});
  await assert.rejects(session.start(path),/startup timed out while opening the document and configuring LyX/);
  assert.match(await log(),/request state/,'The socket was connected before the shared budget expired');
  assert.equal(session.pending.size,0);
  assert.equal(session.process.killed,true,'Only the failed disposable startup is stopped');
});

test('repeated not-ready responses cannot renew the startup deadline', {timeout:5000},async t=>{
  const {session,path,log}=await fixture(t,{notReadyCount:100},{startupTimeoutMs:450,requestTimeoutMs:75});
  await assert.rejects(session.start(path),/startup timed out while opening the document and configuring LyX/);
  assert.ok((await log()).split('request state').length>2,'Readiness was checked more than once');
  assert.equal(session.pending.size,0);
});

test('a missing socket exhausts the same bounded startup budget', {timeout:5000},async t=>{
  const {session,path}=await fixture(t,{socketDelayMs:2000},{startupTimeoutMs:250});
  await assert.rejects(session.start(path),/startup timed out while waiting for the editor connection/);
  assert.equal(session.process.killed,true);
  assert.equal(session.pending.size,0);
});

test('an engine exiting before its socket reports the process failure', {timeout:5000},async t=>{
  const {session,path}=await fixture(t,{exitBeforeSocketMs:10,socketDelayMs:2000},{startupTimeoutMs:1500});
  await assert.rejects(session.start(path),/LyX failed to start \(23\)/);
  assert.equal(session.exited.code,23);
});

test('an engine exiting during readiness promptly rejects the pending request', {timeout:5000},async t=>{
  const {session,path}=await fixture(t,{exitOnState:true},{startupTimeoutMs:1500});
  await assert.rejects(session.start(path),/LyX exited|editor connection has closed/);
  assert.equal(session.pending.size,0);
});

test('ordinary RPCs retain their independent timeout after a slower successful startup', {timeout:5000},async t=>{
  const {session,path}=await fixture(t,{firstStateDelayMs:180},{startupTimeoutMs:1500,requestTimeoutMs:75});
  await session.start(path);
  await assert.rejects(session.call('state',{delayMs:200}),/^Error: The LyX state request timed out$/);
  assert.equal(session.pending.size,0);
  assert.equal((await session.call('state')).ready,true,'An RPC timeout does not stop or replace the editor');
});

test('the production ordinary RPC deadline remains exactly fifteen seconds', {timeout:5000},async t=>{
  const {session,path}=await fixture(t);
  await session.start(path);
  t.mock.timers.enable({apis:['setTimeout']});
  let failed=false;
  const pending=session.call('state',{silent:true}).catch(error=>{failed=true;throw error;});
  const rejection=assert.rejects(pending,/The LyX state request timed out/);
  t.mock.timers.tick(14999);await Promise.resolve();
  assert.equal(failed,false,'The ordinary timeout is not shortened to a startup polling interval');
  t.mock.timers.tick(1);await rejection;
  assert.equal(session.pending.size,0);
  t.mock.timers.reset();
});
