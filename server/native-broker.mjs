import {createServer} from 'node:http';
import {readFile, writeFile, mkdir, chmod, realpath} from 'node:fs/promises';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {NativeSession} from '../lib/native-session.mjs';
import {NativeClipboardStore} from '../lib/native-clipboard.mjs';
import {nativeRequestBytes,ordinaryNativeRequestBytes,imageNativeRequestBytes} from '../lib/native-rpc-limits.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
export const brokerFile = resolve(root, '.native/broker.json');
const defaultPort = 43128;

export async function startBroker({demoPath,port=defaultPort,registryPath=brokerFile} = {}) {
  const token = randomBytes(32).toString('hex');
  const sessions = new Map(), opening = new Map(), paths = new Map();
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
      for (const [id,session] of sessions) {
        if(session.exited){sessions.delete(id);continue;}
        let current;
        try{current=await session.call('state');}
        catch(error){unavailable.set(id,error);continue;}
        if(current.ready && await realpath(current.path).catch(()=>resolve(current.path))===path)
          return descriptor(session);
      }
      const previous=sessions.get(paths.get(path));
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
      if (req.url !== '/rpc') {res.writeHead(404); return res.end();}
      if(Buffer.byteLength(body)>nativeRequestBytes(data.method,data.params))throw new Error('The request is too large');
      const session = sessions.get(data.sessionId);
      if (!session) throw new Error('LyX session not found');
      if (!['frame', 'input', 'selection', 'state', 'command', 'dispatch','clipboard'].includes(data.method)) throw new Error('Unknown operation');
      const params=data.params??{};
      if(data.method==='clipboard'&&params.action==='paste'&&params.copyId){
        params.formats=await clipboard.resolve(params.copyId,params.formats);
      }
      const operation=data.method==='clipboard'&&['copy','cut'].includes(params.action)&&params.copyId
        ? clipboard.copy(params.copyId,()=>session.call(data.method,params))
        : session.call(data.method,params);
      const result = await operation;
      res.end(JSON.stringify(result));
    } catch(error) {res.writeHead(400);res.end(JSON.stringify({error: error.message}));}
  });
  await new Promise((done, reject) => {server.once('error', reject); server.listen(port, '127.0.0.1', done);});
  port=server.address().port;url=`http://127.0.0.1:${port}`;
  if(registryPath){
    await mkdir(resolve(root, '.native'), {recursive: true});
    await writeFile(registryPath, JSON.stringify({url, token, pid: process.pid}), {mode: 0o600});
    await chmod(registryPath, 0o600);
  }
  return {server, open, sessions};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startBroker({demoPath: process.argv[2]});
  console.log(`Native LyX editor: http://127.0.0.1:${defaultPort}/`);
}
