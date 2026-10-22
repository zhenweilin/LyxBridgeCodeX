import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {renderFile} from '../lib/lyx.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const path=resolve(process.argv[2] ?? resolve(root,'demo/demo.lyx'));
const port=Number(process.env.LYX_PREVIEW_PORT ?? 43127);
let cached,key;
async function document(){
  const paths=[path,...(cached?.dependencies.map(d=>d.path) ?? [])];
  const next=JSON.stringify(await Promise.all(paths.map(async p=>{const s=await stat(p);return[p,s.mtimeMs,s.size];})));
  if(!cached||next!==key){cached=await renderFile(path);key=JSON.stringify(await Promise.all([path,...cached.dependencies.map(d=>d.path)].map(async p=>{const s=await stat(p);return[p,s.mtimeMs,s.size];})));}
  return cached;
}
createServer(async(req,res)=>{
  const allowedHosts=[`127.0.0.1:${port}`,`localhost:${port}`];
  if(!allowedHosts.includes(req.headers.host)||req.method!=='GET'){res.writeHead(403);return res.end();}
  if(req.headers.origin&&!allowedHosts.map(h=>`http://${h}`).includes(req.headers.origin)){res.writeHead(403);return res.end();}
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  try {
    if(req.url==='/document'){res.setHeader('Content-Type','application/json; charset=utf-8');return res.end(JSON.stringify(await document()));}
    if(req.url==='/'||req.url==='/index.html'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(await readFile(resolve(root,'dist/viewer.html')));}
    res.writeHead(404);res.end();
  } catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
}).listen(port,'127.0.0.1',()=>console.log(`LyX preview: http://127.0.0.1:${port}\nFile: ${path}`));
