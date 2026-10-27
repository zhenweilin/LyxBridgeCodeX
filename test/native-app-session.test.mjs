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
        constructor(info,capabilities,options){ __host.app=this; __host.appOptions=options; }
        addEventListener(type,callback){ __host.listeners.set(type,callback); }
        async connect(){ await __host.connect(); }
        callServerTool(request){ return __host.call(request); }
      }
      export class OpenAIExtensions { constructor(){return __host.extensions;} }
    `}));
  }}]});
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));

function element(){
  const listeners=new Map(),pointers=new Set();
  return {style:{},dataset:{},children:[],hidden:true,value:'',scrollLeft:0,scrollTop:0,
    addEventListener(type,callback){listeners.set(type,[...(listeners.get(type)??[]),callback]);},
    dispatch(type,extra={}){return Promise.all((listeners.get(type)??[]).map(callback=>callback({type,target:this,preventDefault(){},...extra})));},
    setAttribute(){},append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},remove(){},focus(){},
    setPointerCapture(id){pointers.add(id);},hasPointerCapture(id){return pointers.has(id);},releasePointerCapture(id){pointers.delete(id);},
    insertBefore(item){this.children.push(item);},querySelector(){return null;},
    getBoundingClientRect(){return {left:0,top:0,width:800,height:600};},
    get clientWidth(){return this.getBoundingClientRect().width;},
    get clientHeight(){return this.getBoundingClientRect().height;},
  };
}
function state(sessionId){return {ready:true,path:`/${sessionId}.lyx`,modified:false,hasSelection:false,
  selection:'',selectionStart:[],selectionEnd:[],inputMethod:{enabled:false},
  capabilities:{pointerCancel:true}};}

async function harness(call,{connect=async()=>{},open=async()=>({}),reopen=async()=>({}),standaloneDescriptor,fetch}={}){
  const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};
  const document={hidden:false,body:element(),getElementById:get,createElement:element,createTextNode:text=>({textContent:text}),querySelector:element,
    addEventListener(){},removeEventListener(){}};
  const contexts=[],drafts=[];
  const host={connect,listeners:new Map(),call:async request=>{
    if(request.name==='start_native_lyx')return open();
    if(request.name==='reopen_native_lyx')return reopen(request.arguments);
    const result=await call(request.arguments);
    return result?.isError===true?result:{_meta:{'lyx/rpc':result}};
  },extensions:{
    modelContext:{async update(context){contexts.push(context);return {updateId:'accepted'};}},
    message:{async send(draft){drafts.push(draft);return {};}}}};
  const timers=new Map(),intervals=[];let timerId=0,clock=0;
  const window={parent:{},addEventListener(){}};
  if(standaloneDescriptor){window.parent=window;window.__LYX_NATIVE__=standaloneDescriptor;}
  await vm.runInNewContext(`(async()=>{${bundle.outputFiles[0].text}\n})()`,{__host:host,document,window,fetch,
    setInterval:callback=>{intervals.push(callback);return 0;},
    crypto:webcrypto,TextEncoder,TextDecoder,atob,btoa,Image:element,performance:{now:()=>clock},
    setTimeout:(callback,delay=0)=>{timers.set(++timerId,{callback,at:clock+delay});return timerId;},clearTimeout:id=>timers.delete(id)});
  await flush();
  const attach=id=>host.app.ontoolresult({_meta:{'lyx/native':{sessionId:id,path:`/${id}.lyx`}}});
  const commit=text=>get('input').dispatch('beforeinput',{inputType:'insertText',data:text,cancelable:true});
  const paint=async()=>{const [id,timer]=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];
    timers.delete(id);clock=timer.at;timer.callback();await flush();};
  const wheel=async(deltaY=1)=>get('surfaces').dispatch('wheel',{deltaMode:0,deltaX:0,deltaY,clientX:200,clientY:200,
    target:{closest:()=>({dataset:{surface:'main'},getBoundingClientRect:()=>({left:0,top:0})})}});
  return {get,attach,commit,contexts,drafts,flush,paint,wheel,intervals,time:()=>clock,appOptions:host.appOptions,
    result:value=>host.app.ontoolresult(value),
    toolinput:args=>host.listeners.get('toolinput')?.({arguments:args})};
}

test('viewport-sized editor leaves host height control with the host',async()=>{
  const ui=await harness(async request=>state(request.sessionId));
  assert.equal(ui.appOptions.autoResize,false,'Content-height reporting would feed native frame height back into the host');
});

test('continuous wheel input defers whole-document review reads until the gesture settles',async()=>{
  let reads=0;
  const ui=await harness(async request=>{
    if(request.method==='selection')reads++;
    return {...state(request.sessionId),stateAfterInput:request.method==='input',sourceRevision:'revision',
      capabilities:{review:true},review:{comments:[],tracking:false},width:800,height:600,serial:1,
      surfaces:[{id:'main',main:true,x:0,y:0,width:800,height:600,png:'',scrollViewport:{x:0,y:0,width:800,height:600}}]};
  });
  ui.attach('A');await ui.paint();ui.get('review-toggle').onclick();await flush();
  assert.equal(reads,1);
  for(let i=0;i<35;i++){
    await ui.wheel(3);await flush();await ui.paint();
    for(const callback of ui.intervals)callback();await flush();
    assert.equal(reads,1,'Neither input completion nor passive polling interrupts continuous scrolling');
  }
  const stopped=ui.time();while(ui.time()<stopped+220)await ui.paint();await flush();
  assert.equal(reads,2,'One final review snapshot catches up after input is quiet');
});

test('drag selection stays responsive with review open and only prepares the final clipboard',async()=>{
  let reads=0,selected='',copies=[];
  const ui=await harness(async request=>{
    if(request.method==='selection')reads++;
    if(request.method==='input' && request.params.type==='pointermove')selected=`Selected through ${request.params.x}`;
    if(request.method==='clipboard'){copies.push(request.params.expectedSelection.text);return {clipboard:{text:selected}};}
    return {...state(request.sessionId),stateAfterInput:request.method==='input',sourceRevision:'revision',
      hasSelection:!!selected,selection:selected,
      clipboardSelection:{kind:'document',hasSelection:!!selected,text:selected,start:[],end:[]},
      capabilities:{review:true,pointerCancel:true},review:{comments:[],tracking:false},
      width:800,height:600,serial:1,surfaces:[{id:'main',main:true,x:0,y:0,width:800,height:600,png:''}]};
  });
  ui.attach('A');await ui.paint();ui.get('review-toggle').onclick();await flush();
  const image={dataset:{surface:'main'},getBoundingClientRect:()=>({left:0,top:0})};
  const pointer=(type,x)=>ui.get('surfaces').dispatch(type,{pointerId:1,clientX:x,clientY:200,
    button:0,buttons:type==='pointerup'?0:1,target:{closest:()=>image}});
  await pointer('pointerdown',200);await flush();
  for(let i=0;i<35;i++){
    await pointer('pointermove',210+i);await flush();await ui.paint();
    for(const callback of ui.intervals)callback();await flush();
    assert.equal(reads,1,'The open review panel cannot serialize the whole document mid-drag');
    assert.equal(copies.length,0,'Intermediate selections do not trigger native MIME copies');
  }
  await pointer('pointerup',244);await flush();await flush();
  assert.deepEqual(copies,['Selected through 244']);
  const stopped=ui.time();while(ui.time()<stopped+220)await ui.paint();await flush();
  assert.equal(reads,2);
  assert.match(ui.get('selection').textContent,/Selected through 244/);
});

test('starting a comment immediately after selecting text still captures a full draft',async()=>{
  let reads=0;
  const ui=await harness(async request=>{
    if(request.method==='selection')reads++;
    return {...state(request.sessionId),stateAfterInput:request.method==='input',sourceRevision:'revision',
      hasSelection:true,selection:'Immediate comment target',
      clipboardSelection:{kind:'document',hasSelection:true,text:'Immediate comment target',start:[],end:[]},
      capabilities:{review:true},review:{comments:[],tracking:false}};
  });
  ui.attach('A');await ui.paint();
  await ui.wheel(1);await flush();
  await ui.get('review-new').onclick();
  assert.equal(reads,1,'Explicit comment capture is never deferred as passive polling');
  assert.equal(ui.get('review-draft').hidden,false);
  assert.equal(ui.get('review-quote').textContent,'Immediate comment target');
  assert.equal(ui.get('review-error').textContent,'');
});

test('the actual paste handler requests native recovery only on a capable connection',async()=>{
  for(const supported of [true,false]){
    const calls=[];
    const ui=await harness(async request=>{
      calls.push(request);return {...state(request.sessionId),uiCapabilities:{externalLyxPaste:supported}};
    });
    ui.attach('A');await ui.paint();
    await ui.get('input').dispatch('paste',{clipboardData:{getData:type=>type==='text/plain'?'x^{2}'
      :type==='text/html'?'<div id="magicparlabel-1"><math>x²</math></div>':''}});
    await flush();
    const pastes=calls.filter(call=>call.method==='clipboard');
    assert.equal(pastes.length,supported?1:0,'An old service cannot silently insert the formula as plain text');
    if(supported){assert.equal(pastes[0].sessionId,'A');assert.equal(pastes[0].params.recoverExternalLyx,'required');}
    else assert.match(ui.get('notice').textContent,/Reload the plugin connection/);
  }
});

test('background review refresh leaves enabled controls, cards and scroll position stable',async()=>{
  const gate=deferred();let delayed=false,reads=0;
  const comment={id:'first',quote:'Passage',text:'Comment',resolved:false,anchor:[]};
  const ui=await harness(async request=>{
    if(request.method==='selection'){reads++;if(delayed)await gate.promise;}
    return {...state(request.sessionId),sourceRevision:'revision',capabilities:{review:true},
      review:{comments:[comment],tracking:false}};
  });
  ui.attach('A');await ui.paint();ui.get('review-toggle').onclick();await flush();
  const controls=['next','previous','accept','reject','new','refresh','attach'].map(name=>ui.get(`review-${name}`));
  const disabled=controls.map(node=>node.disabled);
  const card=ui.get('review-comments').children[0];
  ui.get('review-panel').scrollTop=180;
  ui.get('review-error').textContent='Keep this action error until the next action.';
  const changes=[];
  for(const node of controls){let value=node.disabled;Object.defineProperty(node,'disabled',{
    get:()=>value,set:next=>{changes.push(next);value=next;},configurable:true});}
  delayed=true;const beforeReads=reads;
  for(const callback of ui.intervals)callback();await flush();
  for(const callback of ui.intervals)callback();await flush();
  assert.equal(reads,beforeReads+1,'Only one background refresh may be in flight');
  assert.deepEqual(controls.map(node=>node.disabled),disabled,'Slow polling does not disable the review controls');
  gate.resolve();await flush();await flush();
  assert.deepEqual(changes,[],'Unchanged frame/read state never toggles disabled attributes');
  assert.equal(ui.get('review-comments').children[0],card);
  assert.equal(ui.get('review-panel').scrollTop,180);
  assert.equal(ui.get('review-error').textContent,'Keep this action error until the next action.');
});

test('background review queries preserve the idle frame cadence and prepared clipboard',async()=>{
  let copies=0;
  const ui=await harness(async request=>{
    if(request.method==='clipboard'){copies++;return {clipboard:{text:'Selected passage'}};}
    return {...state(request.sessionId),sourceRevision:'revision',hasSelection:true,selection:'Selected passage',
      clipboardSelection:{kind:'document',hasSelection:true,text:'Selected passage',start:[],end:[]},
      capabilities:{review:true},review:{comments:[],tracking:false}};
  });
  ui.attach('A');await ui.paint();ui.get('review-toggle').onclick();await flush();
  while(ui.time()<1000)await ui.paint();
  const previousTime=ui.time(),previousCopies=copies;
  assert.ok(previousCopies>0,'A native selection was prepared for copying');
  for(const callback of ui.intervals)callback();await flush();await flush();
  await ui.paint();
  assert.equal(ui.time()-previousTime,250,'A read does not activate the 16 ms frame loop');
  assert.equal(copies,previousCopies,'A read does not discard and refetch the selection clipboard');
});

test('the real sidebar attaches checked native comments together and resets on a document switch',async()=>{
  const comments=[{id:'first',quote:'First passage',text:'Add a citation.',resolved:false,anchor:[]},
    {id:'second',quote:'Second passage',text:'Explain the assumptions.',resolved:false,anchor:[]}];
  const ui=await harness(async request=>({...state(request.sessionId),sourceRevision:'current-revision',
    capabilities:{review:true},review:{comments:request.sessionId==='A'?comments:[],tracking:false}}));
  ui.attach('A');await ui.paint();
  ui.get('review-toggle').onclick();await flush();
  assert.equal(ui.get('review-comments').children.length,2);
  assert.equal(ui.get('review-attach').disabled,false);
  await ui.get('review-attach').onclick();
  assert.equal(ui.contexts.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.contexts[0].structuredContent.comments)),comments);
  assert.equal(ui.contexts[0].structuredContent.sessionId,'A');
  assert.equal(ui.contexts[0].structuredContent.sourceRevision,'current-revision');
  assert.equal(ui.drafts.length,0,'Attaching annotations never sends a chat message');
  const checkbox=ui.get('review-comments').children[0].children[0].children[0];
  checkbox.checked=false;await checkbox.dispatch('change');
  await ui.get('review-attach').onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.contexts[1].structuredContent.comments)),[comments[1]]);
  ui.attach('B');await ui.paint();
  assert.equal(ui.get('review-comments').children.length,0);
  assert.equal(ui.get('review-attach').disabled,true);
  assert.equal(ui.get('review-attach').dataset.contextUpdateId,undefined);
});

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
  assert.equal(ui.contexts[0].content[0].text,'LyX selection · A.lyx\n\nPassage A');
  assert.equal(ui.drafts.length,0,'Adding context must not write to the composer or send a message');
});

test('add to chat requests a compact snapshot and attaches its native target without full source',async()=>{
  const calls=[],snapshotId='94967851-1772-4cb8-a958-002606a48fab';
  const ui=await harness(async request=>{
    calls.push(request);
    return {...state(request.sessionId),hasSelection:true,selection:'Compact passage',
      sourceRevision:'a'.repeat(64),snapshotId,selectionFormat:'text',modelCapabilities:{selectionSnapshots:true}};
  });
  ui.attach('A');await ui.paint();
  await ui.get('add').dispatch('click');
  assert.equal(calls.filter(item=>item.method==='selection').length,1);
  assert.equal(calls.find(item=>item.method==='selection').params.captureEdit,true);
  assert.equal(ui.contexts[0].structuredContent.snapshotId,snapshotId);
  assert.equal(ui.contexts[0].structuredContent.sessionId,'A');
  assert.equal(ui.contexts[0].structuredContent.source,undefined);
  assert.match(ui.get('notice').textContent,/move the cursor/);
  assert.equal(ui.drafts.length,0);
});

test('a rebuilt panel and native engine behind an old MCP service do not advertise an unavailable snapshot tool',async()=>{
  const ui=await harness(async request=>({...state(request.sessionId),hasSelection:true,selection:'Passage',
    sourceRevision:'a'.repeat(64),snapshotId:'94967851-1772-4cb8-a958-002606a48fab',selectionFormat:'text',
    clipboardSelection:{kind:'document',hasSelection:true,text:'Passage',start:[{paragraph:0,position:0,cell:0}],end:[{paragraph:0,position:7,cell:0}]},
    capabilities:{editSelection:true,compositionGuard:true,selectionSnapshots:true}}));
  ui.attach('A');await ui.paint();await ui.get('add').dispatch('click');
  assert.equal(ui.contexts[0].structuredContent.snapshotId,undefined);
  assert.equal(ui.contexts[0].structuredContent.editingSupported,true);
  assert.equal(ui.contexts[0].content[0].text,'LyX selection · A.lyx\n\nPassage');
  assert.doesNotMatch(ui.contexts[0].content[0].text,/replace_native_lyx_snapshot/);
  assert.doesNotMatch(ui.get('notice').textContent,/move the cursor/);
  assert.equal(ui.get('add').dataset.contextAttached,'true');
  assert.equal(ui.drafts.length,0);
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

test('connection loss blocks new edits and chat actions until a read-only retry recovers the current session',async()=>{
  let broken=false,opens=0;const calls=[];
  const ui=await harness(async request=>{
    calls.push(request);
    if(broken && request.method==='frame')throw new Error('Connection lost');
    return {...state(request.sessionId),hasSelection:true,selection:'Selected text',source:'Source',
      ...(request.method==='input'?{stateAfterInput:true}:{}),modified:false};
  },{open:async()=>{opens++;assert.fail('An existing session must not be restarted');}});
  ui.attach('A');await ui.paint();await flush();
  broken=true;await ui.paint();
  assert.equal(ui.get('connection-banner').hidden,false);
  assert.match(ui.get('connection-message').textContent,/Editing is paused.*Connection lost/);
  assert.equal(ui.get('saved').textContent,'Reconnecting…');
  assert.equal(ui.get('save').disabled,true);assert.equal(ui.get('add').disabled,true);
  assert.equal(ui.get('input').readOnly,true);
  const before=calls.length;
  await ui.commit('do not send');await ui.get('save').dispatch('click');
  await ui.get('add').dispatch('click');await ui.wheel();
  assert.equal(calls.length,before,'Known-disconnected input cannot enter the native queue');
  await ui.get('retry').dispatch('click');
  assert.equal(calls.at(-1).method,'frame');
  assert.equal(ui.get('connection-banner').hidden,false,'Failed retries leave persistent feedback');
  broken=false;await ui.get('retry').dispatch('click');
  assert.equal(opens,0);assert.equal(ui.get('connection-banner').hidden,true);
  assert.equal(ui.get('input').readOnly,false);assert.equal(ui.get('saved').textContent,'Saved');
  assert.equal(ui.get('save').disabled,false);assert.equal(ui.get('add').disabled,false);
  await ui.commit('new input after recovery');await flush();
  assert.deepEqual(calls.filter(call=>call.method==='input').map(call=>call.params.text),['new input after recovery']);
});

test('a failed mutation is never replayed by automatic recovery or Retry',async()=>{
  const calls=[];
  const ui=await harness(async request=>{
    calls.push(request);
    if(request.method==='input')throw new Error('Transport failed after the write may have happened');
    return state(request.sessionId);
  });
  ui.attach('A');await ui.paint();await ui.commit('once only');await flush();
  assert.equal(ui.get('save').disabled,true);
  await ui.paint();await ui.get('retry').dispatch('click');
  assert.equal(calls.filter(call=>call.method==='input').length,1);
  assert.equal(ui.get('connection-banner').hidden,true);
});

for(const message of ['connection_closed','Native request timed out'])
test(`an MCP error envelope (${message}) pauses editing without replaying the mutation`,async()=>{
  const calls=[];
  const ui=await harness(async request=>{
    calls.push(request);
    if(request.method==='input')return {isError:true,content:[{type:'text',text:message}],
      _meta:{'lyx/rpc':{error:true,message}}};
    return state(request.sessionId);
  });
  ui.attach('A');await ui.paint();await ui.commit('uncertain mutation');await flush();
  assert.equal(ui.get('input').readOnly,true);assert.equal(ui.get('save').disabled,true);
  assert.match(ui.get('connection-message').textContent,new RegExp(message));
  await ui.commit('blocked while disconnected');await ui.get('retry').dispatch('click');
  assert.equal(calls.filter(call=>call.method==='input').length,1);
  assert.equal(ui.get('connection-banner').hidden,true);
});

test('connection loss cancels active pointer and IME gestures without committing a candidate',async()=>{
  let broken=false;const calls=[];
  const ui=await harness(async request=>{
    calls.push(request);
    if(broken)throw new Error('Disconnected');
    return {...state(request.sessionId),serial:1,width:800,height:600,
      ...(request.method==='input'?{stateAfterInput:true}:{}),
      ...(request.method==='frame'?{surfaces:[{id:'main',main:true,x:0,y:0,width:800,height:600,png:''}]}:{})};
  });
  ui.attach('A');await ui.paint();
  const image={dataset:{surface:'main'},getBoundingClientRect:()=>({left:0,top:0})};
  await ui.get('surfaces').dispatch('pointerdown',{pointerId:1,button:0,buttons:1,clientX:10,clientY:10,target:{closest:()=>image}});
  await ui.get('input').dispatch('compositionstart');
  await ui.get('input').dispatch('compositionupdate',{data:'候选'});await flush();
  broken=true;await ui.paint();await flush();await flush();
  const inputs=calls.filter(call=>call.method==='input').map(call=>call.params);
  assert.equal(inputs.filter(input=>input.type==='pointercancel').length,1);
  assert.equal(inputs.filter(input=>input.type==='composition' && input.text==='').length,1);
  assert.equal(inputs.filter(input=>input.type==='commit').length,0);
  assert.equal(ui.get('surfaces').hasPointerCapture(1),false);
  assert.equal(ui.get('input').readOnly,true);
  await ui.get('input').dispatch('compositionend',{data:'候选'});
  assert.equal(calls.filter(call=>call.method==='input' && call.params.type==='commit').length,0);
  broken=false;await ui.get('retry').dispatch('click');await flush();await flush();
  const recovered=calls.filter(call=>call.method==='input').map(call=>call.params);
  assert.equal(recovered.filter(input=>input.type==='pointercancel').length,2,
    'A failed, idempotent cancellation is completed after reconnection');
  assert.equal(recovered.filter(input=>input.type==='composition' && input.text==='').length,2);
  assert.equal(recovered.filter(input=>input.type==='commit').length,0);
  assert.equal(ui.get('input').readOnly,false);
});

test('late errors from an old session cannot block a newly attached editor',async()=>{
  const gate=deferred();
  const ui=await harness(async request=>{
    if(request.sessionId==='A' && request.method==='frame'){await gate.promise;throw new Error('Old editor failed');}
    return state(request.sessionId);
  });
  ui.attach('A');await ui.paint();ui.attach('B');gate.resolve();await flush();
  assert.equal(ui.get('filename').textContent,'B.lyx');
  assert.equal(ui.get('connection-banner').hidden,true);
  assert.equal(ui.get('saved').textContent,'Connecting');
  await ui.paint();assert.equal(ui.get('saved').textContent,'Saved');
  assert.equal(ui.get('input').readOnly,false);
});

test('startup failures persist and Retry opens the file after the host becomes available',async()=>{
  let opens=0;
  const ui=await harness(async request=>state(request.sessionId),{open:async()=>{
    opens++;
    if(opens===1)throw new Error('Native engine is unavailable');
    return {_meta:{'lyx/native':{sessionId:'A',path:'/A.lyx'}}};
  }});
  ui.toolinput({file:'/A.lyx'});await flush();
  assert.equal(ui.get('connection-banner').hidden,false);
  assert.match(ui.get('connection-message').textContent,/Native engine is unavailable/);
  assert.equal(ui.get('saved').textContent,'Could not open editor');
  await ui.get('retry').dispatch('click');
  assert.equal(opens,2);assert.equal(ui.get('filename').textContent,'A.lyx');
  assert.equal(ui.get('connection-banner').hidden,true);
  await ui.paint();assert.equal(ui.get('saved').textContent,'Saved');
});

test('a failed host handshake can be retried before opening the requested file',async()=>{
  let connects=0,opens=0;
  const ui=await harness(async request=>state(request.sessionId),{
    connect:async()=>{if(++connects===1)throw new Error('Host handshake failed');},
    open:async()=>{opens++;return {_meta:{'lyx/native':{sessionId:'A',path:'/A.lyx'}}};},
  });
  ui.toolinput({file:'/A.lyx'});
  assert.equal(ui.get('connection-banner').hidden,false);
  await ui.get('retry').dispatch('click');
  assert.equal(connects,2);assert.equal(opens,1);
  assert.equal(ui.get('filename').textContent,'A.lyx');
});

for(const fail of [false,true])test(`a late startup ${fail?'failure':'result'} cannot replace a newer attachment`,async()=>{
  const gate=deferred();let opens=0;
  const ui=await harness(async request=>state(request.sessionId),{open:async()=>{
    opens++;await gate.promise;if(fail)throw new Error('Old open failed');
    return {_meta:{'lyx/native':{sessionId:'A',path:'/A.lyx'}}};
  }});
  ui.toolinput({file:'/A.lyx'});ui.toolinput({file:'/A.lyx'});
  assert.equal(opens,1,'Repeated requests share the pending open');
  ui.attach('B');await ui.paint();gate.resolve();await flush();
  assert.equal(ui.get('filename').textContent,'B.lyx');
  assert.equal(ui.get('saved').textContent,'Saved');
  assert.equal(ui.get('connection-banner').hidden,true);
});

test('duplicate attachment notifications retain the loaded editor and full selection title',async()=>{
  const selected='A long selected passage with enough characters to be abbreviated in the footer';
  const ui=await harness(async request=>({...state(request.sessionId),hasSelection:true,selection:selected,
    serial:1,width:800,height:600,surfaces:[{id:'main',main:true,x:0,y:0,width:800,height:600,png:''}]}));
  ui.attach('A');await ui.paint();
  const image=ui.get('surfaces').children[0];
  assert.equal(ui.get('selection').title,selected);
  assert.match(ui.get('selection').textContent,/…$/);
  ui.attach('A');
  assert.equal(ui.get('surfaces').children[0],image);
  assert.equal(ui.get('loading').hidden,true);
  assert.equal(ui.get('saved').textContent,'Saved');
  assert.equal(ui.get('add').disabled,false);
});

test('resizing a narrow panel refits unchanged native pixels and preserves pointer coordinates',async()=>{
  const calls=[];let frames=0;
  const ui=await harness(async request=>{
    calls.push(request);
    if(request.method!=='frame')return state(request.sessionId);
    return {...state(request.sessionId),serial:1,width:480,height:720,
      ...(++frames===1?{surfaces:[{id:'main',main:true,x:0,y:0,width:480,height:720,png:''}]}:{})};
  });
  let bounds={left:0,top:0,width:400,height:600};
  ui.get('viewport').getBoundingClientRect=()=>bounds;
  ui.attach('A');await ui.paint();
  const image=ui.get('surfaces').children[0];
  assert.equal(ui.get('surfaces').style.zoom,String(400/480));
  bounds={left:0,top:0,width:360,height:540};
  await ui.paint();
  assert.deepEqual(calls.filter(call=>call.method==='frame').map(call=>[call.params.width,call.params.height]),
    [[480,720],[480,720]],'Both panel sizes reuse the same native frame');
  assert.equal(ui.get('surfaces').children[0],image,'A resize should not discard decoded pixels');
  assert.equal(ui.get('surfaces').style.zoom,'0.75');
  image.getBoundingClientRect=()=>({left:10,top:20,width:360,height:540});
  await ui.get('surfaces').dispatch('dblclick',{target:{closest:()=>image},clientX:190,clientY:110,button:0,buttons:0});
  await flush();
  const input=calls.find(call=>call.method==='input');
  assert.equal(input.params.x,240);assert.equal(input.params.y,120);
});

test('a collapsed panel does not resize its native editor to minimum dimensions',async()=>{
  const calls=[];
  const ui=await harness(async request=>{calls.push(request);return state(request.sessionId);});
  ui.get('viewport').getBoundingClientRect=()=>({left:0,top:0,width:0,height:0});
  ui.attach('A');await ui.paint();
  assert.equal(calls.length,0);
  assert.equal(ui.get('connection-banner').hidden,true);
});

test('a startup recovery dialog remains interactive before the document is ready',async()=>{
  const calls=[];let choicePending=true;
  const ui=await harness(async request=>{
    calls.push(request);
    if(request.method==='input')choicePending=false;
    if(!choicePending)return {...state(request.sessionId),modified:true};
    return {...state(request.sessionId),ready:false,path:undefined,uiReady:true,
      interactionRequired:true,interactionTitle:'Load backup?',serial:1,width:800,height:600,
      surfaces:[{id:'recovery',main:false,x:120,y:160,width:500,height:240,png:''}]};
  });
  ui.attach('A');await ui.paint();
  assert.equal(ui.get('filename').textContent,'A.lyx');
  assert.equal(ui.get('saved').textContent,'Action required');
  assert.equal(ui.get('saved').title,'Load backup?');
  assert.equal(ui.get('save').disabled,true);assert.equal(ui.get('add').disabled,true);
  assert.equal(ui.get('connection-banner').hidden,true);
  assert.equal(ui.get('input').readOnly,false,'The dialog can receive native keyboard input');
  assert.equal(ui.get('surfaces').children.length,1,'The prompt is painted before a document exists');
  await ui.get('input').dispatch('keydown',{key:'Escape',code:'Escape',preventDefault(){}});
  await flush();
  assert.equal(calls.find(call=>call.method==='input').params.key,0x1000000);
  assert.equal(ui.get('saved').textContent,'Unsaved');
  assert.equal(ui.get('save').disabled,false);
});

test('a connected panel waits for file context without claiming that a native editor has started',async()=>{
  let opens=0;const calls=[];
  const ui=await harness(async request=>{calls.push(request);return state(request.sessionId);},{open:async()=>{
    opens++;return {_meta:{'lyx/native':{sessionId:'A',path:'/A.lyx'}}};
  }});
  assert.equal(ui.get('saved').textContent,'Waiting for file');
  assert.match(ui.get('loading').textContent,/Open a \.lyx file in this chat/);
  assert.equal(ui.get('connection').textContent,'Chat connected · Waiting for a file');
  assert.equal(ui.get('save').disabled,true);assert.equal(ui.get('input').readOnly,true);
  ui.result({content:[]});await flush();
  assert.equal(ui.get('connection-banner').hidden,true,'The file entrypoint has a legitimate empty result');
  assert.equal(opens,0);assert.equal(calls.length,0);
  ui.toolinput({file:{name:'A.lyx',resourceUri:'codex-resource://file/A'}});await flush();
  assert.equal(opens,1);await ui.paint();
  assert.equal(ui.get('filename').textContent,'A.lyx');
  assert.equal(ui.get('connection').textContent,'Connected to this chat');
});

for(const result of [
  {isError:true,content:[{type:'text',text:'Initial native open failed'}]},
  {_meta:{'lyx/native':{path:'/A.lyx'}}},
])test(`initial ${result.isError?'tool errors':'malformed descriptors'} show persistent feedback and accept delayed valid context`,async()=>{
  const ui=await harness(async request=>state(request.sessionId));
  ui.result(result);
  assert.equal(ui.get('connection-banner').hidden,false);
  assert.equal(ui.get('saved').textContent,'Could not open editor');
  assert.match(ui.get('connection-message').textContent,/Initial native open failed|did not return an editor session/);
  assert.equal(ui.get('reopen').hidden,true);
  ui.result({structuredContent:{sessionId:'A',path:'/A.lyx'}});await ui.paint();
  assert.equal(ui.get('connection-banner').hidden,true);assert.equal(ui.get('saved').textContent,'Saved');
  ui.result(result);
  assert.equal(ui.get('connection-banner').hidden,true,'A late startup error cannot block an attached editor');
});

test('a delayed file input recovers after an initial result error without replaying or guessing a path',async()=>{
  let opens=0;
  const ui=await harness(async request=>state(request.sessionId),{open:async()=>{
    opens++;return {_meta:{'lyx/native':{sessionId:'A',path:'/A.lyx'}}};
  }});
  ui.result({isError:true,content:[{type:'text',text:'Host file context was unavailable'}]});
  await ui.get('retry').dispatch('click');
  assert.equal(opens,0);assert.equal(ui.get('saved').textContent,'Waiting for file');
  ui.toolinput({file:{name:'A.lyx',resourceUri:'codex-resource://file/A'}});await flush();await ui.paint();
  assert.equal(opens,1);assert.equal(ui.get('saved').textContent,'Saved');
});

const exitReply=()=>({isError:true,content:[{type:'text',text:'Native LyX has exited'}],
  _meta:{'lyx/rpc':{error:true,message:'Native LyX has exited',code:'session_exited'}}});

test('verified exit preserves the last frame and offers one explicit reopen without changing historical chat context',async()=>{
  let exited=false,reopens=0;const gate=deferred(),calls=[];
  const ui=await harness(async request=>{
    calls.push(request);
    if(exited && request.sessionId==='A')return exitReply();
    return {...state(request.sessionId),hasSelection:request.sessionId==='A',selection:'Old passage',source:'Source',
      serial:1,width:800,height:600,surfaces:[{id:'main',main:true,x:0,y:0,width:800,height:600,png:''}]};
  },{reopen:async args=>{
    assert.equal(args.sessionId,'A');reopens++;await gate.promise;
    return {_meta:{'lyx/native':{sessionId:'B',path:'/B.lyx'}}};
  }});
  ui.attach('A');await ui.paint();await ui.get('add').dispatch('click');
  const image=ui.get('surfaces').children[0];
  assert.equal(ui.contexts.length,1);
  exited=true;await ui.paint();
  assert.equal(ui.get('surfaces').children[0],image);
  assert.equal(ui.get('reopen').hidden,false);assert.equal(ui.get('retry').hidden,true);
  assert.equal(ui.get('saved').textContent,'Editor stopped');
  assert.match(ui.get('connection-message').textContent,/load the backup, load the original, or cancel/);
  assert.equal(ui.get('add').dataset.contextAttached,undefined);
  const before=calls.length;
  await ui.get('retry').dispatch('click');await ui.commit('blocked');await ui.get('save').dispatch('click');
  await ui.get('add').dispatch('click');
  assert.equal(calls.length,before);assert.equal(reopens,0,'No automatic process replacement');
  const reopening=ui.get('reopen').dispatch('click');await ui.get('reopen').dispatch('click');
  assert.equal(reopens,1);assert.equal(ui.get('reopen').disabled,true);
  gate.resolve();await reopening;await ui.paint();
  assert.equal(ui.get('filename').textContent,'B.lyx');assert.equal(ui.get('connection-banner').hidden,true);
  assert.equal(ui.get('add').disabled,true);assert.equal(ui.get('add').dataset.contextAttached,undefined);
  assert.equal(ui.contexts.length,1,'Explicit historical context remains attached');assert.equal(ui.drafts.length,0);
  assert.match(ui.get('notice').textContent,/Previous chat selection is unchanged/);
  ui.attach('A');assert.equal(ui.get('filename').textContent,'B.lyx','A late old descriptor cannot revive an exited engine');
});

for(const code of ['timeout','session_not_found',undefined])
test(`ambiguous ${code??'untyped'} errors never expose process replacement, even when their text mentions session_exited`,async()=>{
  let broken=false,reopens=0;const calls=[];
  const ui=await harness(async request=>{
    calls.push(request);
    return broken?{isError:true,content:[{type:'text',text:'session_exited may have occurred'}],
      _meta:{'lyx/rpc':{error:true,message:'session_exited may have occurred',...(code?{code}:{})}}}:state(request.sessionId);
  },{reopen:async()=>{reopens++;assert.fail('Unknown outcomes must never replace a native engine');}});
  ui.attach('A');await ui.paint();broken=true;await ui.paint();
  assert.equal(ui.get('reopen').hidden,true);assert.equal(ui.get('retry').hidden,false);
  const before=calls.length;await ui.get('reopen').dispatch('click');assert.equal(reopens,0);
  await ui.get('retry').dispatch('click');
  assert.equal(calls.length,before+1);assert.equal(calls.at(-1).method,'frame');
});

test('confirmed exit is latched before the native input queue can send its next waiting edit',async()=>{
  const gate=deferred(),calls=[];
  const ui=await harness(async request=>{
    calls.push(request);
    if(request.sessionId==='A' && request.method==='input'){await gate.promise;return exitReply();}
    return state(request.sessionId);
  },{reopen:async()=>({_meta:{'lyx/native':{sessionId:'B',path:'/B.lyx'}}})});
  ui.attach('A');await ui.paint();
  const first=ui.commit('outcome uncertain'),second=ui.commit('waiting edit');
  gate.resolve();await first;await second;await flush();
  assert.deepEqual(calls.filter(call=>call.method==='input').map(call=>call.params.text),['outcome uncertain']);
  await ui.get('reopen').dispatch('click');await ui.paint();
  await ui.commit('new edit');await flush();
  assert.deepEqual(calls.filter(call=>call.method==='input').map(call=>[call.sessionId,call.params.text]),
    [['A','outcome uncertain'],['B','new edit']]);
});

for(const fail of [false,true])test(`a late reopen ${fail?'failure':'success'} cannot replace a newer attachment`,async()=>{
  const gate=deferred();
  const ui=await harness(async request=>request.sessionId==='A'?exitReply():state(request.sessionId),{
    reopen:async()=>{await gate.promise;if(fail)throw new Error('Old reopen failed');
      return {_meta:{'lyx/native':{sessionId:'B',path:'/B.lyx'}}};},
  });
  ui.attach('A');await ui.paint();const reopening=ui.get('reopen').dispatch('click');
  ui.attach('C');await ui.paint();gate.resolve();await reopening;
  assert.equal(ui.get('filename').textContent,'C.lyx');assert.equal(ui.get('saved').textContent,'Saved');
  assert.equal(ui.get('connection-banner').hidden,true);assert.equal(ui.get('notice').textContent,'');
});

test('reopen failure retains the stopped frame and allows another explicit attempt',async()=>{
  let reopens=0;
  const ui=await harness(async()=>exitReply(),{reopen:async()=>{
    reopens++;return {isError:true,content:[{type:'text',text:'No confirmed recovery path'}]};
  }});
  ui.attach('A');await ui.paint();await ui.get('reopen').dispatch('click');
  assert.equal(reopens,1);assert.equal(ui.get('reopen').hidden,false);assert.equal(ui.get('reopen').disabled,false);
  assert.equal(ui.get('saved').textContent,'Editor stopped');
  assert.match(ui.get('notice').textContent,/No confirmed recovery path/);
  await ui.get('reopen').dispatch('click');assert.equal(reopens,2);
});

test('standalone recovery uses only the authenticated existing broker reopen endpoint',async()=>{
  const requests=[];let exited=false;
  const ui=await harness(async()=>assert.fail('Standalone UI cannot use host RPC'),{
    standaloneDescriptor:{sessionId:'A',path:'/A.lyx',url:'http://127.0.0.1:12345',token:'test-secret'},
    fetch:async(url,options)=>{
      const body=JSON.parse(options.body);requests.push({url,options,body});
      assert.equal(options.headers.Authorization,'Bearer test-secret');
      if(url.endsWith('/reopen'))return {ok:true,json:async()=>({sessionId:'B',path:'/B.lyx',url:'http://127.0.0.1:12345',token:'test-secret'})};
      if(exited && body.sessionId==='A')return {ok:false,json:async()=>({error:'LyX exited',code:'session_exited'})};
      return {ok:true,json:async()=>state(body.sessionId)};
    },
  });
  await ui.paint();exited=true;await ui.paint();
  assert.equal(ui.get('reopen').hidden,false);
  await ui.get('reopen').dispatch('click');await ui.paint();
  const reopen=requests.filter(request=>request.url.endsWith('/reopen'));
  assert.equal(reopen.length,1);assert.deepEqual(reopen[0].body,{sessionId:'A'});
  assert.equal(ui.get('filename').textContent,'B.lyx');assert.equal(ui.get('connection-banner').hidden,true);
  assert.equal(ui.contexts.length,0);assert.equal(ui.drafts.length,0);
});

test('Retry waits for the current automatic frame probe without dispatching a duplicate',async()=>{
  const gate=deferred();let mode='healthy',frames=0;
  const ui=await harness(async request=>{
    if(request.method==='frame'){
      frames++;
      if(mode==='failed')throw new Error('Temporary timeout');
      if(mode==='pending')await gate.promise;
    }
    return state(request.sessionId);
  });
  ui.attach('A');await ui.paint();mode='failed';await ui.paint();
  mode='pending';await ui.paint();const before=frames;
  const retry=ui.get('retry').dispatch('click');await flush();
  assert.equal(frames,before);assert.equal(ui.get('retry').disabled,true);
  assert.equal(ui.get('retry').textContent,'Checking…');
  gate.resolve();await retry;
  assert.equal(ui.get('retry').disabled,false);assert.equal(ui.get('connection-banner').hidden,true);
});

test('a confirmed exit during optional clipboard prefetch still exposes recovery',async()=>{
  const ui=await harness(async request=>request.method==='clipboard'?exitReply():{
    ...state(request.sessionId),hasSelection:true,selection:'Passage',source:'Source',
  });
  ui.attach('A');await ui.paint();await flush();
  assert.equal(ui.get('reopen').hidden,false);assert.equal(ui.get('saved').textContent,'Editor stopped');
  assert.equal(ui.get('add').disabled,true);
});

test('a healthy frame already in flight cannot revive a session after its input reports verified exit',async()=>{
  const gate=deferred();let waitForFrame=false;
  const ui=await harness(async request=>{
    if(request.method==='input')return exitReply();
    if(request.method==='frame' && waitForFrame)await gate.promise;
    return state(request.sessionId);
  });
  ui.attach('A');await ui.paint();waitForFrame=true;await ui.paint();
  await ui.commit('exit during pending frame');gate.resolve();await flush();
  assert.equal(ui.get('reopen').hidden,false);assert.equal(ui.get('saved').textContent,'Editor stopped');
  assert.equal(ui.get('input').readOnly,true);
});
