import {createServer} from 'node:http';
import {readFile, writeFile, mkdir, realpath,rename,unlink} from 'node:fs/promises';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {NativeSession} from '../lib/native-session.mjs';
import {NativeClipboardStore} from '../lib/native-clipboard.mjs';
import {nativeRequestBytes,ordinaryNativeRequestBytes,imageNativeRequestBytes} from '../lib/native-rpc-limits.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
export const brokerFile = resolve(root, '.native/broker.json');
const defaultPort = 0;
const failure=(message,code)=>Object.assign(new Error(message),{code});

export async function startBroker({demoPath,port=defaultPort,registryPath=brokerFile} = {}) {
  const token = randomBytes(32).toString('hex');
  const sessions = new Map(), exitedSessions=new Map(),opening = new Map(), paths = new Map();
  const clipboard=new NativeClipboardStore();
  let url = `http://127.0.0.1:${port}`;
  async function open(path) {
    path = await realpath(path);
    if (opening.has(path)) return opening.get(path);
    const pending = (async () => {
      const descriptor = session => {
        paths.set(path,session.id);
        return {sessionId:session.id,path,url,token};
      };
      // Native File Open, tab switches and Save As change the active buffer.
      // A descriptor cached at startup does not prove which file is now shown.
      const unavailable=new Map();
      async function matches(session) {
        if(session.exited){
          exitedSessions.set(session.id,{path:session.path,lastKnownPath:session.lastKnownPath,exited:session.exited});
          sessions.delete(session.id);return false;
        }
        let current;
        try{current=await session.call('state');}
        catch(error){unavailable.set(session.id,error);return false;}
        if(current.ready)return await realpath(current.path).catch(()=>resolve(current.path))===path;
        // Reopening while its first recovery prompt is still unanswered must
        // return that same interactive session, not switch an unloaded buffer
        // or create a competing engine for the same file.
        return session.startupPending===true && session.path===path
          && current.uiReady===true && current.interactionRequired===true;
      }
      // Reopening an already connected document must not wait for unrelated
      // engines. Verify its current buffer before trusting the path index.
      let previous=sessions.get(paths.get(path));
      if(previous && await matches(previous))return descriptor(previous);
      if(previous?.exited)previous=undefined;

      // Engines are independent: a slow or disconnected one must not delay a
      // healthy matching editor. A negative result still waits for every probe;
      // otherwise a merely slow owner could be replaced and its edits hidden.
      const candidates=[...sessions.values()].filter(session=>session!==previous);
      const found=await new Promise(resolveMatch=>{
        let remaining=candidates.length;
        if(!remaining){resolveMatch(undefined);return;}
        for(const session of candidates){
          void matches(session).then(match=>{
            if(match)resolveMatch(session);
          }).catch(error=>{
            unavailable.set(session.id,error);
          }).finally(()=>{
            if(!--remaining)resolveMatch(undefined);
          });
        }
      });
      if(found)return descriptor(found);
      // Save As can establish ownership without ever indexing the new path.
      // A lost state connection does not make that live editor's last known
      // document safe to replace, including when reopening an older dead owner.
      for(const session of sessions.values()){
        if(session.exited||!unavailable.has(session.id))continue;
        for(const candidatePath of new Set([session.lastKnownPath,session.path])){
          if(typeof candidatePath!=='string'||!candidatePath)continue;
          if(await realpath(candidatePath).catch(()=>resolve(candidatePath))===path)
            throw failure('A live LyX editor may still contain this document; reconnect it before opening another editor','session_unavailable');
        }
      }
      if(previous){
        // Preserve a disconnected process that may contain unsaved work. Its
        // failure must not prevent unrelated documents opening in other sessions.
        if(unavailable.has(previous.id))throw unavailable.get(previous.id);
        const switched=await previous.call('command',{command:`buffer-switch ${path}`});
        if(!switched.error){
          const current=await previous.call('state');
          if(current.ready && await realpath(current.path).catch(()=>resolve(current.path))===path)
            return descriptor(previous);
          throw new Error('LyX did not switch to the requested file; check the native window');
        }
        // Save As may have removed the original buffer. Keep that process and
        // its unsaved work alive while opening the requested file separately.
      }
      const session = await new NativeSession().start(path);
      sessions.set(session.id, session);
      return descriptor(session);
    })();
    opening.set(path,pending);
    try{return await pending;}
    finally{if(opening.get(path)===pending)opening.delete(path);}
  }
  async function reopen(sessionId) {
    const session=sessions.get(sessionId)??exitedSessions.get(sessionId);
    if(!session)throw failure('LyX session not found','session_not_found');
    // A failed socket or timed-out state request is not proof of process exit.
    // Preserve that process and any unsaved edits until its exit is observed.
    if(!session.exited)throw failure('The original LyX editor has not exited; retry its connection instead','session_unavailable');
    return open(session.lastKnownPath??session.path);
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) {res.writeHead(403);return res.end();}
    if (req.url === '/' && req.method === 'GET') {
      // The development page is same-origin only. Plugin UI gets its token via MCP.
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      try {
        const descriptor = demoPath ? await open(demoPath) : null;
        const html = await readFile(resolve(root, 'dist/native.html'), 'utf8');
        const boot = `<script>window.__LYX_NATIVE__=${JSON.stringify(descriptor).replaceAll('<', '\\u003c')};</script>`;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(html.replace('</head>', boot + '</head>'));
      } catch(error) {res.writeHead(500);res.end(error.message);}
      return;
    }
    // Browser frames have opaque or host-managed origins. Authentication uses a
    // per-broker secret received through MCP, never cookies or a public GET.
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET');
      res.writeHead(204); return res.end();
    }
    const supplied = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token))) {res.writeHead(401);return res.end();}
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    try {
      if (req.method === 'GET' && req.url === '/health') return res.end(JSON.stringify({ok: true}));
      if (req.method !== 'POST') {res.writeHead(405); return res.end();}
      let body = '';
      const transportLimit=req.url==='/rpc'?imageNativeRequestBytes:ordinaryNativeRequestBytes;
      for await (const part of req) {body += part; if (Buffer.byteLength(body) > transportLimit) throw new Error('The request is too large');}
      const data = JSON.parse(body);
      if (req.url === '/open') return res.end(JSON.stringify(await open(data.path)));
      if (req.url === '/reopen') return res.end(JSON.stringify(await reopen(data.sessionId)));
      if (req.url !== '/rpc') {res.writeHead(404); return res.end();}
      if(Buffer.byteLength(body)>nativeRequestBytes(data.method,data.params))throw new Error('The request is too large');
      const session = sessions.get(data.sessionId);
      if (!session) {
        if(exitedSessions.has(data.sessionId))throw failure('The native LyX editor has exited','session_exited');
        throw failure('LyX session not found','session_not_found');
      }
      if(session.exited)throw failure('The native LyX editor has exited','session_exited');
      if (!['frame', 'input', 'selection', 'state', 'command', 'dispatch','clipboard'].includes(data.method)) throw new Error('Unknown operation');
      const params=data.params??{};
      if(data.method==='clipboard'&&params.action==='paste'&&params.copyId){
        params.formats=await clipboard.resolve(params.copyId,params.formats);
      }
      const operation=data.method==='clipboard'&&['copy','cut'].includes(params.action)&&params.copyId
        ? clipboard.copy(params.copyId,()=>session.call(data.method,params))
        : session.call(data.method,params);
      let result;
      try{result=await operation;}
      catch(error){if(session.exited)error.code='session_exited';throw error;}
      res.end(JSON.stringify(result));
    } catch(error) {res.writeHead(400);res.end(JSON.stringify({error:error.message,
      ...(typeof error.code==='string'&&/^[a-z_]{1,64}$/.test(error.code)?{code:error.code}:{}),
      ...(error.applied===true?{applied:true}:{})}));}
  });
  await new Promise((done, reject) => {server.once('error', reject); server.listen(port, '127.0.0.1', done);});
  port=server.address().port;url=`http://127.0.0.1:${port}`;
  if(registryPath){
    await mkdir(resolve(root, '.native'), {recursive: true});
    const staging=join(dirname(registryPath),`.lyx-broker-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
    try{
      await writeFile(staging,JSON.stringify({url,token,pid:process.pid}),{mode:0o600,flag:'wx'});
      await rename(staging,registryPath);
    }catch(error){
      const closed=new Promise(done=>server.close(done));server.closeAllConnections();await closed;
      throw error;
    }finally{await unlink(staging).catch(()=>{});}
  }
  return {server, open, reopen, sessions, url};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const broker=await startBroker({demoPath: process.argv[2]});
  console.log(`Native LyX editor: ${broker.url}/`);
}
