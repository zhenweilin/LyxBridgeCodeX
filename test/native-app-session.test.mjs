import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {build} from 'esbuild';

// Execute the real bundled frontend against inert DOM and host adapters. No
// browser, production broker, user document, or system clipboard is involved.
const bundle=await build({entryPoints:['web/native-app.mjs'],bundle:true,write:false,format:'esm',
  plugins:[{name:'test-host',setup(builder){
    builder.onResolve({filter:/^(@modelcontextprotocol\/ext-apps|@openai\/mcp-extensions\/app)$/},args=>({path:args.path,namespace:'test-host'}));
    builder.onLoad({filter:/.*/,namespace:'test-host'},()=>({contents:`
      export class App {
        constructor(){ __host.app=this; }
        addEventListener(){}
        async connect(){}
        callServerTool(request){ return __host.call(request); }
      }
      export class OpenAIExtensions { constructor(){return __host.extensions;} }
    `}));
  }}]});
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));

function element(){
  const listeners=new Map();
  return {style:{},dataset:{},children:[],value:'',scrollLeft:0,scrollTop:0,
    addEventListener(type,callback){listeners.set(type,[...(listeners.get(type)??[]),callback]);},
    dispatch(type,extra={}){return Promise.all((listeners.get(type)??[]).map(callback=>callback({type,target:this,preventDefault(){},...extra})));},
    setAttribute(){},append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},remove(){},focus(){},
    insertBefore(item){this.children.push(item);},querySelector(){return null;},
    getBoundingClientRect(){return {left:0,top:0,width:800,height:600};},
  };
}
function state(sessionId){return {ready:true,path:`/${sessionId}.lyx`,modified:false,hasSelection:false,
  selection:'',selectionStart:[],selectionEnd:[],inputMethod:{enabled:false},
  capabilities:{pointerCancel:true}};}

async function harness(call){
  const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};
  const document={hidden:false,body:element(),getElementById:get,createElement:element,querySelector:element,
    addEventListener(){},removeEventListener(){}};
  const contexts=[],drafts=[];
  const host={call:async request=>({_meta:{'lyx/rpc':await call(request.arguments)}}),extensions:{
    modelContext:{async update(context){contexts.push(context);return {updateId:'accepted'};}},
    message:{async send(draft){drafts.push(draft);return {};}}}};
  const timers=new Map();let timerId=0,clock=0;
  await vm.runInNewContext(`(async()=>{${bundle.outputFiles[0].text}\n})()`,{__host:host,document,window:{parent:{},addEventListener(){}},
    crypto:webcrypto,TextEncoder,TextDecoder,atob,btoa,Image:element,performance:{now:()=>clock},
    setTimeout:(callback,delay=0)=>{timers.set(++timerId,{callback,at:clock+delay});return timerId;},clearTimeout:id=>timers.delete(id)});
  await flush();
  const attach=id=>host.app.ontoolresult({_meta:{'lyx/native':{sessionId:id,path:`/${id}.lyx`}}});
  const commit=text=>get('input').dispatch('beforeinput',{inputType:'insertText',data:text,cancelable:true});
  const paint=async()=>{const [id,timer]=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];
    timers.delete(id);clock=timer.at;timer.callback();await flush();};
  const wheel=async(deltaY=1)=>get('surfaces').dispatch('wheel',{deltaMode:0,deltaX:0,deltaY,clientX:200,clientY:200,
    target:{closest:()=>({dataset:{surface:'main'},getBoundingClientRect:()=>({left:0,top:0})})}});
  return {get,attach,commit,contexts,drafts,flush,paint,wheel};
}

test('the real frontend coalesces slow wheel RPCs without crossing typing, chat or session barriers',async()=>{
  const gate=deferred(),calls=[];let block=true;
  const ui=await harness(async request=>{
    calls.push(request);
    if(request.method==='input' && block){block=false;await gate.promise;}
    if(request.method==='selection')return {...state(request.sessionId),hasSelection:true,
      selection:'Selected passage',source:'Document source'};
    return {...state(request.sessionId),capabilities:{wheelInput:true},serial:1,width:800,height:600,
      ...(request.method==='frame'?{surfaces:[{id:'main',main:true,width:800,height:600,x:0,y:0,png:'',
        scrollViewport:{x:0,y:100,width:800,height:500}}]}:{})};
  });
  ui.attach('A');await ui.paint();await ui.wheel(1);
  for(let i=0;i<120;i++)await ui.wheel(.125);
  const adding=ui.get('add').dispatch('click');
  await ui.wheel(2);await ui.wheel(3);await ui.commit('after scroll');
  await ui.wheel(-5);await ui.wheel(-6);
  ui.attach('B');await ui.paint();await ui.wheel(7);await ui.wheel(8);
  gate.resolve();await adding;await flush();await flush();
  assert.deepEqual(calls.filter(item=>item.method==='input').map(item=>[item.sessionId,item.params.dy??item.params.text]),[
    ['A',-1],['A',-15],['A',-5],['A','after scroll'],['A',11],['B',-15],
  ]);
  assert.equal(calls.filter(item=>item.method==='state').length,6,'One state barrier per executed operation');
  const at=calls.findIndex(item=>item.method==='selection');
  assert.equal(calls[at-1].method,'state');
  assert.equal(calls[at+1].params.dy,-5,'Later scrolling cannot overtake the clicked chat context');
  assert.equal(ui.contexts[0].structuredContent.sessionId,'A');
  assert.equal(ui.get('filename').textContent,'B.lyx');
});

test('queued frontend edits and their state barriers stay with the document that received the input',async()=>{
  const gate=deferred(),calls=[];
  const ui=await harness(async request=>{
    calls.push(request);
    if(request.method==='input' && request.params.text==='first')await gate.promise;
    return state(request.sessionId);
  });
  ui.attach('A');
  await ui.commit('first');await ui.commit('second');
  ui.attach('B');await ui.commit('third');
  gate.resolve();await flush();await flush();
  assert.deepEqual(calls.filter(call=>call.method==='input').map(call=>[call.sessionId,call.params.text]),
    [['A','first'],['A','second'],['B','third']]);
  assert.deepEqual(calls.filter(call=>call.method==='state').map(call=>call.sessionId),['A','A','B']);
  assert.equal(ui.get('filename').textContent,'B.lyx');
});

test('combined input state avoids a second host call without changing queue, chat or document ordering',async()=>{
  const gate=deferred(),calls=[];let block=true;
  const ui=await harness(async request=>{
    calls.push(request);
    if(request.method==='input'){
      assert.equal(request.params.replyWithState,true);
      if(block){block=false;await gate.promise;}
      return {...state(request.sessionId),modified:true,stateAfterInput:true};
    }
    if(request.method==='selection')return {...state(request.sessionId),hasSelection:true,
      selection:`Passage ${request.sessionId}`,source:`Source ${request.sessionId}`};
    assert.fail(`Unexpected host request: ${request.method}`);
  });
  ui.attach('A');await ui.commit('first');await ui.commit('second');
  const adding=ui.get('add').dispatch('click');
  await ui.commit('after snapshot');ui.attach('B');await ui.commit('new document');
  assert.equal(calls.length,1,'The queued input cannot overtake the pending input/state response');
  gate.resolve();await adding;await flush();await flush();
  assert.deepEqual(calls.map(call=>[call.sessionId,call.method,call.params.text??'']),[
    ['A','input','first'],['A','input','second'],['A','selection',''],
    ['A','input','after snapshot'],['B','input','new document'],
  ]);
  assert.equal(ui.contexts[0].structuredContent.sessionId,'A');
  assert.equal(ui.get('filename').textContent,'B.lyx');
  assert.equal(ui.get('saved').textContent,'Unsaved');
});

test('the frontend falls back to a state read only when the combined-response marker is absent',async()=>{
  const calls=[];
  const ui=await harness(async request=>{
    calls.push(request);
    const combined=request.params.text==='new-server';
    return {...state(request.sessionId),modified:request.method==='state'||combined,
      ...(combined?{stateAfterInput:true}:{})};
  });
  ui.attach('A');await ui.commit('old-server');await flush();
  await ui.commit('new-server');await flush();
  assert.deepEqual(calls.map(call=>call.method),['input','state','input']);
  assert.equal(ui.get('saved').textContent,'Unsaved');
});

test('ordinary modifier input does not overwrite the combined-state capability observation',async()=>{
  const calls=[];
  const ui=await harness(async request=>{
    calls.push(request);
    return {...state(request.sessionId),...(request.params.replyWithState?{stateAfterInput:true}:{})};
  });
  ui.attach('A');await ui.commit('combined input');await flush();
  assert.equal(ui.get('surfaces').dataset.inputStateCombined,'true');
  await ui.get('input').dispatch('keydown',{key:'Shift',shiftKey:true});await flush();
  assert.equal(calls.at(-1).params.type,'keydown');
  assert.equal(calls.at(-1).params.replyWithState,undefined);
  assert.equal(ui.get('surfaces').dataset.inputStateCombined,'true');
  ui.attach('B');
  assert.equal(ui.get('surfaces').dataset.inputStateCombined,undefined);
});

test('a failed combined input response never replays input or falls back to state as success',async()=>{
  const calls=[];
  const ui=await harness(async request=>{calls.push(request);throw new Error('Post-input state unavailable');});
  ui.attach('A');await ui.commit('once only');await flush();await flush();
  assert.deepEqual(calls.map(call=>call.method),['input']);
  assert.match(ui.get('notice').textContent,/Post-input state unavailable/);
});

test('delayed image bytes retain their native queue position, document and selection guards',async()=>{
  const gate=deferred(),calls=[];let reads=0;
  const selection={kind:'document',hasSelection:false,text:'',start:[{position:4}],end:[{position:4}]};
  const ui=await harness(async request=>{
    calls.push(request);
    return {...state(request.sessionId),sourceRevision:`revision-${request.sessionId}`,
      clipboardSelection:selection,capabilities:{imagePaste:true}};
  });
  ui.attach('A');
  await ui.get('input').dispatch('paste',{clipboardData:{getData:()=>'',items:[{kind:'file',getAsFile:()=>({
    type:'image/png',size:3,arrayBuffer(){reads++;return gate.promise;},
  })}]}});
  await ui.commit('after-image-A');ui.attach('B');await ui.commit('after-image-B');
  await flush();
  assert.equal(reads,1);
  assert.equal(calls.some(call=>call.method==='clipboard'||call.method==='input'),false);
  gate.resolve(Uint8Array.of(137,80,78).buffer);await flush();await flush();
  const mutations=calls.filter(call=>['clipboard','input'].includes(call.method));
  assert.deepEqual(mutations.map(call=>[call.sessionId,call.method]),[['A','clipboard'],['A','input'],['B','input']]);
  assert.equal(mutations[0].params.image.data,'iVBO');
  assert.equal(mutations[0].params.expectedPath,'/A.lyx');
  assert.equal(mutations[0].params.expectedSourceRevision,'revision-A');
  assert.equal(JSON.stringify(mutations[0].params.expectedSelection),JSON.stringify(selection));
});

test('image paste into an older native engine fails before reading bytes or sending a mutation',async()=>{
  const calls=[];let reads=0;
  const ui=await harness(async request=>{calls.push(request);return state(request.sessionId);});
  ui.attach('A');
  await ui.get('input').dispatch('paste',{clipboardData:{getData:()=>'',items:[{kind:'file',getAsFile:()=>({
    type:'image/png',size:3,async arrayBuffer(){reads++;return Uint8Array.of(137,80,78).buffer;},
  })}]}});
  await flush();await flush();
  assert.equal(reads,0);
  assert.equal(calls.some(call=>call.method==='clipboard'),false);
  assert.match(ui.get('notice').textContent,/Save your document.*close and reopen/);
});

test('image chunks and their single commit finish in the originating queue slot before later typing',async()=>{
  const gate=deferred(),calls=[];
  const selection={kind:'document',hasSelection:false,text:'',start:[{position:4}],end:[{position:4}]};
  const ui=await harness(async request=>{
    calls.push(request);
    if(request.params.action==='image-begin')return {uploadId:'A-upload',maxChunkBytes:3};
    if(request.params.action==='image-chunk'&&request.params.offset===0)await gate.promise;
    return {...state(request.sessionId),sourceRevision:'A-revision',clipboardSelection:selection,
      capabilities:{imagePaste:true,imagePasteChunks:true}};
  });
  ui.attach('A');
  await ui.get('input').dispatch('paste',{clipboardData:{getData:()=>'',items:[{kind:'file',getAsFile:()=>({
    type:'image/png',size:5,async arrayBuffer(){return Uint8Array.of(1,2,3,4,5).buffer;},
  })}]}});
  await flush();
  await ui.commit('after-A');ui.attach('B');await ui.commit('after-B');
  assert.equal(calls.some(item=>item.method==='input'),false);
  gate.resolve();await flush();await flush();
  assert.deepEqual(calls.filter(item=>item.method==='clipboard'||item.method==='input')
    .map(item=>[item.sessionId,item.params.action??item.params.text]),[
      ['A','image-begin'],['A','image-chunk'],['A','image-chunk'],['A','image-commit'],
      ['A','after-A'],['B','after-B'],
    ]);
  const begin=calls.find(item=>item.params.action==='image-begin');
  assert.equal(begin.params.expectedPath,'/A.lyx');
  assert.equal(begin.params.expectedSourceRevision,'A-revision');
  assert.equal(JSON.stringify(begin.params.expectedSelection),JSON.stringify(selection));
});

test('add to chat keeps the clicked document and native session while another file attaches',async()=>{
  const gate=deferred(),calls=[];
  const ui=await harness(async request=>{
    calls.push(request);
    if(request.method==='input')await gate.promise;
    if(request.method==='selection')return {...state(request.sessionId),hasSelection:true,
      selection:`Passage ${request.sessionId}`,source:`Source ${request.sessionId}`};
    return state(request.sessionId);
  });
  ui.attach('A');await ui.commit('pending');
  const adding=ui.get('add').dispatch('click');
  ui.attach('B');gate.resolve();await adding;
  assert.equal(calls.find(call=>call.method==='selection').sessionId,'A');
  assert.equal(ui.contexts[0].structuredContent.file,'/A.lyx');
  assert.equal(ui.contexts[0].structuredContent.sessionId,'A');
  assert.equal(ui.contexts[0].structuredContent.text,'Passage A');
  assert.equal(ui.drafts.length,0,'Adding context must not write to the composer or send a message');
});

test('a late result from the old document cannot restore its controls or status in the new panel',async()=>{
  const gate=deferred();
  const ui=await harness(async request=>{
    if(request.method==='input')await gate.promise;
    return {...state(request.sessionId),modified:true,hasSelection:true,selection:'Old selection'};
  });
  ui.attach('A');await ui.commit('pending');ui.attach('B');
  gate.resolve();await flush();await flush();
  assert.equal(ui.get('filename').textContent,'B.lyx');
  assert.equal(ui.get('saved').textContent,'Connecting');
  assert.equal(ui.get('add').disabled,true);
  assert.equal(ui.get('save').disabled,true);
  assert.equal(ui.get('selection').textContent,'Select text or a formula in LyX');
});

test('closing the last native document clears its selection, filename, and save controls',async()=>{
  let inputs=0;
  const ui=await harness(async request=>{
    if(request.method==='input')inputs++;
    return inputs<2?{...state(request.sessionId),modified:true,hasSelection:true,selection:'Former selection'}
      :{ready:false,hasSelection:false,selection:'',inputMethod:{enabled:false}};
  });
  ui.attach('A');await ui.commit('first');await flush();
  assert.equal(ui.get('filename').textContent,'A.lyx');
  assert.equal(ui.get('saved').textContent,'Unsaved');
  assert.equal(ui.get('add').disabled,false);
  await ui.commit('close response');await flush();
  assert.equal(ui.get('filename').textContent,'No document open');
  assert.equal(ui.get('filename').title,'');
  assert.equal(ui.get('saved').textContent,'');
  assert.equal(ui.get('save').disabled,true);
  assert.equal(ui.get('add').disabled,true);
  assert.equal(ui.get('selection').textContent,'Open or create a document using the File menu');
});
