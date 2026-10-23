import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {NativeSession} from '../lib/native-session.mjs';
import {createServer} from '../server/mcp.mjs';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {captureBrowserPaste,externalLyxPasteParams} from '../web/native-clipboard.mjs';
import {recoverExternalLyxFormats} from '../lib/system-clipboard.mjs';

const macros=String.raw`\begin_layout Standard
\begin_inset FormulaMacro
\newcommand{\mbb}[1]{\mathbb{#1}}
\end_inset
\begin_inset FormulaMacro
\newcommand{\brbra}[1]{\left(#1\right)}
\end_inset
\end_layout`;
const passage=String.raw`\begin_layout Standard
Here
\begin_inset Formula $f:\mbb R^{d}\to\mbb R$
\end_inset
 is finite and convex, and the minimum is attained. 中文
\end_layout
\begin_layout Standard
There exists
\begin_inset Formula $\delta_{A}>0$
\end_inset
 in the Euclidean ball
\begin_inset Formula $B\brbra{x^{*},\delta_{A}}\subseteq\mbb R^{d}$
\end_inset
.
\end_layout`;
const count=source=>[...source.matchAll(/\\begin_inset Formula /g)].length;

test('external LyX HTML/text recovers exact native equations through the MCP relay and undoes in one step', {timeout:120000},async()=>{
  const template=await readFile('demo/demo.lyx','utf8');
  const fixture=body=>template.replace(/\\begin_body[\s\S]*\\end_body/,`\\begin_body\n${body}\n\\end_body`);
  const directory=await mkdtemp(resolve('.native/external-paste-integration-'));
  const sourcePath=join(directory,'source.lyx'),targetPath=join(directory,'target.lyx');
  const original=fixture(`${macros}\n\\begin_layout Standard\n\\end_layout`);
  await writeFile(sourcePath,fixture(`${macros}\n${passage}`));await writeFile(targetPath,original);
  const source=new NativeSession(),target=new NativeSession();let server,client;
  try{
    await source.start(sourcePath);await source.call('frame',{width:1000,height:800});
    for(const command of ['buffer-begin','paragraph-down','buffer-end-select'])await source.call('command',{command});
    const {clipboard}=await source.call('clipboard',{action:'copy'});
    assert.match(clipboard.text,/finite and convex/);
    assert.equal(count(Buffer.from(clipboard.formats['application/x-lyx'],'base64').toString()),3);
    const browserData={getData:type=>type==='application/x-lyx'||!clipboard.formats[type]?'':Buffer.from(clipboard.formats[type],'base64').toString()};
    const {payload}=captureBrowserPaste(browserData);
    assert.equal(payload.formats['application/x-lyx'],undefined,'The simulated browser withholds native MIME');
    await target.start(targetPath);await target.call('frame',{width:1000,height:800});
    await target.call('command',{command:'buffer-end'});
    const before=await target.call('selection');
    await target.call('clipboard',{action:'paste',formats:payload.formats});
    assert.equal(count((await target.call('selection')).source),0,'Without recovery, the observed HTML/text path loses every formula');
    await target.call('command',{command:'undo'});
    assert.equal((await target.call('selection')).source,before.source);
    let recoveries=0;
    server=createServer({externalClipboardAvailable:true,
      externalClipboard:(formats,options)=>recoverExternalLyxFormats(formats,{...options,read:async text=>{
        recoveries++;assert.equal(text,clipboard.text);return {status:'matched',lyx:clipboard.formats['application/x-lyx']};
      }}),rpc:request=>{assert.equal(request.sessionId,'isolated-target');return target.call(request.method,request.params);}});
    client=new Client({name:'native-external-paste-test',version:'1.0'});
    const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
    const result=await client.callTool({name:'native_lyx_rpc',arguments:{sessionId:'isolated-target',method:'clipboard',
      params:{action:'paste',...externalLyxPasteParams(payload,{externalLyxPaste:true}),expectedPath:targetPath}}});
    assert.ok(!result.isError,JSON.stringify(result));assert.equal(recoveries,1);
    const pasted=await target.call('selection');
    assert.equal(count(pasted.source),3);
    assert.match(pasted.source,/\\begin_inset Formula \$f:\\mbb R\^\{d\}\\to\\mbb R\$/);
    assert.match(pasted.source,/\\begin_inset Formula \$\\delta_\{A\}>0\$/);
    assert.match(pasted.source,/\\begin_inset Formula \$B\\brbra\{x\^\{\*\},\\delta_\{A\}\}\\subseteq\\mbb R\^\{d\}\$/);
    assert.match(pasted.source,/中文/);
    assert.doesNotMatch(pasted.source,/\\backslash\n(?:mbb|brbra|delta|to)/);
    await writeFile(join(directory,'pasted.lyx'),pasted.source);
    const frame=await target.call('frame',{width:1000,height:800});
    await writeFile(join(directory,'pasted.png'),Buffer.from(frame.surfaces.find(s=>s.main).png,'base64'));
    await target.call('command',{command:'undo'});
    assert.equal((await target.call('selection')).source,before.source,'The complete structured paste is one undo step');
    assert.equal(await readFile(targetPath,'utf8'),original,'A paste never saves the target implicitly');
    assert.equal(await readFile('demo/demo.lyx','utf8'),template);
    console.log(`External native paste evidence: ${directory}`);
  }finally{await client?.close();await server?.close();source.stop();target.stop();}
});
