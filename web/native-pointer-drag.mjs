// Keep pointer ownership separate from the native input queue. Callers wire DOM
// interruption events to cancel(); emitCancel should enqueue native input and
// handle any asynchronous transport error in that queue.
export function createNativePointerDrag({emitCancel,capture=()=>{},release=()=>{}}) {
  if(typeof emitCancel!=='function' || typeof capture!=='function' || typeof release!=='function')
    throw new TypeError('Pointer drag callbacks must be functions');
  let active;

  function matches({pointerId,token}={}) {
    return !!active && (pointerId===undefined || active.pointerId===pointerId)
      && (token===undefined || active.token===token);
  }

  function releaseOnce(drag) {
    // Capture may already be gone when lostpointercapture/blur reaches us.
    // Clearing ownership before this callback also makes reentrant loss safe.
    if(active?.pointerId===drag.pointerId && active.token!==drag.token)return;
    try{release(drag.pointerId);}catch{/* The native cancellation must still run. */}
  }

  function snapshot(pointerId,image,params,token) {
    return Object.freeze({pointerId,image,params:Object.freeze({...params}),token});
  }

  function start({pointerId,image,params}) {
    // Ignore duplicate downs as well as other fingers until ownership ends.
    if(active)return undefined;
    if(!Number.isInteger(pointerId) || !params || typeof params!=='object')
      throw new TypeError('A pointer id and native input parameters are required');
    const token=Symbol('native-pointer-drag');
    active=snapshot(pointerId,image,params,token);
    try{capture(pointerId);}
    catch(error){
      if(active?.token===token)active=undefined;
      throw error;
    }
    return active?.token===token?token:undefined;
  }

  function cancel(reason='cancel',{pointerId,token}={}) {
    if(!matches({pointerId,token}))return false;
    const previous=active;
    active=undefined;
    // Queue cancellation before releasing capture. A synchronous loss event
    // must neither enqueue it again nor cancel a later drag.
    try{
      emitCancel({...previous.params,type:'pointercancel',buttons:0},
        {reason,pointerId:previous.pointerId,token:previous.token});
    }finally{releaseOnce(previous);}
    return true;
  }

  function update(pointerId,params,{token}={}) {
    if(!matches({pointerId,token}))return false;
    active=snapshot(active.pointerId,active.image,params,active.token);
    if(params.type==='pointermove' && params.buttons===0){
      cancel('buttons-released',{pointerId,token:active.token});
      return false;
    }
    return true;
  }

  function end(pointerId,{token}={}) {
    if(!matches({pointerId,token}))return false;
    const previous=active;
    active=undefined;
    releaseOnce(previous);
    return true;
  }

  return {get active(){return active;},start,update,end,cancel};
}
