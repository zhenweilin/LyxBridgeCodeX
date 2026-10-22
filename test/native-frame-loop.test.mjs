import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeFrameLoop} from '../web/native-frame-loop.mjs';

function deferred() {
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
async function flush() {for(let i=0;i<5;i++) await Promise.resolve();}
function clock() {
  let time=0,serial=0;
  const timers=new Map();
  const now=()=>time;
  const setTimer=(fn,delay)=>{
    assert.ok(Number.isFinite(delay)&&delay>=0);
    const id=++serial;timers.set(id,{fn,at:time+delay});return id;
  };
  const clearTimer=id=>timers.delete(id);
  async function advance(ms) {
    const end=time+ms;
    let count=0;
    for (;;) {
      await flush();
      const next=[...timers].sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
      if (!next || next[1].at>end) break;
      assert.ok(++count<1000,'The loop must not create an immediate retry storm');
      const [id,task]=next;timers.delete(id);time=task.at;task.fn();
    }
    time=end;await flush();
  }
  return {now,setTimer,clearTimer,advance,timers};
}

test('start is idempotent and idle frames start every 250ms',async()=>{
  const time=clock(),starts=[];
  const loop=createNativeFrameLoop({...time,draw:()=>starts.push(time.now())});
  loop.start();loop.start();
  assert.equal(time.timers.size,1);
  await time.advance(500);
  assert.deepEqual(starts,[0,250,500]);
  loop.stop();assert.equal(time.timers.size,0);
});

test('request before start is safe and active cadence ends when the activity window expires',async()=>{
  const time=clock(),starts=[];
  const loop=createNativeFrameLoop({...time,draw:()=>starts.push(time.now()),activityWindow:100});
  loop.request();assert.equal(time.timers.size,0);
  loop.start();await time.advance(99);
  assert.deepEqual(starts,[0,33,66,99]);
  await time.advance(249);
  assert.deepEqual(starts,[0,33,66,99]);
  await time.advance(1);
  assert.deepEqual(starts,[0,33,66,99,349]);
  loop.stop();
});

test('interaction wakes an idle timer early without postponing the next active frame',async()=>{
  const time=clock(),starts=[];
  const loop=createNativeFrameLoop({...time,draw:()=>starts.push(time.now())});
  loop.start();await time.advance(100);
  assert.deepEqual(starts,[0]);
  loop.request();await time.advance(0);
  assert.deepEqual(starts,[0,100]);
  await time.advance(5);
  for(let i=0;i<20;i++)loop.request();
  assert.equal(time.timers.size,1,'Repeated input must not accumulate frame timers');
  await time.advance(28);
  assert.deepEqual(starts,[0,100,133]);
  loop.stop();
});

test('slow draws stay single-flight and request resumes promptly without catching up missed frames',async()=>{
  const time=clock(),starts=[],first=deferred(),second=deferred();
  let active=0;
  const loop=createNativeFrameLoop({...time,draw:async()=>{
    assert.equal(++active,1,'A frame must never overlap the previous draw');
    starts.push(time.now());
    await (starts.length===1?first.promise:starts.length===2?second.promise:Promise.resolve());
    active--;
  }});
  loop.request();loop.start();await time.advance(0);
  await time.advance(100);loop.request();loop.request();
  assert.deepEqual(starts,[0]);assert.equal(time.timers.size,0);
  first.resolve();await time.advance(0);
  assert.deepEqual(starts,[0,100]);
  await time.advance(10);loop.request();second.resolve();await flush();
  await time.advance(22);assert.deepEqual(starts,[0,100]);
  await time.advance(1);assert.deepEqual(starts,[0,100,133]);
  loop.stop();
});

test('stopping removes a waiting timer and prevents an in-flight completion from restarting',async()=>{
  const time=clock(),gate=deferred(),starts=[];
  const loop=createNativeFrameLoop({...time,draw:()=>{starts.push(time.now());return gate.promise;}});
  loop.start();await time.advance(0);loop.stop();
  gate.resolve();await time.advance(1000);
  assert.deepEqual(starts,[0]);assert.equal(time.timers.size,0);
  loop.request();assert.equal(time.timers.size,0,'Requests do not restart a stopped loop');
  loop.start();await time.advance(0);assert.deepEqual(starts,[0,1000]);
  assert.equal(time.timers.size,1);
  loop.stop();assert.equal(time.timers.size,0);
  await time.advance(1000);assert.deepEqual(starts,[0,1000]);
});

test('restarting while a stopped draw is still in flight preserves single-flight execution',async()=>{
  const time=clock(),gate=deferred(),starts=[];
  const loop=createNativeFrameLoop({...time,draw:()=>{starts.push(time.now());return gate.promise;}});
  loop.start();await time.advance(0);loop.stop();loop.request();loop.start();
  await time.advance(100);assert.deepEqual(starts,[0]);assert.equal(time.timers.size,0);
  gate.resolve();await time.advance(0);assert.deepEqual(starts,[0,100]);
  loop.stop();
});

test('hidden pages do not draw, and an external visibility request wakes them immediately',async()=>{
  const time=clock(),starts=[];let visible=false;
  const loop=createNativeFrameLoop({...time,isVisible:()=>visible,draw:()=>starts.push(time.now())});
  loop.start();loop.request();await time.advance(500);
  assert.deepEqual(starts,[]);assert.equal(time.timers.size,0);
  visible=true;loop.request();await time.advance(0);
  assert.deepEqual(starts,[500]);
  visible=false;loop.request();assert.equal(time.timers.size,0);
  await time.advance(1000);assert.deepEqual(starts,[500]);
  visible=true;loop.request();await time.advance(0);
  assert.deepEqual(starts,[500,1500]);
  loop.stop();
});

test('becoming hidden during a draw prevents follow-up work until visibility is requested',async()=>{
  const time=clock(),gate=deferred(),starts=[];let visible=true;
  const loop=createNativeFrameLoop({...time,isVisible:()=>visible,draw:()=>{starts.push(time.now());return gate.promise;}});
  loop.start();await time.advance(0);visible=false;gate.resolve();await time.advance(1000);
  assert.deepEqual(starts,[0]);assert.equal(time.timers.size,0);
  visible=true;loop.request();await time.advance(0);
  assert.deepEqual(starts,[0,1000]);loop.stop();
});

for (const asynchronous of [false,true]) {
  test(`draw failure is reported and backs off despite interaction (${asynchronous?'rejection':'throw'})`,async()=>{
    const time=clock(),starts=[],errors=[],error=new Error('frame unavailable');
    const loop=createNativeFrameLoop({...time,draw:()=>{
      starts.push(time.now());
      if(starts.length===1){if(asynchronous)return Promise.reject(error);throw error;}
    },onError:value=>errors.push(value)});
    loop.request();loop.start();await time.advance(25);loop.request();
    assert.deepEqual(starts,[0]);assert.deepEqual(errors,[error]);
    await time.advance(224);assert.deepEqual(starts,[0]);
    await time.advance(1);assert.deepEqual(starts,[0,250]);
    await time.advance(33);assert.deepEqual(starts,[0,250,283]);
    loop.stop();
  });
}

test('an asynchronous error reporter cannot create an unhandled rejection or tight retry',async()=>{
  const time=clock(),starts=[];
  const loop=createNativeFrameLoop({...time,draw:()=>{starts.push(time.now());throw new Error('draw');},
    onError:async()=>{throw new Error('reporter');}});
  loop.start();await time.advance(749);
  assert.deepEqual(starts,[0,250,500]);loop.stop();
});

test('custom intervals use draw start times rather than adding latency to each interval',async()=>{
  const time=clock(),starts=[],gate=deferred();
  const loop=createNativeFrameLoop({...time,activeInterval:10,idleInterval:80,activityWindow:25,
    draw:()=>{starts.push(time.now());if(starts.length===1)return gate.promise;}});
  loop.request();loop.start();await time.advance(7);gate.resolve();await time.advance(3);
  assert.deepEqual(starts,[0,10]);
  await time.advance(10);assert.deepEqual(starts,[0,10,20]);
  await time.advance(80);assert.deepEqual(starts,[0,10,20,100]);
  loop.stop();
});
