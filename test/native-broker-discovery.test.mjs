import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,cp,mkdir,rm,unlink,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {startBroker} from '../server/native-broker.mjs';
import {findRunningBroker} from '../lib/native-broker-client.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const delay=ms=>new Promise(done=>setTimeout(done,ms));
async function directory(t){
  const path=await mkdtemp(join(tmpdir(),'lyx-broker-discovery-'));
  t.after(()=>rm(path,{recursive:true,force:true}));
  return path;
}
async function closeBroker(broker){
  const closed=new Promise(done=>broker.server.close(done));
  broker.server.closeAllConnections();
  await closed;
}
function runClient(path){
  const script=`import {ensureBroker} from ${JSON.stringify(pathToFileURL(join(path,'lib/native-broker-client.mjs')).href)}; const {url,pid}=await ensureBroker(); console.log(JSON.stringify({url,pid}));`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
  const result=new Promise((done,reject)=>{
    let output='',errors='';
    child.stdout.on('data',data=>output+=data);
    child.stderr.on('data',data=>errors+=data);
    child.once('error',reject);
    child.once('close',code=>code===0?done(JSON.parse(output)):reject(new Error(errors)));
  });
  return {child,result};
}
async function checkout(t){
  const path=await mkdtemp(join(tmpdir(),'lyx-broker-discovery-'));
  await Promise.all(['lib','server'].map(name=>cp(join(root,name),join(path,name),{recursive:true})));
  await mkdir(join(path,'.native'));
  t.after(async()=>{
    // This isolated checkout never opens documents. Stop only its own broker.
    const info=JSON.parse(await readFile(join(path,'.native/broker.json'),'utf8').catch(()=>'null'));
    if(info?.pid)try{process.kill(info.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}
    await rm(path,{recursive:true,force:true});
  });
  return path;
}

test('default brokers coexist and authenticated discovery uses each actual loopback port',async t=>{
  const path=await directory(t);
  const firstPath=join(path,'first.json'),secondPath=join(path,'second.json');
  const first=await startBroker({registryPath:firstPath});
  t.after(()=>closeBroker(first));
  const second=await startBroker({registryPath:secondPath});
  t.after(()=>closeBroker(second));
  assert.notEqual(first.url,second.url);
  assert.notEqual(new URL(first.url).port,'0');
  assert.equal((await findRunningBroker(firstPath)).url,first.url);
  assert.equal((await findRunningBroker(secondPath)).url,second.url);
  assert.equal((await fetch(first.url+'/health')).status,401);
  const info=JSON.parse(await readFile(firstPath,'utf8'));
  await writeFile(firstPath,JSON.stringify({...info,token:'0'.repeat(64)}));
  assert.equal(await findRunningBroker(firstPath),undefined,'A live unauthenticated service is not reused');
});

test('discovery preserves legacy port support and rejects unsafe endpoints before fetching',async t=>{
  const path=join(await directory(t),'broker.json');
  const originalFetch=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return Response.json({ok:true});};
  t.after(()=>{globalThis.fetch=originalFetch;});
  const token='1'.repeat(64);
  await writeFile(path,JSON.stringify({url:'http://127.0.0.1:43128',token}));
  assert.equal((await findRunningBroker(path)).url,'http://127.0.0.1:43128');
  assert.equal(calls.length,1);
  assert.equal(calls[0].options.redirect,'error');
  for(const url of ['https://127.0.0.1:43128','http://example.com:43128','http://127.0.0.1:0','http://127.0.0.1:65536','http://127.0.0.1:43128/path','http://127.0.0.1:43128@evil.example']){
    await writeFile(path,JSON.stringify({url,token}));
    assert.equal(await findRunningBroker(path),undefined,url);
  }
  assert.equal(calls.length,1,'Invalid registry entries never cause a network request');
});

test('concurrent fresh processes share one broker after explicit stale-lock recovery',{timeout:20000},async t=>{
  const path=await checkout(t);
  const departed=spawn(process.execPath,['-e',''],{stdio:'ignore'});
  await new Promise(done=>departed.once('exit',done));
  const lock=join(path,'.native/broker-start.lock');
  await writeFile(lock,JSON.stringify({pid:departed.pid,nonce:'crashed-test-owner'}));
  await assert.rejects(runClient(path).result,/interrupted native LyX startup/);
  assert.ok((await readFile(lock,'utf8')).includes('crashed-test-owner'),'Discovery does not race to reap a shared lock');
  await unlink(lock);
  const clients=Array.from({length:4},()=>runClient(path));
  t.after(()=>clients.forEach(({child})=>{if(child.exitCode===null)child.kill();}));
  const results=await Promise.all(clients.map(({result})=>result));
  assert.equal(new Set(results.map(result=>result.pid)).size,1);
  assert.equal(new Set(results.map(result=>result.url)).size,1);
  const info=await findRunningBroker(join(path,'.native/broker.json'));
  assert.equal(info.pid,results[0].pid);
  await assert.rejects(access(join(path,'.native/broker-start.lock')),{code:'ENOENT'});
});

test('a live startup owner is respected until it releases the lock',{timeout:10000},async t=>{
  const path=await checkout(t),lock=join(path,'.native/broker-start.lock');
  await writeFile(lock,JSON.stringify({pid:process.pid,nonce:'live-test-owner'}));
  const client=runClient(path);
  t.after(()=>{if(client.child.exitCode===null)client.child.kill();});
  await delay(300);
  await assert.rejects(access(join(path,'.native/broker.json')),{code:'ENOENT'});
  assert.ok((await readFile(lock,'utf8')).includes('live-test-owner'));
  await unlink(lock);
  const info=await client.result;
  assert.ok(info.pid>0);
  assert.equal((await findRunningBroker(join(path,'.native/broker.json'))).pid,info.pid);
});
