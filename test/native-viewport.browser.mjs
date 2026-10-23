// Run this local browser fixture and read #result. /before uses the previous
// transform-based layout to reproduce phantom overflow at narrow panel widths.
// Real markup, viewport fitting and IME helpers execute in an actual browser.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';

const html=await readFile(new URL('../web/native.html',import.meta.url),'utf8');
const helper=await readFile(new URL('../web/native-viewport.mjs',import.meta.url),'utf8');
const imeHelper=await readFile(new URL('../web/native-ime-position.mjs',import.meta.url),'utf8');
const script=`
import {fitNativeViewport,nativeViewportSize} from '/native-viewport.mjs';
import {nativeImePosition} from '/native-ime-position.mjs';
const viewport=document.getElementById('viewport'),surfaces=document.getElementById('surfaces');
const input=document.getElementById('input');
document.getElementById('loading').hidden=true;
const before=location.pathname==='/before';
const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
const rows=[];
const cases=[...([320,360,400,479,480,620,900].map(width=>({name:'normal-'+width,width,height:420}))),
  {name:'short-panel',width:360,height:170},
  {name:'tall-dialog',width:360,height:420,dialog:{x:24,y:40,width:384,height:900}},
  {name:'wide-and-tall-dialog',width:360,height:420,dialog:{x:32,y:40,width:720,height:900}}];
function paint(image,rect){
  Object.assign(image.style,{left:rect.x+'px',top:rect.y+'px',width:rect.width+'px',height:rect.height+'px'});
  image.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="'+rect.width+'" height="'+rect.height+'"><rect width="100%" height="100%" fill="#f5f5f7" stroke="#777"/></svg>');
}
for(const scenario of cases){
  document.body.style.width=scenario.width+'px';
  viewport.style.flex='none';viewport.style.height=scenario.height+'px';
  viewport.scrollLeft=viewport.scrollTop=0;
  input.style.left=input.style.top='0';
  const main=new Image();main.alt='Native frame geometry fixture';
  surfaces.replaceChildren(main);
  const dialog=scenario.dialog?new Image():null;
  if(dialog){dialog.alt='Native dialog geometry fixture';surfaces.append(dialog);paint(dialog,scenario.dialog);}
  let frame,scale,passes=0,previous,stable=false;
  // Rendering a real overflow scrollbar changes the available client size.
  // Model subsequent frame requests until geometry stops changing, as the
  // native frame loop does. Neither browser scrollbar may cause oscillation.
  for(;passes<8;passes++){
    await settle();
    const bounds=viewport.getBoundingClientRect();
    frame=before?{width:Math.max(480,Math.round(bounds.width)),height:Math.max(300,Math.round(bounds.height))}
      :nativeViewportSize({width:viewport.clientWidth,height:viewport.clientHeight});
    paint(main,{x:0,y:0,...frame});
    if(before){
      scale=Math.min(1,bounds.width/frame.width);
      Object.assign(surfaces.style,{width:frame.width+'px',height:frame.height+'px',zoom:'1',transform:'scale('+scale+')'});
    }else scale=fitNativeViewport(surfaces,frame,viewport.clientWidth);
    await settle();
    const identity=JSON.stringify([viewport.clientWidth,viewport.clientHeight,viewport.scrollWidth,
      viewport.scrollHeight,frame.width,frame.height,scale]);
    if(identity===previous){stable=true;passes++;break;}
    previous=identity;
  }
  const mainBox=main.getBoundingClientRect();
  const horizontal=viewport.scrollWidth>viewport.clientWidth;
  const vertical=viewport.scrollHeight>viewport.clientHeight;
  const shouldScrollHorizontally=!!scenario.dialog && scenario.dialog.x+scenario.dialog.width>frame.width;
  const shouldScrollVertically=!!scenario.dialog || scenario.name==='short-panel';
  const displayedMainFits=Math.abs(mainBox.width-viewport.clientWidth)<1
    && (scenario.name==='short-panel'?mainBox.height>=viewport.clientHeight:Math.abs(mainBox.height-viewport.clientHeight)<1);
  // Read a point from the actual zoomed image bounds, then use the production
  // pointer conversion. This catches layout scale differing from input scale.
  const pointerX=(mainBox.width*.25)/scale,pointerY=(mainBox.height*.25)/scale;
  const pointerMapped=Math.abs(pointerX-frame.width*.25)<.01&&Math.abs(pointerY-frame.height*.25)<.01;
  // Scroll to the final native buttons/fields and ensure their surface edges
  // can actually be reached, not merely that overflow dimensions are nonzero.
  viewport.scrollLeft=viewport.scrollWidth;viewport.scrollTop=viewport.scrollHeight;
  await settle();
  const target=dialog??main,rect=scenario.dialog??{x:0,y:0,...frame};
  const box=target.getBoundingClientRect(),view=viewport.getBoundingClientRect();
  const farEdgesReachable=box.right<=view.left+viewport.clientWidth+1
    && box.bottom<=view.top+viewport.clientHeight+1;
  const local={x:rect.width-45,y:rect.height-45,width:1,height:20};
  const position=nativeImePosition({inputMethod:{enabled:true,rect:local},surface:rect,
    image:box,viewport:view,scrollLeft:viewport.scrollLeft,scrollTop:viewport.scrollTop});
  Object.assign(input.style,{left:position.left+'px',top:position.top+'px',height:position.height+'px'});
  await settle();
  const inputBox=input.getBoundingClientRect();
  const imeMapped=Math.abs(inputBox.left-(box.left+local.x*scale))<1
    && Math.abs(inputBox.top-(box.top+local.y*scale))<1
    && Math.abs(inputBox.height-local.height*scale)<1;
  viewport.scrollLeft=viewport.scrollTop=0;
  await settle();
  const firstBox=target.getBoundingClientRect();
  const nearEdgesReachable=firstBox.left>=view.left-1&&firstBox.top>=view.top-1;
  rows.push({name:scenario.name,width:scenario.width,height:scenario.height,passes,stable,
    clientWidth:viewport.clientWidth,scrollWidth:viewport.scrollWidth,
    clientHeight:viewport.clientHeight,scrollHeight:viewport.scrollHeight,
    displayedWidth:mainBox.width,displayedHeight:mainBox.height,scale,
    horizontal,vertical,shouldScrollHorizontally,shouldScrollVertically,
    displayedMainFits,pointerMapped,imeMapped,farEdgesReachable,nearEdgesReachable});
}
const zeroPanelsSkipped=[{width:0,height:420},{width:360,height:0}].every(bounds=>nativeViewportSize(bounds)===null);
const passed=zeroPanelsSkipped&&rows.every(r=>r.stable&&r.displayedMainFits&&r.pointerMapped&&r.imeMapped
  &&r.horizontal===r.shouldScrollHorizontally&&r.vertical===r.shouldScrollVertically
  &&r.farEdgesReachable&&r.nearEdgesReachable);
const result=document.createElement('pre');result.id='result';
result.style.cssText='position:fixed;inset:90px 10px 10px;background:white;z-index:2000;overflow:auto;font-size:13px';
result.textContent=JSON.stringify({passed,zoomSupported:CSS.supports('zoom','0.75'),zeroPanelsSkipped,rows},null,2);
document.body.append(result);
`;
const server=createServer((request,response)=>{
  const module=request.url==='/native-viewport.mjs'?helper:request.url==='/native-ime-position.mjs'?imeHelper:null;
  if(module!==null){
    response.setHeader('Content-Type','text/javascript; charset=utf-8');response.end(module);return;
  }
  response.setHeader('Content-Type','text/html; charset=utf-8');
  response.end(html.replace('/* NATIVE_JS */',script));
});
server.listen(0,'127.0.0.1',()=>console.log('Native viewport regression: http://127.0.0.1:'+server.address().port+'/'));
