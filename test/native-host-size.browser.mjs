// Serve the production editor with a synthetic MCP host. /before re-enables
// the SDK's content-height observer to compare its size reports with /after.
// No native process, user document, or real chat context is reachable.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {resolve} from 'node:path';

const html=await readFile('web/native.html','utf8');
const source=await readFile('web/native-app.mjs','utf8');
const pages={};
for(const mode of ['before','after']){
  const contents=mode==='before'?source.replace('{autoResize:false}','{autoResize:true}'):source;
  const bundle=await build({stdin:{contents,resolveDir:resolve('web'),sourcefile:'native-app.mjs'},bundle:true,write:false,format:'esm'});
  pages[mode]=html.replace('/* NATIVE_JS */',()=>bundle.outputFiles[0].text.replaceAll('</script','<\\/script'));
}
const host=mode=>`<!doctype html><meta charset="utf-8"><title>LyX host size regression</title>
<style>body{margin:0;font:13px system-ui}iframe{display:block;width:640px;height:360px;border:1px solid #aaa}pre{white-space:pre-wrap}button{margin:8px;padding:8px}</style>
<button id="run">Run resize regression</button><pre id="result">Waiting for the editor</pre>
<iframe title="LyX editor fixture" src="/editor/${mode}"></iframe>
<script>
const frame=document.querySelector('iframe'),result=document.getElementById('result');
let reports=[],calls=0,serial=0,lastSize='',phase='waiting',connected=false;
const frameSizes=new Set();
const selection={kind:'document',hasSelection:false,text:'',start:[],end:[]};
const comments=Array.from({length:8},(_,i)=>({id:'note-'+i,quote:'Selected passage '+(i+1),text:'Comment '+(i+1),resolved:false,anchor:[]}));
const state={ready:true,path:'/synthetic-review.lyx',sourceRevision:'revision',modified:false,
  hasSelection:false,selection:'',clipboardSelection:selection,inputMethod:{enabled:false,composing:false},
  capabilities:{review:true},review:{tracking:false,comments}};
function send(value){frame.contentWindow.postMessage({jsonrpc:'2.0',...value},location.origin);}
window.addEventListener('message',event=>{
  if(event.source!==frame.contentWindow||event.origin!==location.origin)return;
  const message=event.data;
  if(message.method==='ui/notifications/size-changed'){
    reports.push(message.params);result.textContent=JSON.stringify({phase,reports,calls},null,2);return;
  }
  if(message.method==='ui/initialize'){
    send({id:message.id,result:{protocolVersion:'2026-01-26',hostInfo:{name:'fixture',version:'1.0.0'},
      hostCapabilities:{serverTools:{}},hostContext:{displayMode:'fullscreen'}}});return;
  }
  if(message.method==='ui/notifications/initialized'){
    connected=true;phase='connected';send({method:'ui/notifications/tool-result',params:{_meta:{'lyx/native':{
      sessionId:'fixture',path:state.path}}}});return;
  }
  if(message.method==='tools/call'){
    calls++;const {method,params={}}=message.params.arguments;
    let value=state;
    if(method==='frame'){
      const size=JSON.stringify([params.width,params.height]);if(lastSize!==size){lastSize=size;serial++;}
      if(phase==='sampling')frameSizes.add(size);
      value={...state,width:params.width,height:params.height,serial,
        ...(params.serial===serial?{}:{surfaces:[{id:'main',main:true,x:0,y:0,width:params.width,height:params.height,
          png:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP48OHzfwAJegPTZ48ZTgAAAABJRU5ErkJggg=='}]})};
    }
    send({id:message.id,result:{content:[],_meta:{'lyx/rpc':value}}});return;
  }
  if(message.id!==undefined)send({id:message.id,result:{}});
});
document.getElementById('run').onclick=async()=>{
  reports=[];frameSizes.clear();phase='sampling';
  for(const height of [360,520,280,620,360]){
    frame.style.height=height+'px';await new Promise(resolve=>setTimeout(resolve,450));
  }
  phase='complete';
  result.textContent=JSON.stringify({phase,passed:connected&&reports.length===0&&frameSizes.size>=3,
    reports,frameSizes:[...frameSizes].map(JSON.parse),calls},null,2);
};
</script>`;
const server=createServer((request,response)=>{
  response.setHeader('Content-Type','text/html; charset=utf-8');
  const editor=request.url.startsWith('/editor/');
  const mode=request.url.endsWith('before')?'before':'after';
  response.end(editor?pages[mode]:host(mode));
});
server.listen(0,'127.0.0.1',()=>console.log('Host size regression: http://127.0.0.1:'+server.address().port+'/after'));
