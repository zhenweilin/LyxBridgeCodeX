import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativePointerDrag} from '../web/native-pointer-drag.mjs';

const down={type:'pointerdown',surface:'main',x:20,y:30,button:0,buttons:1,shift:false};
function fixture(overrides={}) {
  const calls=[],image={name:'native image'};
  const drag=createNativePointerDrag({
    emitCancel:(params,meta)=>calls.push({kind:'cancel',params,meta}),
    capture:pointerId=>calls.push({kind:'capture',pointerId}),
    release:pointerId=>calls.push({kind:'release',pointerId}),
    ...overrides,
  });
  const start=(pointerId=1,params=down)=>drag.start({pointerId,image,params});
  return {drag,calls,image,start};
}

test('a drag owns one pointer, remembers immutable latest coordinates, and ends once',()=>{
  const {drag,calls,image,start}=fixture();
  const params={...down};
  const token=start(1,params);
  assert.equal(drag.active.token,token);
  assert.equal(drag.active.image,image);
  params.x=999;
  assert.equal(drag.active.params.x,20);
  const move={...down,type:'pointermove',x:120,y:140};
  assert.equal(drag.update(1,move),true);
  move.x=999;
  assert.equal(drag.active.params.x,120);
  assert.equal(drag.active.token,token);
  assert.equal(Object.isFrozen(drag.active),true);
  assert.equal(Object.isFrozen(drag.active.params),true);
  assert.equal(drag.update(1,{...down,type:'pointerup',buttons:0}),true,'A normal up is not an interruption');
  assert.equal(drag.end(1),true);
  assert.equal(drag.end(1),false);
  assert.equal(drag.cancel('lostpointercapture',{pointerId:1}),false);
  assert.equal(drag.active,undefined);
  assert.deepEqual(calls,[{kind:'capture',pointerId:1},{kind:'release',pointerId:1}]);
});

test('duplicate downs and other pointer ids cannot change or release the owned drag',()=>{
  const {drag,calls,start}=fixture();
  const token=start(1),before=drag.active;
  assert.equal(start(1),undefined);
  assert.equal(start(2),undefined);
  assert.equal(drag.update(2,{...down,type:'pointermove',buttons:0,x:600}),false);
  assert.equal(drag.end(2),false);
  assert.equal(drag.cancel('pointercancel',{pointerId:2}),false);
  assert.strictEqual(drag.active,before);
  assert.equal(drag.active.token,token);
  assert.deepEqual(calls,[{kind:'capture',pointerId:1}]);
});

for(const reason of ['pointercancel','lostpointercapture','blur','pagehide','hidden'])
  test(`${reason} sends exactly one safe native cancellation with the latest coordinates`,()=>{
    const {drag,calls,start}=fixture();
    const token=start(7);
    const params={...down,type:'pointermove',x:320,y:440,shift:true};
    drag.update(7,params);
    const identity=reason==='pointercancel' || reason==='lostpointercapture'?{pointerId:7}:{};
    assert.equal(drag.cancel(reason,identity),true);
    assert.equal(drag.cancel(reason,identity),false);
    assert.equal(drag.end(7),false);
    assert.equal(drag.active,undefined);
    assert.deepEqual(calls,[
      {kind:'capture',pointerId:7},
      {kind:'cancel',params:{...params,type:'pointercancel',buttons:0},meta:{reason,pointerId:7,token}},
      {kind:'release',pointerId:7},
    ]);
    assert.ok(!calls.some(call=>call.params?.type==='pointerup'),'Cancellation must not activate a menu by synthesizing release');
  });

test('a move with no buttons cancels a lost mouse release and must not be forwarded',()=>{
  const {drag,calls,start}=fixture();
  start();
  assert.equal(drag.update(1,{...down,type:'pointermove',x:320,buttons:0}),false);
  assert.equal(drag.active,undefined);
  const cancellations=calls.filter(call=>call.kind==='cancel');
  assert.equal(cancellations.length,1);
  assert.equal(cancellations[0].params.x,320);
  assert.equal(cancellations[0].meta.reason,'buttons-released');
  assert.equal(drag.update(1,{...down,type:'pointermove',buttons:0}),false);
  assert.equal(calls.filter(call=>call.kind==='release').length,1);
});

test('an old token cannot cancel, update, or end a new drag even when its pointer id is reused',()=>{
  const {drag,calls,start}=fixture();
  const old=start(1);
  drag.cancel('blur',{token:old});
  const current=start(1);
  assert.notEqual(current,old);
  const before=drag.active;
  assert.equal(drag.cancel('lostpointercapture',{pointerId:1,token:old}),false);
  assert.equal(drag.update(1,{...down,type:'pointermove',buttons:0},{token:old}),false);
  assert.equal(drag.end(1,{token:old}),false);
  assert.strictEqual(drag.active,before);
  assert.equal(calls.filter(call=>call.kind==='release').length,1);
  drag.end(1,{token:current});
  assert.equal(calls.filter(call=>call.kind==='release').length,2);
});

test('capture failure clears ownership and reports the error without emitting native input',()=>{
  const error=new Error('Pointer no longer active');
  let attempts=0;
  const {drag,calls,start}=fixture({capture:()=>{if(++attempts===1)throw error;}});
  assert.throws(()=>start(),value=>value===error);
  assert.equal(drag.active,undefined);
  assert.equal(drag.cancel('blur'),false);
  assert.deepEqual(calls,[]);
  assert.ok(start(),'A later pointerdown can acquire ownership');
  drag.end(1);
  assert.deepEqual(calls,[{kind:'release',pointerId:1}]);
});

test('release failures do not prevent cancellation or leave ownership active',()=>{
  let releases=0;
  const {drag,calls,start}=fixture({release:()=>{releases++;throw new Error('No capture');}});
  start();
  assert.doesNotThrow(()=>drag.cancel('lostpointercapture'));
  assert.equal(drag.active,undefined);
  assert.equal(calls.filter(call=>call.kind==='cancel').length,1);
  assert.equal(releases,1);
  assert.equal(drag.cancel('blur'),false);
  start();
  assert.doesNotThrow(()=>drag.end(1));
  assert.equal(drag.active,undefined);
  assert.equal(releases,2);
});

for(const action of ['end','cancel'])
  test(`${action} clears ownership before release synchronously fires lostpointercapture`,()=>{
    let drag,releases=0,cancels=0;
    drag=createNativePointerDrag({
      emitCancel:()=>{cancels++;},
      release:pointerId=>{
        releases++;
        assert.equal(drag.active,undefined);
        assert.equal(drag.cancel('lostpointercapture',{pointerId}),false);
      },
    });
    drag.start({pointerId:1,params:down});
    assert.equal(action==='end'?drag.end(1):drag.cancel('blur'),true);
    assert.equal(releases,1);
    assert.equal(cancels,action==='cancel'?1:0);
  });

test('an emitter error still releases and clears the canceled drag exactly once',()=>{
  const error=new Error('Cannot enqueue native cancellation');
  const {drag,calls,start}=fixture({emitCancel:()=>{throw error;}});
  start();
  assert.throws(()=>drag.cancel('pagehide'),value=>value===error);
  assert.equal(drag.active,undefined);
  assert.equal(drag.cancel('pagehide'),false);
  assert.deepEqual(calls,[{kind:'capture',pointerId:1},{kind:'release',pointerId:1}]);
});

test('cancellation enqueues before release can start a later drag',()=>{
  const calls=[];
  let drag,newToken;
  drag=createNativePointerDrag({
    capture:pointerId=>calls.push(`capture ${pointerId}`),
    emitCancel:()=>calls.push('cancel'),
    release:pointerId=>{
      calls.push(`release ${pointerId}`);
      if(pointerId===1)newToken=drag.start({pointerId:2,params:down});
    },
  });
  const old=drag.start({pointerId:1,params:down});
  drag.cancel('blur',{token:old});
  assert.deepEqual(calls,['capture 1','cancel','release 1','capture 2']);
  assert.equal(drag.active.token,newToken);
  assert.equal(drag.cancel('lostpointercapture',{pointerId:1,token:old}),false);
  assert.equal(drag.active.pointerId,2);
});

test('an old cancellation cannot release capture reacquired by the same pointer during its callback',()=>{
  let drag,newToken;
  const calls=[];
  drag=createNativePointerDrag({
    capture:pointerId=>calls.push(`capture ${pointerId}`),
    emitCancel:()=>{
      calls.push('cancel');
      newToken=drag.start({pointerId:1,params:down});
    },
    release:pointerId=>calls.push(`release ${pointerId}`),
  });
  const old=drag.start({pointerId:1,params:down});
  drag.cancel('blur',{token:old});
  assert.deepEqual(calls,['capture 1','cancel','capture 1']);
  assert.equal(drag.active.token,newToken);
  assert.equal(drag.end(1,{token:old}),false);
  assert.equal(drag.end(1,{token:newToken}),true);
  assert.deepEqual(calls,['capture 1','cancel','capture 1','release 1']);
});
