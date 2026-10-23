import {readFile, mkdir, open, unlink, stat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {nativeRequestBytes} from './native-rpc-limits.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const registryPath = resolve(root, '.native/broker.json');
const startupLockPath = resolve(root, '.native/broker-start.lock');
let starting;
const sessionBrokers=new Map();
const failure=(message,code)=>Object.assign(new Error(message),{code});
function validateBroker(broker){
  const port=/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(broker?.url)?.[1];
  if(!port||Number(port)>65535||!/^[a-f0-9]{64}$/.test(broker?.token))
    throw new Error('Invalid local LyX service configuration');
  return broker;
}
export async function findRunningBroker(path=registryPath) {
  try {
    const info = validateBroker(JSON.parse(await readFile(path, 'utf8')));
    // Treat the file as a hint; only a live authenticated response proves readiness.
    const response = await fetch(info.url + '/health', {headers: {Authorization: `Bearer ${info.token}`}, signal: AbortSignal.timeout(1500),redirect:'error'});
    if (response.ok && (await response.json()).ok) return info;
  } catch {}
}
async function allowBrokerStartup() {
  let info;
  try{info=validateBroker(JSON.parse(await readFile(registryPath,'utf8')));}
  catch(error){
    if(error.code==='ENOENT')return;
    throw failure('The existing native LyX service could not be verified; no replacement was started','broker_unavailable');
  }
  if(Number.isSafeInteger(info.pid)&&info.pid>0){
    try{process.kill(info.pid,0);}
    catch(error){if(error.code==='ESRCH')return;}
  }
  throw failure('The native LyX service may still be running; no replacement was started','broker_unavailable');
}
async function brokerForSession(sessionId,suppliedBroker) {
  if(suppliedBroker)return validateBroker(suppliedBroker);
  if(sessionBrokers.has(sessionId))return sessionBrokers.get(sessionId);
  try{return validateBroker(JSON.parse(await readFile(registryPath,'utf8')));}
  catch{throw failure('The native LyX service is unavailable; existing editors were not restarted','broker_unavailable');}
}
function rememberSession(result,broker) {
  if(typeof result?.sessionId!=='string'||!result.sessionId||result.sessionId.length>128)
    throw failure('The native LyX service returned an invalid session','broker_unavailable');
  sessionBrokers.set(result.sessionId,Object.freeze({...broker}));
  return result;
}
async function post(broker,route,body,signal) {
  let response,result;
  try{
    response=await fetch(broker.url+route,{method:'POST',headers:{Authorization:`Bearer ${broker.token}`,'Content-Type':'application/json'},body,signal,redirect:'error'});
    result=await response.json();
  }catch{
    throw failure('The native LyX service is unavailable; existing editors were not restarted','broker_unavailable');
  }
  if(!response.ok||result.error){
    const detail=String(result.message??result.error??'The native LyX operation failed').replaceAll(broker.token,'[redacted]').slice(0,2000);
    const error=new Error(detail);
    // A native edit can succeed before producing its reply fails. Never turn
    // an uncertain write into a blind retry, including after a confirmed exit.
    if(result.applied===true)error.applied=true;
    if(typeof result.code==='string'&&/^[a-z_]{1,64}$/.test(result.code))error.code=result.code;
    throw error;
  }
  return result;
}
const delay=ms=>new Promise(done=>setTimeout(done,ms));
async function acquireStartupLock() {
  const owner=JSON.stringify({pid:process.pid,nonce:randomUUID()});
  for(let attempt=0;attempt<150;attempt++){
    try{
      const handle=await open(startupLockPath,'wx',0o600);
      try{await handle.writeFile(owner);}finally{await handle.close();}
      return async()=>{
        if(await readFile(startupLockPath,'utf8').catch(()=>null)===owner)
          await unlink(startupLockPath).catch(error=>{if(error.code!=='ENOENT')throw error;});
      };
    }catch(error){if(error.code!=='EEXIST')throw error;}
    // Never reap a shared lock based on a stale read: another process could
    // have replaced it with a live owner before unlink. Report abandoned
    // locks for explicit recovery instead of risking two active brokers.
    const value=await readFile(startupLockPath,'utf8').catch(()=>null);
    if(value===null)continue;
    let abandoned=false;
    try{
      const pid=JSON.parse(value).pid;
      if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('Incomplete startup lock');
      try{process.kill(pid,0);}catch(error){abandoned=error.code==='ESRCH';}
    }catch{
      const info=await stat(startupLockPath).catch(()=>null);
      abandoned=info && Date.now()-info.mtimeMs>10000;
    }
    if(abandoned)throw new Error(`An interrupted native LyX startup left ${startupLockPath}. Remove this stale lock and retry.`);
    await delay(100);
  }
  throw new Error('Another process is starting the native LyX service; try again shortly.');
}
export async function ensureBroker() {
  const info = await findRunningBroker();
  if (info) return info;
  if(starting)return starting;
  await allowBrokerStartup();
  if (!starting) starting = (async () => {
    await mkdir(resolve(root, '.native'), {recursive: true});
    const unlock=await acquireStartupLock();
    try{
      // Another Codex process may have completed startup while we waited.
      const info=await findRunningBroker();
      if (info) return info;
      await allowBrokerStartup();
      // Only an explicit open can reach startup. A dead broker can leave live
      // native children behind; this does not reclaim or terminate those edits.
      const log = await open(resolve(root, '.native/broker.log'), 'a');
      let startError;
      try{
        const child=spawn(process.execPath, [resolve(root, 'server/native-broker.mjs')], {detached: true, stdio: ['ignore', log.fd, log.fd]});
        child.once('error',error=>{startError=error;});
        child.unref();
      }finally{await log.close();}
      for (let i = 0; i < 50; i++) {
        if(startError)throw startError;
        const info = await findRunningBroker();
        if (info) return info;
        await delay(100);
      }
      throw new Error('The native LyX service did not start; check .native/broker.log');
    }finally{await unlock();}
  })().finally(() => {starting = undefined;});
  return starting;
}
export async function openNativeDocument(path,{broker:suppliedBroker}={}) {
  const broker = validateBroker(suppliedBroker??await ensureBroker());
  return rememberSession(await post(broker,'/open',JSON.stringify({path}),AbortSignal.timeout(45000)),broker);
}
export async function reopenNativeDocument(sessionId,{broker:suppliedBroker,signal}={}) {
  if(typeof sessionId!=='string'||!sessionId||sessionId.length>128)throw new Error('Invalid LyX session');
  const broker=await brokerForSession(sessionId,suppliedBroker),timeout=AbortSignal.timeout(45000);
  return rememberSession(await post(broker,'/reopen',JSON.stringify({sessionId}),
    signal?AbortSignal.any([signal,timeout]):timeout),broker);
}

// This allowlist is independent of the broker's broader development API. The
// iframe supplies a session and an operation, never a URL or bearer credential.
export const nativeRpcMethods = Object.freeze(['frame','input','selection','state','dispatch','clipboard']);
export async function callNativeRpc({sessionId,method,params={}}, {broker: suppliedBroker, signal} = {}) {
  if(!nativeRpcMethods.includes(method))throw new Error('Unsupported native LyX operation');
  if(typeof sessionId!=='string'||!sessionId||sessionId.length>128)throw new Error('Invalid LyX session');
  if(!params||typeof params!=='object'||Array.isArray(params))throw new Error('Invalid LyX operation parameters');
  const body=JSON.stringify({sessionId,method,params});
  if(Buffer.byteLength(body)>nativeRequestBytes(method,params))throw new Error('The LyX operation request is too large');
  // Constructor-only injection supports an isolated integration broker. MCP
  // arguments cannot choose this trusted local endpoint; production discovers
  // it from the endpoint that opened this session, or a validated registry.
  // Existing-session traffic never spawns or health-checks a replacement.
  const broker=await brokerForSession(sessionId,suppliedBroker);
  const timeout=AbortSignal.timeout(20000);
  return post(broker,'/rpc',body,signal?AbortSignal.any([signal,timeout]):timeout);
}
