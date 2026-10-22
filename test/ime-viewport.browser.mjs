// Browser layout regression: run `node test/ime-viewport.browser.mjs`, open
// the printed URL, and inspect #result. /before reproduces the old overflow.
// Uses the real editor markup; no native engine or document is needed.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';

const html=await readFile(new URL('../web/native.html',import.meta.url),'utf8');
const script=`
const viewport=document.getElementById('viewport'),surfaces=document.getElementById('surfaces'),input=document.getElementById('input');
document.getElementById('loading').hidden=true;
surfaces.style.width=viewport.clientWidth+'px';surfaces.style.height=viewport.clientHeight+'px';
const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
const rows=[],height=viewport.clientHeight;
for(const y of [height-83,height-3,height+77,76,-200,height+2000,height-30]){
  input.style.top=y+'px';input.style.left='67px';input.style.height='25px';
  input.focus({preventScroll:true});await frame();
  rows.push({caretY:y,clientHeight:viewport.clientHeight,scrollHeight:viewport.scrollHeight,
    scrollTop:viewport.scrollTop,focused:document.activeElement===input});
}
const passed=rows.every(r=>r.scrollHeight===height && r.scrollTop===0 && r.clientHeight===height && r.focused);
const result=document.createElement('pre');result.id='result';
result.style.cssText='position:fixed;top:100px;left:10px;background:white;z-index:1000;font-size:13px;';
result.textContent=JSON.stringify({passed,rows},null,2);document.body.append(result);
`;
const server=createServer((request,response)=>{
  let page=html;
  if(request.url==='/before')page=page.replace('<div id="ime-layer">','').replace('</textarea></div>','</textarea>');
  response.setHeader('Content-Type','text/html; charset=utf-8');
  response.end(page.replace('/* NATIVE_JS */',script));
});
server.listen(0,'127.0.0.1',()=>console.log(`IME viewport regression: http://127.0.0.1:${server.address().port}/`));
