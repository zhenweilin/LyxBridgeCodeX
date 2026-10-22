// DOM wheel units are pixels, lines, or pages. Qt's integer pixel/angle deltas
// cannot represent fractional pixels or page units without losing information.
// Keep those units until the native widget supplies its own scroll metrics.
export function normalizeNativeWheel(event,{surface,bounds,scale=1}={}){
  const deltaMode=event.deltaMode??0;
  if(![0,1,2].includes(deltaMode) || !surface || !bounds
    || !Number.isFinite(scale) || scale<=0)return;
  const values=[event.deltaX,event.deltaY,event.clientX,event.clientY,bounds.left,bounds.top];
  if(!values.every(Number.isFinite))return;
  const bounded=value=>Math.max(-1e6,Math.min(1e6,value));
  const dx=bounded(-event.deltaX/(deltaMode===0?scale:1));
  const dy=bounded(-event.deltaY/(deltaMode===0?scale:1));
  if(!dx && !dy)return;
  // Browsers expose pinch as Ctrl+pixel-wheel; the DOM does not distinguish it
  // from a physical Ctrl+wheel. Treat both as browser zoom intent, not evidence
  // that a real operating-system pinch gesture has been verified.
  const zoom=deltaMode===0 && !!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  return {type:'wheel',surface,
    x:Math.round(bounded((event.clientX-bounds.left)/scale)),
    y:Math.round(bounded((event.clientY-bounds.top)/scale)),
    deltaMode,dx,dy,
    // Older running engines still understand these legacy angle fields.
    ax:Math.round(dx*3),ay:Math.round(dy*3),
    ...(zoom?{zoomFactor:Math.exp(Math.max(-4,Math.min(4,-event.deltaY*.01)))}:{}),
    shift:!!event.shiftKey,alt:!!event.altKey,ctrl:!!event.ctrlKey,meta:!!event.metaKey};
}

// Only merge ordinary vertical scrolling in the native document viewport.
// Menus, controls, zoom, direction changes and pointer movement stay separate:
// their intermediate events can change targets or hit a scroll/zoom limit.
export function nativeWheelQueueOptions(params,surface){
  const rect=surface?.scrollViewport;
  if(!surface?.main || !rect || params.dx!==0 || !params.dy
    || params.deltaMode!==0 || params.zoomFactor!==undefined
    || params.shift || params.alt || params.ctrl || params.meta
    || params.x<rect.x || params.y<rect.y
    || params.x>=rect.x+rect.width || params.y>=rect.y+rect.height)return {};
  return {coalesceKey:`wheel:${JSON.stringify([params.surface,params.x,params.y,params.deltaMode,Math.sign(params.dy)])}`,
    mergeParams:mergeNativeWheel};
}

export function mergeNativeWheel(previous,next){
  const dy=previous.dy+next.dy;
  if(!Number.isFinite(dy) || Math.abs(dy)>1e6)return;
  return {...next,dy,ay:Math.round(dy*3)};
}
