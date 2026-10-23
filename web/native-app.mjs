import {App} from '@modelcontextprotocol/ext-apps';
import {OpenAIExtensions} from '@openai/mcp-extensions/app';
import {writeBrowserClipboard,captureBrowserPaste,stageNativeImagePaste,externalLyxPasteParams} from './native-clipboard.mjs';
import {createNativeMenuClipboard} from './native-menu-clipboard.mjs';
import {addNativeSelectionToChat} from './native-chat.mjs';
import {createNativeInputQueue} from './native-input-queue.mjs';
import {createNativeFrameLoop} from './native-frame-loop.mjs';
import {createNativePointerDrag} from './native-pointer-drag.mjs';
import {nativeImePosition} from './native-ime-position.mjs';
import {createNativeIme} from './native-ime.mjs';
import {normalizeNativeWheel,nativeWheelQueueOptions} from './native-wheel.mjs';
import {nativeViewportSize,fitNativeViewport} from './native-viewport.mjs';
import {createNativeReview,addNativeCommentsToChat} from './native-review.mjs';
const $ = id => document.getElementById(id);
let descriptor, state, app, extensions, frameSerial = -1, pollPromise, composing = false, scale = 1, attachmentSerial=0;
let inputQueue = Promise.resolve(), noticeTimer;
let selectionClipboard,clipboardKey,clipboardRequest,editGeneration=0,pendingEdits=0,addingSelection=false;
let connectionPhase='connecting',retryStartup,retryBusy=false,reopenBusy=false;
let documentOpened=false;
const failedCancellations=new Map();
const exitedSessions=new Set();
const nativeSurfaces=new Map();
const nativeInputs=createNativeInputQueue();
const standalone = window.parent === window;
const rpcTimings=new Map();
function recordRpcTiming(method,elapsed,target){
  if(descriptor!==target)return;
  const samples=rpcTimings.get(method)??[];
  samples.push(elapsed);if(samples.length>60)samples.shift();rpcTimings.set(method,samples);
  // Bounded, content-free diagnostics for measuring the actual host relay.
  // Keep them out of the writing UI and never include document text or tokens.
  const summary={};
  for(const [name,values] of rpcTimings){
    const sorted=[...values].sort((a,b)=>a-b);
    summary[name]={samples:values.length,medianMs:+sorted[Math.floor(sorted.length/2)].toFixed(1),
      p95Ms:+sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))].toFixed(1)};
  }
  $('surfaces').dataset.rpcTimings=JSON.stringify(summary);
}
function notice(text) {$('notice').textContent = text;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>{$('notice').textContent='';},9000);}
function nativeError(value,fallback='Native LyX operation failed') {
  const error=new Error(typeof value?.message==='string'?value.message:typeof value?.error==='string'?value.error:fallback);
  if(typeof value?.code==='string' && /^[a-z_]{1,64}$/.test(value.code))error.code=value.code;
  error.confirmedExit=error.code==='session_exited';
  return error;
}
function toolError(result,fallback) {
  return nativeError(result?._meta?.['lyx/rpc'],result?.content?.find(item=>item.type==='text')?.text||fallback);
}
function resultDescriptor(result) {
  const value=result?._meta?.['lyx/native']??result?.structuredContent;
  return typeof value?.sessionId==='string' && value.sessionId.length>0
    && typeof value.path==='string' && value.path.length>0?value:undefined;
}
function sessionExited(target=descriptor){return !!target && exitedSessions.has(target.sessionId);}
function renderConnection() {
  const unavailable=connectionPhase==='error';
  const exited=sessionExited();
  $('connection-banner').hidden=!unavailable;
  $('retry').hidden=exited;
  $('retry').disabled=retryBusy;
  $('retry').textContent=retryBusy?'Checking…':'Retry';
  $('reopen').hidden=!exited;
  $('reopen').disabled=reopenBusy;
  $('reopen').textContent=reopenBusy?'Reopening…':'Reopen editor';
  $('input').readOnly=unavailable||!descriptor;
  $('surfaces').setAttribute('aria-disabled',String(unavailable||!descriptor));
  if(unavailable){
    $('saved').textContent=exited?'Editor stopped':descriptor?'Reconnecting…':'Could not open editor';
    $('save').disabled=$('add').disabled=true;
    $('save').title=$('add').title=exited?'Reopen the editor first':'Wait for the editor to reconnect';
  }
}
function connectionFailed(error,target=descriptor) {
  if(descriptor!==target)return;
  const firstFailure=connectionPhase!=='error';
  if(target && error.confirmedExit===true){
    exitedSessions.add(target.sessionId);frameLoop.stop();
    failedCancellations.clear();selectionClipboard=clipboardKey=undefined;
    nativeMenuClipboard?.invalidateGesture();
    $('selection').textContent='Reopen the editor before selecting content';
    $('selection').title=$('selection').textContent;
    for(const key of ['contextUpdateId','contextVerified','contextAttached'])delete $('add').dataset[key];
  }
  connectionPhase='error';
  const message=sessionExited(target)
    ? 'LyX has exited. Reopen the editor to continue. If a newer recovery snapshot is available, LyX will let you load the backup, load the original, or cancel.'
    : descriptor
    ? `Editing is paused while the connection recovers. ${error.message}`
    : `The editor could not open. ${error.message}`;
  // Automatic checks should not repeatedly announce an unchanged error.
  if($('connection-message').textContent!==message)$('connection-message').textContent=message;
  renderConnection();
  if(firstFailure){
    pendingHover=undefined;
    // End browser-owned gestures immediately. Cancellation is the sole input
    // permitted while disconnected: it cannot activate a menu or commit text.
    pointerDrag.cancel('connection');ime.cancel();
  }
}
async function rpc(method, params = {}, target=descriptor) {
  if (!target) throw new Error('Native LyX is not connected');
  if(sessionExited(target))throw nativeError({code:'session_exited',message:'This native LyX session has exited'});
  const started=performance.now();
  try{
  if(!standalone){
    const response=await app.callServerTool({name:'native_lyx_rpc',arguments:{sessionId:target.sessionId,method,params}});
    if(response.isError)throw toolError(response,'Native LyX operation failed');
    const result=response._meta?.['lyx/rpc'];
    if(!result)throw new Error('The host did not return native LyX state');
    if(result.error)throw nativeError(result);
    if(sessionExited(target))throw nativeError({code:'session_exited',message:'This native LyX session has exited'});
    if(method==='input' && params.replyWithState===true && descriptor===target)
      $('surfaces').dataset.inputStateCombined=String(result.stateAfterInput===true);
    return response._meta?.['lyx/ui']?{...result,uiCapabilities:response._meta['lyx/ui']}:result;
  }
  const response = await fetch(target.url + '/rpc', {method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${target.token}`},body:JSON.stringify({sessionId:target.sessionId,method,params})});
  const result = await response.json();
  if (!response.ok || result.error) throw nativeError(result,'LyX operation failed');
  if(sessionExited(target))throw nativeError({code:'session_exited',message:'This native LyX session has exited'});
  return result;
  }catch(error){
    // Latch before the input queue starts its next operation, rather than in
    // the caller's later rejection handler. Never send waiting edits to a
    // process whose exit has already been confirmed by a structured response.
    if(error.confirmedExit===true){
      exitedSessions.add(target.sessionId);
      // Optional operations such as clipboard prefetch may swallow errors.
      // A verified exit must still expose recovery and stop the polling loop.
      connectionFailed(error,target);
    }
    throw error;
  }finally{recordRpcTiming(method,performance.now()-started,target);}
}
let nativeMenuClipboard;
function updateInputPosition(next) {
  const metrics=next?.inputMethod;
  if(!metrics?.enabled)return;
  const surface=nativeSurfaces.get(metrics.surface);
  const image=$('surfaces').querySelector(`[data-surface="${metrics.surface}"]`);
  if(!image || !surface)return;
  const viewport=$('viewport');
  const position=nativeImePosition({inputMethod:metrics,surface,image:image.getBoundingClientRect(),
    viewport:viewport.getBoundingClientRect(),scrollLeft:viewport.scrollLeft,scrollTop:viewport.scrollTop});
  if(!position)return;
  Object.assign($('input').style,{left:`${position.left}px`,top:`${position.top}px`,
    height:`${position.height}px`,lineHeight:`${position.height}px`,fontSize:`${position.height*.8}px`});
}
function showState(next) {
  if (typeof next?.ready!=='boolean') return;
  if(sessionExited()){renderConnection();return;}
  const wasReady=state?.ready;
  state = next;
  review.update(next,`${attachmentSerial}:${next.path??''}`);
  nativeMenuClipboard.update(next);
  if(!next.ready){
    if(wasReady)nativeMenuClipboard.invalidateGesture();
    const needsDecision=next.interactionRequired===true;
    const openingPath=needsDecision&&!documentOpened?descriptor?.path:undefined;
    $('filename').textContent=openingPath?.split('/').at(-1)||(needsDecision?'LyX Editor':'No document open');
    $('filename').title=openingPath||'';
    $('saved').textContent=needsDecision?'Action required':'';
    $('saved').title=needsDecision?(next.interactionTitle||'Choose an option in the native dialog'):'';
    $('save').disabled=$('add').disabled=true;
    $('save').title=needsDecision?'Complete the native dialog before saving':'Open or create a document first';
    $('add').title=needsDecision?'Complete the native dialog before selecting content':'Open a document and select text or a formula';
    $('selection').textContent=needsDecision?'Choose an option in the LyX dialog to continue':'Open or create a document using the File menu';
    $('selection').title=$('selection').textContent;
    prepareClipboard(next);updateInputPosition(next);
    renderConnection();
    return;
  }
  documentOpened=true;
  $('filename').textContent=next.path.split('/').at(-1);
  $('filename').title=next.path;
  $('saved').textContent=next.externalModified?'File changed on disk':next.modified?'Unsaved':'Saved';
  $('saved').title=next.externalModified?'LyX detected an external change. Use the native reload or save conflict dialog to preserve your unsaved edits.':'';
  $('selection').textContent=next.hasSelection?`Selected: ${next.selection.slice(0,55)}${next.selection.length>55?'…':''}`:'Select text or a formula in LyX';
  $('selection').title=next.hasSelection?next.selection:$('selection').textContent;
  const composingNow=composing || next.inputMethod?.composing;
  $('save').disabled=!!composingNow;
  $('save').title=composingNow?'Finish composing text before saving':'';
  $('add').disabled=addingSelection || composingNow || !next.hasSelection || next.clipboardSelection?.kind==='widget' || !extensions?.modelContext;
  $('add').title=!extensions?.modelContext
    ? 'Open this .lyx file through the Codex plugin to connect to chat'
    : composingNow?'Finish composing text before adding to chat'
    : !next.hasSelection||next.clipboardSelection?.kind==='widget'?'Select text or a formula first':'Attach the selection as chat context';
  prepareClipboard(next);
  updateInputPosition(next);
  renderConnection();
}
function clipboardSelection(next){return next?.clipboardSelection??{kind:'document',hasSelection:next?.hasSelection,text:next?.selection,start:next?.selectionStart,end:next?.selectionEnd};}
function selectionKey(next){const selection=clipboardSelection(next);return selection.hasSelection?JSON.stringify([editGeneration,next.path,selection]):null;}
function prepareClipboard(next){
  if(composing || next?.inputMethod?.composing){clipboardKey=undefined;selectionClipboard=undefined;return;}
  const target=descriptor,menuClipboard=nativeMenuClipboard,key=selectionKey(next);
  if(key===clipboardKey)return;
  clipboardKey=key;selectionClipboard=undefined;
  if(!key || clipboardRequest)return;
  clipboardRequest=(async()=>{
    try{
      await inputQueue;
      if(descriptor!==target || selectionKey(state)!==key)return;
      const result=await rpc('clipboard',{action:'copy',expectedSelection:clipboardSelection(state),expectedPath:state.path},target);
      if(descriptor===target && selectionKey(state)===key){
        selectionClipboard=result.clipboard;
        menuClipboard.prepare(state,selectionClipboard);
      }
    }catch{/* Selection prefetch is optional; copy IDs handle an uncached gesture. */}
    finally{clipboardRequest=undefined;if(descriptor!==target || selectionKey(state)!==key){clipboardKey=undefined;prepareClipboard(state);}}
  })();
}
function menuPoint(params){
  return nativeSurfaces.get(params.surface)?.menuActions?.find(item=>!item.separator && item.enabled
    && params.x>=item.x && params.y>=item.y && params.x<item.x+item.width && params.y<item.y+item.height);
}
function queue(method, params, {menuReceipt,coalesceKey,prepareParams,mergeParams}={}) {
  const target=descriptor,menuClipboard=nativeMenuClipboard;
  const cancellation=method==='input' && (params.type==='pointercancel'
    || params.type==='composition' && params.text==='');
  if(!target || sessionExited(target) || connectionPhase==='error' && !cancellation)return Promise.resolve();
  frameLoop.request();
  const menuPointer=method==='input' && params.type.startsWith('pointer') && menuPoint(params);
  // Opening a menu preserves the document selection and the prepared MIME.
  // Keep that snapshot until the native action has matched the browser copy.
  const stableMenuPointer=menuPointer && (nativeSurfaces.get(params.surface)?.main
    || params.type!=='pointerup' || ['copy','cut'].includes(menuPointer.clipboardAction));
  if(!menuPointer && (method!=='input'||params.type!=='pointermove'||params.buttons))
    menuClipboard.invalidateGesture();
  const changesSelection=(method==='input' && !stableMenuPointer && (params.type!=='pointermove'||params.buttons)
    && !(params.type.startsWith('key') && [0x1000020,0x1000021,0x1000022,0x1000023].includes(params.key)))
    || method==='command'||method==='clipboard';
  if(changesSelection){
    pendingEdits++;
    editGeneration++;selectionClipboard=undefined;clipboardKey=undefined;
  }
  inputQueue=nativeInputs.enqueue(async queuedParams=>{
    // Reserve the operation's place before asynchronous paste preparation so
    // later typing cannot overtake it or change its originating document.
    const prepared=prepareParams?await prepareParams(queuedParams,{rpc:(operation,args)=>rpc(operation,args,target)}):queuedParams;
    const needsState=changesSelection || menuPointer && params.type!=='pointermove';
    const result=await rpc(method==='command'?'dispatch':method,
      method==='input' && needsState?{...prepared,replyWithState:true}:prepared,target);
    // Native input is posted to Qt's event loop. Its acknowledgement precedes
    // the edit; fetch the resulting selection before enabling copy or cut.
    // New MCP servers return that state in the input response. Older servers
    // and the standalone broker ignore the option and use the original path.
    const next=needsState && !(method==='input' && result.stateAfterInput===true)?await rpc('state',{},target):result;
    if(descriptor===target)showState(next);
    if(menuReceipt){
      pendingEdits++;editGeneration++;selectionClipboard=undefined;clipboardKey=undefined;
      try{
        if(await menuClipboard.update(next,{receipt:menuReceipt})){
          const committed=await rpc('state',{},target);
          if(descriptor===target)showState(committed);
        }
      }finally{pendingEdits--;}
    }
  },{coalesceKey:coalesceKey?`${attachmentSerial}:${coalesceKey}`:undefined,data:params,merge:mergeParams}).catch(error=>{
    if(descriptor===target){
      notice(error.message);
      // Tool error envelopes also carry broker timeouts and lost sessions.
      // Without proof that the mutation was rejected, never send it again.
      // Gesture cancellation alone is idempotent and safe to finish later.
      if(cancellation)failedCancellations.set(params.type,params);
      connectionFailed(error,target);
    }
  }).finally(()=>{
    if(changesSelection)pendingEdits--;
    review.refresh();
    // The input acknowledgement precedes Qt's edit; also wake after the state
    // barrier so the last drag position is painted when interaction stops.
    frameLoop.request();
  });
  return inputQueue;
}
function modifiers(e) {return{shift:e.shiftKey,alt:e.altKey,ctrl:e.ctrlKey,meta:e.metaKey};}
function poll() {
  if(pollPromise)return pollPromise;
  pollPromise=pollFrame().finally(()=>{pollPromise=undefined;});
  return pollPromise;
}
async function pollFrame() {
  if (!descriptor || sessionExited() || document.hidden) return;
  const sessionDescriptor=descriptor,generation=editGeneration,editsAtStart=pendingEdits;
  try {
    const viewport=$('viewport');
    // Use the space left by any genuine dialog overflow. Border-box dimensions
    // include scrollbar gutters and can cause a second, unnecessary scrollbar.
    const size={width:viewport.clientWidth,height:viewport.clientHeight};
    const nativeSize=nativeViewportSize(size);
    if(!nativeSize)return;
    const frame=await rpc('frame',{...nativeSize,serial:frameSerial},sessionDescriptor);
    if(descriptor!==sessionDescriptor || sessionExited(sessionDescriptor))return;
    if(typeof frame.ready!=='boolean')throw new Error('The editor returned an incomplete state');
    connectionPhase='connected';renderConnection();
    if(!standalone)$('connection').textContent=extensions?.modelContext?'Connected to this chat':'The host has not provided a chat context interface';
    if(!editsAtStart && !pendingEdits && generation===editGeneration)showState(frame);
    const cancellations=[...failedCancellations.values()];failedCancellations.clear();
    for(const params of cancellations)queue('input',params);
    // Different panel sizes can map to the same native dimensions. Refit even
    // when LyX reuses the pixels and omits surfaces from this response.
    const container=$('surfaces');
    if(frame.width>0 && frame.height>0)
      scale=fitNativeViewport(container,frame,size.width);
    if (frame.surfaces) {
      frameSerial=frame.serial;
      nativeSurfaces.clear();
      for(const surface of frame.surfaces)nativeSurfaces.set(surface.id,surface);
      const active=new Set();
      for (const surface of frame.surfaces) {
        active.add(surface.id);
        let image=container.querySelector(`[data-surface="${surface.id}"]`);
        if (!image) {image=new Image();image.draggable=false;image.dataset.surface=surface.id;image.alt=surface.main?'LyX document editor':'LyX dialog';container.append(image);}
        image.src=`data:image/png;base64,${surface.png}`;
        Object.assign(image.style,{left:`${surface.x}px`,top:`${surface.y}px`,width:`${surface.width}px`,height:`${surface.height}px`,zIndex:surface.main?'0':'1'});
      }
      for(const image of container.children)if(!active.has(image.dataset.surface))image.remove();
      $('loading').hidden=true;
    }
    updateInputPosition(state);
  } catch(error) {
    if(descriptor!==sessionDescriptor)return;
    connectionFailed(error,sessionDescriptor);throw error;
  }
}
// Request the next active frame promptly. The loop still allows only one
// frame in flight, so a slower host/encoder cannot build a frame backlog.
const frameLoop=createNativeFrameLoop({draw:poll,isVisible:()=>!document.hidden,activeInterval:16});
function reviewTask(work,{observational=false}={}){
  const target=descriptor,path=state?.path;
  if(!target || connectionPhase==='error' || sessionExited(target))return Promise.reject(new Error('Open a native document first.'));
  if(!observational){pendingEdits++;editGeneration++;selectionClipboard=undefined;clipboardKey=undefined;}
  const task=nativeInputs.enqueue(async()=>{
    const next=await rpc('selection',{},target);
    if(next.path!==path)throw new Error('The active document changed. Refresh review first.');
    const result=await work(next,target);
    if(!observational && descriptor===target && result?.ready)showState(result);
    return result;
  });
  // The sidebar renders its own read result. A passive query must not evict
  // the selection clipboard or turn the idle frame loop into an activity burst.
  inputQueue=task.catch(()=>{}).finally(()=>{if(!observational){pendingEdits--;frameLoop.request();}});
  return task;
}
const review=createNativeReview({
  read:()=>reviewTask(next=>next,{observational:true}),
  run:(operation,params={},expected)=>{
    // An add-comment draft retains the original revision and selection. For
    // review controls capture the visible selection before entering the queue.
    const origin=expected??{path:state?.path,clipboardSelection:clipboardSelection(state)};
    return reviewTask((next,target)=>{
      if(origin.path!==next.path)throw new Error('The active document changed. Refresh review first.');
      return rpc('clipboard',{action:'review',operation,...params,path:origin.path,
        sourceRevision:expected?.sourceRevision??next.sourceRevision,selection:origin.clipboardSelection},target);
    });
  },
  attach:ids=>reviewTask((next,target)=>addNativeCommentsToChat(next,ids,extensions,{sessionId:target.sessionId})),
  available:()=>!!extensions?.modelContext,
  changed:()=>frameLoop.request(),focus:()=>$('input').focus({preventScroll:true}),notice,
});
// Model edits can arrive independently of the browser's input queue.
const reviewTimer=setInterval(()=>{if(connectionPhase==='connected' && !document.hidden && !pendingEdits && !composing && !state?.inputMethod?.composing)review.refresh();},2000);
reviewTimer?.unref?.();
document.addEventListener('visibilitychange',()=>{
  if(document.hidden){pointerDrag.cancel('hidden');ime.cancel();}else frameLoop.request();
});
window.addEventListener('resize',()=>frameLoop.request());
window.addEventListener('blur',()=>{pointerDrag.cancel('blur');ime.cancel();});
window.addEventListener('pagehide',()=>{pointerDrag.cancel('pagehide');ime.cancel();frameLoop.stop();});
window.addEventListener('pageshow',()=>{if(descriptor&&!sessionExited()){frameLoop.start();frameLoop.request();}});
function attach(value) {
  if (!value?.sessionId || sessionExited(value))return;
  if(descriptor?.sessionId===value.sessionId && descriptor.url===value.url && descriptor.token===value.token){
    // Repeated host notifications describe the same live editor. Preserve its
    // selection, focus and decoded images instead of flashing a loading view.
    frameLoop.request();return;
  }
  // Finish already queued input in its original engine. Clear live gestures
  // before changing the descriptor so their cancellation also goes there.
  pointerDrag.cancel('attachment');ime.cancel();pendingHover=undefined;
  nativeMenuClipboard?.destroy();
  descriptor={...value};attachmentSerial++;state=undefined;frameSerial=-1;
  review.update({ready:false},`${attachmentSerial}:`);
  documentOpened=false;
  connectionPhase='connecting';retryBusy=false;reopenBusy=false;renderConnection();
  failedCancellations.clear();
  rpcTimings.clear();
  delete $('surfaces').dataset.rpcTimings;delete $('surfaces').dataset.inputStateCombined;
  const target=descriptor;
  nativeMenuClipboard=createNativeMenuClipboard({
    rpc:(method,params)=>rpc(method,params,target),
    notice:text=>{if(descriptor===target)notice(text);},
  });
  selectionClipboard=clipboardKey=undefined;
  nativeSurfaces.clear();$('surfaces').replaceChildren();
  $('filename').textContent=value.path?.split('/').at(-1)||'LyX Editor';
  $('filename').title=value.path||'';
  $('saved').textContent='Connecting';$('saved').title='';
  if(!standalone)$('connection').textContent='Chat connected · Connecting to editor';
  $('selection').textContent='Select text or a formula in LyX';
  $('selection').title=$('selection').textContent;
  $('notice').textContent='';
  for(const key of ['contextUpdateId','contextVerified','contextAttached'])delete $('add').dataset[key];
  $('save').disabled=$('add').disabled=true;$('loading').hidden=false;
  $('loading').textContent='Connecting to the native LyX session…';
  frameLoop.start();frameLoop.request();
}
const surfaces=$('surfaces');
const pointerDrag=createNativePointerDrag({
  capture:pointerId=>surfaces.setPointerCapture(pointerId),
  release:pointerId=>{if(surfaces.hasPointerCapture(pointerId))surfaces.releasePointerCapture(pointerId);},
  emitCancel:params=>{
    pendingHover=undefined;
    nativeMenuClipboard?.invalidateGesture();
    // Older running engines do not know cancellation yet. Never emulate it
    // with a mouseup, which could activate a menu or document inset.
    if(state?.capabilities?.pointerCancel)queue('input',params);
  },
});
let pendingHover,hoverScheduled=false;
function scheduleHover(params){
  pendingHover=params;
  if(hoverScheduled)return;
  hoverScheduled=true;
  setTimeout(async()=>{
    const current=pendingHover;pendingHover=undefined;
    if(!pointerDrag.active && current)await queue('input',current);
    hoverScheduled=false;
    if(pendingHover)scheduleHover(pendingHover);
  },32);
}
for (const type of ['pointerdown','pointermove','pointerup']) surfaces.addEventListener(type,event=>{
  if(connectionPhase==='error'){event.preventDefault();return;}
  const dragging=pointerDrag.active;
  if(dragging && (dragging.pointerId!==event.pointerId || type==='pointerdown'))return;
  if(!dragging && type==='pointerup')return;
  let image=dragging?.image || event.target.closest('img[data-surface]');
  if(!image)return;
  const bounds=image.getBoundingClientRect();
  const params={type,surface:image.dataset.surface,x:Math.round((event.clientX-bounds.left)/scale),y:Math.round((event.clientY-bounds.top)/scale),button:event.button,buttons:event.buttons,...modifiers(event)};
  if(type==='pointermove'&&!dragging){if(!params.buttons)scheduleHover(params);return;}
  event.preventDefault();
  if(type==='pointerdown'){
    pendingHover=undefined;
    if(pendingEdits)nativeMenuClipboard.invalidateGesture();
    try{if(!pointerDrag.start({image,pointerId:event.pointerId,params}))return;}
    catch(error){notice(error.message);return;}
    $('input').style.left=`${Math.max(0,event.clientX-$('viewport').getBoundingClientRect().left)}px`;
    $('input').style.top=`${Math.max(0,event.clientY-$('viewport').getBoundingClientRect().top)}px`;
    $('input').focus({preventScroll:true});
  }else if(!pointerDrag.update(event.pointerId,params))return;
  const menuReceipt=nativeMenuClipboard.handlePointer({...params,pointerId:event.pointerId},
    {surface:nativeSurfaces.get(params.surface),state,clipboard:selectionClipboard});
  // Only a waiting document drag can be replaced. Every down/up, menu event,
  // key, modifier or surface change remains an ordering barrier.
  const coalesceKey=type==='pointermove' && dragging?.pointerId===event.pointerId
    && params.buttons===1 && nativeSurfaces.get(params.surface)?.main && !menuPoint(params)
    ? JSON.stringify([event.pointerId,params.surface,params.buttons,params.shift,params.alt,params.ctrl,params.meta])
    : undefined;
  queue('input',params,{menuReceipt,coalesceKey});
  if(type==='pointerup')pointerDrag.end(event.pointerId);
});
for(const type of ['pointercancel','lostpointercapture'])surfaces.addEventListener(type,event=>{
  pointerDrag.cancel(type,{pointerId:event.pointerId});
});
surfaces.addEventListener('dblclick',event=>{
  if(connectionPhase==='error'){event.preventDefault();return;}
  const image=event.target.closest('img[data-surface]');if(!image)return;
  const r=image.getBoundingClientRect();
  queue('input',{type:'dblclick',surface:image.dataset.surface,x:Math.round((event.clientX-r.left)/scale),y:Math.round((event.clientY-r.top)/scale),button:event.button,buttons:event.buttons,...modifiers(event)});
});
surfaces.addEventListener('contextmenu',event=>event.preventDefault());
surfaces.addEventListener('wheel',event=>{
  if(connectionPhase==='error'){event.preventDefault();return;}
  const image=event.target.closest('img[data-surface]');if(!image)return;
  const params=normalizeNativeWheel(event,{surface:image.dataset.surface,bounds:image.getBoundingClientRect(),scale});
  if(!params)return;
  if(params.zoomFactor!==undefined && state?.capabilities?.wheelInput!==true){
    event.preventDefault();notice('Zoom gestures require an updated native LyX engine. Use the native zoom controls in this session.');return;
  }
  const options=!pointerDrag.active && nativeSurfaces.size===1
    ? nativeWheelQueueOptions(params,nativeSurfaces.get(params.surface)) : {};
  event.preventDefault();queue('input',params,options);
},{passive:false});
const keys={Escape:0x1000000,Tab:0x1000001,Backspace:0x1000003,Enter:0x1000004,Insert:0x1000006,Delete:0x1000007,Home:0x1000010,End:0x1000011,ArrowLeft:0x1000012,ArrowUp:0x1000013,ArrowRight:0x1000014,ArrowDown:0x1000015,PageUp:0x1000016,PageDown:0x1000017,Shift:0x1000020,Control:0x1000021,Meta:0x1000022,Alt:0x1000023};
for(let i=1;i<=35;i++)keys[`F${i}`]=0x100002f+i;
const ime=createNativeIme({
  emit:params=>queue('input',params),
  clear:()=>{$('input').value='';},
  onCompositionChange:value=>{composing=value;if(state)showState(state);},
});
for(const type of ['keydown','keyup'])$('input').addEventListener(type,event=>{
  if(connectionPhase==='error'){event.preventDefault();return;}
  if(ime.key(event)!=='native')return;
  const key=event.key==='Tab' && event.shiftKey?0x1000002
    : keys[event.key] ?? (Array.from(event.key).length===1?event.key.toUpperCase().codePointAt(0):0);
  if(!key)return;
  event.preventDefault();
  queue('input',{type,key,text:Array.from(event.key).length===1?event.key:'',repeat:event.repeat,...modifiers(event)});
});
for(const type of ['compositionstart','compositionupdate','compositionend','beforeinput','input'])
  $('input').addEventListener(type,event=>{
    if(connectionPhase==='error'){if(event.cancelable!==false)event.preventDefault();$('input').value='';return;}
    ime[type](event);
  });
$('input').addEventListener('blur',()=>ime.cancel());
$('input').addEventListener('paste',event=>{
  event.preventDefault();
  if(connectionPhase==='error')return;
  try{
    const {payload,prepare}=captureBrowserPaste(event.clipboardData);
    if(prepare)queue('clipboard',{action:'paste',...payload},{prepareParams:async(params,{rpc})=>{
      // This snapshot follows earlier queued input and stays bound to the
      // original session even if a different document attaches during reading.
      const before=await rpc('selection');
      if(before.capabilities?.imagePaste!==true)
        throw new Error('This editor does not support image paste yet. Save your document, then close and reopen the editor to start the updated version.');
      const prepared={...params,...await prepare(),expectedPath:before.path,
        expectedSelection:clipboardSelection(before),expectedSourceRevision:before.sourceRevision};
      return before.capabilities.imagePasteChunks===true?stageNativeImagePaste(prepared,rpc):prepared;
    }});
    else if(payload.copyId||Object.keys(payload.formats??{}).length)
      queue('clipboard',{action:'paste',...externalLyxPasteParams(payload,state?.uiCapabilities)});
  }catch(error){notice(error.message);}
});
for(const type of ['copy','cut'])$('input').addEventListener(type,event=>{
  // A browser clipboard event must finish synchronously. Never export an old
  // snapshot and later cut a newer selection from the native input queue.
  event.preventDefault();
  if(connectionPhase==='error')return;
  if(pendingEdits){notice('The selection is still updating. Try copying or cutting again in a moment.');return;}
  const selection=clipboardSelection(state);
  if(!selection.hasSelection)return;
  const copyId=crypto.randomUUID();
  writeBrowserClipboard(event.clipboardData,{text:selection.text,copyId,clipboard:selectionClipboard});
  queue('clipboard',{action:type,copyId,expectedSelection:selection,expectedPath:state.path});
});
for(const id of ['save','add'])$(id).addEventListener('pointerdown',event=>event.preventDefault());
$('save').addEventListener('click',()=>queue('command',{command:'buffer-write'}));
$('add').addEventListener('click',async()=>{
  if(addingSelection || !descriptor || connectionPhase==='error')return;
  const target=descriptor;
  addingSelection=true;$('add').disabled=true;
  for(const key of ['contextUpdateId','contextVerified','contextAttached'])delete $('add').dataset[key];
  try{
    // Capture at this click's position in the input queue. Waiting on its last
    // promise alone lets a newer edit run before this continuation resumes.
    const selection=await nativeInputs.enqueue(()=>rpc('selection',{captureEdit:true},target));
    const accepted=await addNativeSelectionToChat(selection,extensions,{sessionId:target.sessionId});
    if(descriptor!==target || sessionExited(target))return;
    $('add').dataset.contextUpdateId=accepted.updateId;
    $('add').dataset.contextVerified=String(accepted.contextVerified);
    $('add').dataset.contextAttached=String(accepted.contextAttached);
    notice(accepted.snapshotAttached?'Selection attached. You can move the cursor while discussing this passage.':'Selection attached as chat context. Your draft is unchanged.');
  }catch(error){if(descriptor===target)notice(error.message);}
  finally{addingSelection=false;if(state)showState(state);}
});
$('retry').addEventListener('click',async()=>{
  if(retryBusy || sessionExited())return;
  const target=descriptor;
  retryBusy=true;renderConnection();
  try{
    // A lost connection must never restart an engine or replay an edit whose
    // outcome is unknown. Existing sessions recover through read-only frames.
    if(target){frameLoop.request();await poll();}
    else await retryStartup?.({retry:true});
  }catch(error){connectionFailed(error,target);}
  finally{if(descriptor===target){retryBusy=false;renderConnection();}}
});
$('reopen').addEventListener('click',async()=>{
  const target=descriptor;
  if(reopenBusy || !sessionExited(target))return;
  reopenBusy=true;renderConnection();
  try{
    let value;
    if(standalone){
      const response=await fetch(target.url+'/reopen',{method:'POST',
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${target.token}`},
        body:JSON.stringify({sessionId:target.sessionId})});
      const result=await response.json();
      if(!response.ok || result.error)throw nativeError(result,'Could not reopen the editor');
      value=result;
    }else{
      const result=await app.callServerTool({name:'reopen_native_lyx',arguments:{sessionId:target.sessionId}});
      if(result.isError)throw toolError(result,'Could not reopen the editor');
      value=resultDescriptor(result);
    }
    if(descriptor!==target)return;
    if(!value?.sessionId || value.sessionId===target.sessionId || sessionExited(value) || !value.path)
      throw new Error('The host did not return a new editor session');
    attach(value);
    if(!standalone)notice('Previous chat selection is unchanged. Select content again to update it.');
  }catch(error){
    if(descriptor===target)notice(`Could not reopen the editor. ${error.message}`);
  }finally{if(descriptor===target){reopenBusy=false;renderConnection();}}
});
if(standalone){
  $('connection').textContent='Browser debug view · Not connected to chat. Open the .lyx file in Codex.';
  $('add').title='This debug view supports editing. Open the file in Codex to add to chat.';
  if(window.__LYX_NATIVE__)attach(window.__LYX_NATIVE__);
  else notice('Open a .lyx file through the plugin, or start the native editor with a test file.');
}else{
  // This editor fills the host viewport. The SDK's content-height observer
  // temporarily measures html at max-content, including the native frame;
  // feeding that height back to the host can repeatedly resize its scrollbar.
  app=new App({name:'LyX Native Editor',version:'0.3.0'},{},{autoResize:false});
  extensions=new OpenAIExtensions(app);
  let connected=false,needsFileOpen=false,opening;
  function waitingForFile(){
    if(!connected || descriptor || opening || connectionPhase==='error')return;
    $('saved').textContent='Waiting for file';
    $('loading').textContent='Waiting for a file from Codex. Open a .lyx file in this chat, or ask Codex to open your document.';
    $('connection').textContent='Chat connected · Waiting for a file';
    $('save').disabled=$('add').disabled=true;
    renderConnection();
  }
  async function openFile(){
    if(opening)return opening;
    const serial=attachmentSerial;
    if(!descriptor){
      connectionPhase='connecting';renderConnection();
      $('saved').textContent='Opening';$('loading').textContent='Starting native LyX…';
    }
    opening=(async()=>{try{
      const result=await app.callServerTool({name:'start_native_lyx',arguments:{}});
      if(attachmentSerial!==serial)return;
      if(result.isError)throw toolError(result,'Could not open the file');
      const value=resultDescriptor(result);
      if(!value)throw new Error('The host did not return an editor session. Reopen the .lyx file in Codex.');
      attach(value);
    }catch(error){if(attachmentSerial===serial){
      if(descriptor)notice(`Could not open the requested file. ${error.message}`);
      else connectionFailed(error);
    }}
    finally{opening=undefined;}})();
    return opening;
  }
  app.addEventListener('toolinput',({arguments:args})=>{if(args?.file){needsFileOpen=true;if(connected)openFile();}});
  app.ontoolresult=result=>{
    const value=resultDescriptor(result);
    if(!result?.isError && value){attach(value);return;}
    // Delayed failures from an earlier request cannot replace a live editor.
    if(descriptor)return;
    if(result?.isError){connectionFailed(toolError(result,'The file could not open. Reopen it in Codex.'));return;}
    // The file entrypoint deliberately returns empty content; its file context
    // arrives separately via toolinput. It is not a malformed open result.
    if(result?._meta?.['lyx/native']!==undefined || result?.structuredContent!==undefined || result?.content?.length){
      connectionFailed(new Error('The host did not return an editor session. Reopen the .lyx file in Codex.'));return;
    }
    waitingForFile();
  };
  retryStartup=async({retry=false}={})=>{
    try {
      if(!connected){await app.connect();connected=true;}
      $('connection').textContent=extensions.modelContext?'Connected to this chat':'The host has not provided a chat context interface';
      if(needsFileOpen&&!descriptor)await openFile();
      else{
        if(retry&&!descriptor)connectionPhase='connecting';
        waitingForFile();
      }
    } catch(error) {
      $('connection').textContent='The plugin could not connect to this chat';
      $('loading').textContent='Use Retry to reconnect. If the plugin was just installed or updated, reopen the file after restarting Codex.';
      connectionFailed(error);
    }
  };
  await retryStartup();
}
