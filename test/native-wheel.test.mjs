import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {normalizeNativeWheel,nativeWheelQueueOptions,mergeNativeWheel} from '../web/native-wheel.mjs';
import {createNativeInputQueue} from '../web/native-input-queue.mjs';

const context={surface:'document',bounds:{left:10,top:20},scale:.5};
const event=(deltaY,extra={})=>({deltaMode:0,deltaX:0,deltaY,clientX:30,clientY:50,...extra});

test('pixel wheels preserve fractional native distance and scaled pointer position',()=>{
  const value=normalizeNativeWheel(event(.125,{deltaX:-.25}),context);
  assert.equal(value.dx,.5);assert.equal(value.dy,-.25);
  assert.equal(value.x,40);assert.equal(value.y,60);
  assert.equal(value.deltaMode,0);
});

test('line and page deltas keep their units without applying pixel scale',()=>{
  for(const deltaMode of [1,2]){
    const value=normalizeNativeWheel(event(-1.5,{deltaMode}),context);
    assert.equal(value.dy,1.5);assert.equal(value.deltaMode,deltaMode);
    assert.equal(value.x,40);
  }
});

test('Ctrl pixel-wheel produces scale-independent zoom intent, retaining physical modifiers',()=>{
  const small=normalizeNativeWheel(event(-20,{ctrlKey:true}),context);
  const full=normalizeNativeWheel(event(-20,{ctrlKey:true}),{...context,scale:1});
  assert.equal(small.zoomFactor,Math.exp(.2));assert.equal(small.zoomFactor,full.zoomFactor);
  assert.equal(small.ctrl,true);assert.equal(small.meta,false);
  for(const extra of [{ctrlKey:true,deltaMode:1},{ctrlKey:true,shiftKey:true},{metaKey:true},{ctrlKey:true,altKey:true}])
    assert.equal(normalizeNativeWheel(event(-20,extra),context).zoomFactor,undefined);
});

test('nonfinite and invalid events are rejected, while extreme finite values remain bounded',()=>{
  for(const extra of [{deltaY:NaN},{deltaX:Infinity},{clientX:NaN},{deltaMode:3}])
    assert.equal(normalizeNativeWheel(event(1,extra),context),undefined);
  assert.equal(normalizeNativeWheel(event(1),{...context,scale:0}),undefined);
  assert.equal(normalizeNativeWheel(event(0),context),undefined);
  const huge=normalizeNativeWheel(event(1e308,{deltaX:-1e308,ctrlKey:true}),{...context,scale:1e-308});
  for(const name of ['dx','dy','x','y','ax','ay','zoomFactor'])assert.ok(Number.isFinite(huge[name]),name);
  assert.equal(huge.dy,-1e6);assert.equal(huge.dx,1e6);
  assert.ok(huge.zoomFactor>0);
});

test('deltaMode is read before deltas, preserving browser unit selection',()=>{
  let readMode=false;
  const input={...event(1),get deltaMode(){readMode=true;return 1;},get deltaY(){assert.ok(readMode);return 3;}};
  assert.equal(normalizeNativeWheel(input,context).dy,-3);
});

test('the shipped handler suppresses unsupported old-engine zoom without turning it into scroll',async()=>{
  const source=await readFile('web/native-app.mjs','utf8');
  const start=source.indexOf("surfaces.addEventListener('wheel'"),end=source.indexOf('const keys=',start);
  assert.ok(start>=0 && end>start);
  let handler;const calls=[],notices=[];
  const environment={normalizeNativeWheel,nativeWheelQueueOptions,pointerDrag:{},nativeSurfaces:new Map(),scale:1,state:{capabilities:{}},
    surfaces:{addEventListener:(type,callback)=>{assert.equal(type,'wheel');handler=callback;}},
    queue:(...args)=>calls.push(args),notice:message=>notices.push(message)};
  runInNewContext(source.slice(start,end),environment);
  let prevented=0;
  const input={...event(-20,{ctrlKey:true}),target:{closest:()=>({dataset:{surface:'main'},getBoundingClientRect:()=>context.bounds})},
    preventDefault:()=>prevented++};
  handler(input);assert.equal(calls.length,0);assert.match(notices[0],/updated native LyX engine/);
  assert.equal(prevented,1);
  handler({...input,ctrlKey:false});assert.equal(calls.length,1,'Old engines still receive ordinary wheel input');
  environment.state={capabilities:{wheelInput:true}};handler(input);
  assert.equal(calls.length,2);assert.ok(calls[1][1].zoomFactor>1);
});

const main={main:true,scrollViewport:{x:0,y:100,width:800,height:500}};
const wheel=(dy=1,extra={})=>normalizeNativeWheel(event(dy,{clientX:200,clientY:200,...extra}),
  {surface:'main',bounds:{left:0,top:0}});

test('only ordinary document scrolling may coalesce, with direction and position barriers',()=>{
  const base=wheel();
  const key=value=>nativeWheelQueueOptions(value,main).coalesceKey;
  assert.ok(key(base));
  for(const other of [wheel(-1),wheel(1,{clientX:201}),wheel(1,{deltaMode:1}),{...base,surface:'other'}])
    assert.notEqual(key(other),key(base));
  for(const extra of [{ctrlKey:true},{shiftKey:true},{altKey:true},{metaKey:true},{deltaX:1},{deltaMode:2},{clientY:40}])
    assert.equal(key(wheel(1,extra)),undefined);
  for(const surface of [undefined,{main:true},{...main,main:false}])
    assert.equal(nativeWheelQueueOptions(base,surface).coalesceKey,undefined);
});

test('a blocked wheel burst retains fractional distance while reducing 120 waiting inputs to one',async()=>{
  const {enqueue}=createNativeInputQueue();let release;const gate=new Promise(resolve=>release=resolve),calls=[];
  const active=enqueue(()=>gate),tasks=[];
  for(let i=0;i<120;i++){
    const params=wheel(.125),{coalesceKey,mergeParams}=nativeWheelQueueOptions(params,main);
    tasks.push(enqueue(value=>{calls.push(value);return value.dy;},{coalesceKey,data:params,merge:mergeParams}));
  }
  release();await active;
  assert.deepEqual(await Promise.all(tasks),Array(120).fill(-15));
  assert.equal(calls.length,1);assert.equal(calls[0].dy,-15);
});

test('wheel direction reversals, typing and selection snapshots preserve ordered scroll boundaries',async()=>{
  const {enqueue}=createNativeInputQueue();let release;const gate=new Promise(resolve=>release=resolve),calls=[];
  const active=enqueue(()=>gate),tasks=[];
  const push=dy=>{const data=wheel(dy),{coalesceKey,mergeParams}=nativeWheelQueueOptions(data,main);
    tasks.push(enqueue(value=>calls.push(value.dy),{coalesceKey,data,merge:mergeParams}));};
  push(10);push(20);push(-5);push(-10);
  tasks.push(enqueue(()=>calls.push('selection snapshot')));
  push(-2);tasks.push(enqueue(()=>calls.push('typing')));push(-3);
  release();await Promise.all([active,...tasks]);
  assert.deepEqual(calls,[-30,15,'selection snapshot',2,'typing',3]);
});

test('wheel sums exceeding the native limit remain separate without losing distance',async()=>{
  const {enqueue}=createNativeInputQueue();let release;const gate=new Promise(resolve=>release=resolve),calls=[];
  const active=enqueue(()=>gate);
  const tasks=[600000,600000].map(dy=>{const data=wheel(dy),{coalesceKey}=nativeWheelQueueOptions(data,main);
    return enqueue(value=>calls.push(value.dy),{coalesceKey,data,merge:mergeNativeWheel});});
  release();await Promise.all([active,...tasks]);assert.deepEqual(calls,[-600000,-600000]);
});
