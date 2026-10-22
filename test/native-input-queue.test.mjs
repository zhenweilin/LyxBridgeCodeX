import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeInputQueue} from '../web/native-input-queue.mjs';

function deferred() {
  let resolve,reject;
  const promise = new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

test('delayed input operations execute strictly in FIFO order and never overlap',async()=>{
  const {enqueue}=createNativeInputQueue(),first=deferred(),second=deferred(),calls=[];
  let active=0;
  const operation=(name,gate)=>async()=>{
    assert.equal(++active,1,'Only one operation may be in flight');
    calls.push(`start ${name}`);
    await gate;
    calls.push(`end ${name}`);
    active--;
    return name;
  };
  const a=enqueue(operation('down',first.promise));
  const b=enqueue(operation('move',second.promise));
  const c=enqueue(operation('up',Promise.resolve()));
  assert.deepEqual(calls,['start down']);
  first.resolve();
  assert.equal(await a,'down');
  assert.deepEqual(calls,['start down','end down','start move']);
  second.resolve();
  assert.deepEqual(await Promise.all([b,c]),['move','up']);
  assert.deepEqual(calls,['start down','end down','start move','end move','start up','end up']);
});

test('several waiting drag moves collapse to the last position and share its exact result',async()=>{
  const {enqueue}=createNativeInputQueue(),gate=deferred(),positions=[];
  const options={coalesceKey:'main:left:no-modifiers'};
  const active=enqueue(async()=>{positions.push(0);await gate.promise;return 'active';},options);
  const latestResult={position:30};
  const moves=[10,20,30].map(position=>enqueue(()=>{
    positions.push(position);
    return position===30?latestResult:{position};
  },options));
  assert.deepEqual(positions,[0],'An in-flight move must not be replaced');
  gate.resolve();
  assert.equal(await active,'active');
  const results=await Promise.all(moves);
  assert.deepEqual(positions,[0,30]);
  for (const result of results) assert.strictEqual(result,latestResult);
});

test('keyup and pointerup remain barriers, with the final move delivered before each barrier',async()=>{
  const {enqueue}=createNativeInputQueue(),gate=deferred(),calls=[];
  const first=enqueue(async()=>{calls.push('down');await gate.promise;});
  const move=position=>enqueue(()=>{calls.push(`move ${position}`);return position;},{coalesceKey:'drag'});
  const tasks=[move(1),move(2),enqueue(()=>calls.push('keyup')),move(3),move(4),enqueue(()=>calls.push('up'))];
  gate.resolve();
  await Promise.all([first,...tasks]);
  assert.deepEqual(calls,['down','move 2','keyup','move 4','up']);
  assert.deepEqual(await Promise.all([tasks[0],tasks[1],tasks[3],tasks[4]]),[2,2,4,4]);
});

test('different surface, button, or modifier keys prevent merging across queued input',async()=>{
  const {enqueue}=createNativeInputQueue(),gate=deferred(),calls=[];
  const first=enqueue(()=>gate.promise);
  const keys=['main:left:none','menu:left:none','main:left:none','main:right:none','main:left:shift','main:left:none'];
  const tasks=keys.map((key,index)=>enqueue(()=>calls.push(index),{coalesceKey:key}));
  gate.resolve();
  await Promise.all([first,...tasks]);
  assert.deepEqual(calls,[0,1,2,3,4,5]);
});

test('missing and empty keys preserve every operation, including between identical move keys',async()=>{
  const {enqueue}=createNativeInputQueue(),gate=deferred(),calls=[];
  const first=enqueue(()=>gate.promise);
  const tasks=[
    enqueue(()=>calls.push('move 1'),{coalesceKey:'drag'}),
    enqueue(()=>calls.push('unkeyed 1')),
    enqueue(()=>calls.push('unkeyed 2')),
    enqueue(()=>calls.push('empty 1'),{coalesceKey:''}),
    enqueue(()=>calls.push('empty 2'),{coalesceKey:''}),
    enqueue(()=>calls.push('move 2'),{coalesceKey:'drag'}),
  ];
  gate.resolve();await Promise.all([first,...tasks]);
  assert.deepEqual(calls,['move 1','unkeyed 1','unkeyed 2','empty 1','empty 2','move 2']);
});

test('every merged caller receives the latest asynchronous error, then queued input continues',async()=>{
  const {enqueue}=createNativeInputQueue(),gate=deferred(),failure=deferred(),calls=[];
  const error=new Error('native input failed');
  const first=enqueue(()=>gate.promise);
  const replaced=enqueue(()=>{calls.push('obsolete move');return 'obsolete';},{coalesceKey:'drag'});
  const latest=enqueue(async()=>{calls.push('latest move');await failure.promise;},{coalesceKey:'drag'});
  const after=enqueue(()=>{calls.push('up');return 'recovered';});
  const settled=Promise.allSettled([replaced,latest,after]);
  gate.resolve();await first;
  assert.deepEqual(calls,['latest move']);
  failure.reject(error);
  const results=await settled;
  assert.strictEqual(results[0].reason,error);
  assert.strictEqual(results[1].reason,error);
  assert.equal(results[2].value,'recovered');
  assert.deepEqual(calls,['latest move','up']);
});

test('a synchronous operation error rejects its own caller without blocking future operations',async()=>{
  const {enqueue}=createNativeInputQueue(),error=new Error('bad event');
  const failed=enqueue(()=>{throw error;});
  const next=enqueue(()=>42);
  const results=await Promise.allSettled([failed,next]);
  assert.deepEqual(results,[{status:'rejected',reason:error},{status:'fulfilled',value:42}]);
  assert.equal(await enqueue(()=>'later'),'later','The queue remains usable after becoming idle');
});

test('a replaced failing move is never called and its caller receives the replacement success',async()=>{
  const {enqueue}=createNativeInputQueue(),gate=deferred();
  const first=enqueue(()=>gate.promise);
  const replaced=enqueue(()=>{assert.fail('Superseded operation must not execute');},{coalesceKey:'drag'});
  const latest=enqueue(()=>'new position',{coalesceKey:'drag'});
  gate.resolve();
  assert.deepEqual(await Promise.all([first,replaced,latest]),[undefined,'new position','new position']);
});

test('invalid operations reject as promises and do not poison the queue',async()=>{
  const {enqueue}=createNativeInputQueue();
  await assert.rejects(enqueue(null),TypeError);
  assert.equal(await enqueue(()=>true),true);
});

test('a selection snapshot separates coalesced drags while slow chat delivery leaves later input free',async()=>{
  const {enqueue}=createNativeInputQueue(),inputGate=deferred(),chatGate=deferred(),calls=[];
  let selection='initial',chatFinished=false;
  const active=enqueue(async()=>{await inputGate.promise;selection='A0';calls.push('A0');});
  const move=value=>enqueue(()=>{selection=value;calls.push(value);return value;},{coalesceKey:'same-drag'});
  const before=[move('A1'),move('A2')];
  // Add to Chat queues only its native snapshot. The asynchronous host work
  // starts after that snapshot resolves and must not block later editor input.
  const snapshot=enqueue(()=>{calls.push(`snapshot ${selection}`);return selection;});
  const chat=(async()=>{
    const selected=await snapshot;
    await chatGate.promise;
    chatFinished=true;
    return selected;
  })();
  const after=[move('B1'),move('B2')];
  inputGate.resolve();
  await active;
  assert.deepEqual(await Promise.all(before),['A2','A2']);
  assert.equal(await snapshot,'A2','Later input must not overtake the clicked selection snapshot');
  assert.deepEqual(await Promise.all(after),['B2','B2']);
  assert.deepEqual(calls,['A0','A2','snapshot A2','B2'],
    'Identical drag keys may coalesce on each side, but never across the snapshot');
  assert.equal(selection,'B2');
  assert.equal(chatFinished,false,'Later native input finishes even while chat delivery is pending');
  chatGate.resolve();
  assert.equal(await chat,'A2');
});
