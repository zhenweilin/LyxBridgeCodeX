import {readFile, mkdir, open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {nativeRequestBytes} from './native-rpc-limits.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
let starting;
function validateBroker(broker){
  if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(broker?.url)||!/^[a-f0-9]{64}$/.test(broker?.token))
    throw new Error('Invalid local LyX service configuration');
  return broker;
}
async function running() {
  try {
    const info = JSON.parse(await readFile(resolve(root, '.native/broker.json'), 'utf8'));
    // Treat the file as a hint; only a live authenticated response proves readiness.
    if (info.url !== 'http://127.0.0.1:43128' || !/^[a-f0-9]{64}$/.test(info.token)) return;
    const response = await fetch(info.url + '/health', {headers: {Authorization: `Bearer ${info.token}`}, signal: AbortSignal.timeout(1500)});
    if (response.ok && (await response.json()).ok) return info;
  } catch {}
}
export async function ensureBroker() {
  const info = await running();
  if (info) return info;
  if (!starting) starting = (async () => {
    await mkdir(resolve(root, '.native'), {recursive: true});
    const log = await open(resolve(root, '.native/broker.log'), 'a');
    const child = spawn(process.execPath, [resolve(root, 'server/native-broker.mjs')], {detached: true, stdio: ['ignore', log.fd, log.fd]});
    child.unref();
    await log.close();
    for (let i = 0; i < 50; i++) {
      const info = await running();
      if (info) return info;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('The native LyX service did not start; check .native/broker.log');
  })().finally(() => {starting = undefined;});
  return starting;
}
export async function openNativeDocument(path,{broker:suppliedBroker}={}) {
  const broker = validateBroker(suppliedBroker??await ensureBroker());
  const response = await fetch(broker.url + '/open', {method: 'POST', headers: {Authorization: `Bearer ${broker.token}`, 'Content-Type': 'application/json'}, body: JSON.stringify({path}), signal: AbortSignal.timeout(45000)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Could not open LyX');
  return result;
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
  // it through the same authenticated ensureBroker path as openNativeDocument.
  const broker=validateBroker(suppliedBroker??await ensureBroker());
  const timeout=AbortSignal.timeout(20000);
  const response=await fetch(broker.url+'/rpc',{
    method:'POST',headers:{Authorization:`Bearer ${broker.token}`,'Content-Type':'application/json'},body,
    signal:signal?AbortSignal.any([signal,timeout]):timeout,
  });
  const result=await response.json();
  if(!response.ok||result.error){
    const detail=String(result.message??result.error??'The native LyX operation failed').replaceAll(broker.token,'[redacted]').slice(0,2000);
    const error=new Error(detail);
    // A native edit can succeed before producing its reply fails. Preserve
    // this outcome so callers never turn an uncertain write into a blind retry.
    if(result.applied===true)error.applied=true;
    if(typeof result.code==='string' && /^[a-z_]{1,64}$/.test(result.code))error.code=result.code;
    throw error;
  }
  return result;
}
