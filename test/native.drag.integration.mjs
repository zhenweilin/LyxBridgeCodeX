import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,readFile,writeFile,mkdtemp,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {NativeSession} from '../lib/native-session.mjs';
import {createNativeInputQueue} from '../web/native-input-queue.mjs';

const marker='DRAGALPHA DRAGBETA DRAGGAMMA DRAGDELTA DRAGEPSILON DRAGZETA DRAGOMEGA';
const size={width:1000,height:800};
const selection=value=>({
  text:value.selection,
  start:value.selectionStart,
  end:value.selectionEnd,
});

test('real LyX preserves forward and reverse drag endpoints when waiting moves are coalesced', {timeout:60000}, async()=>{
  const original=await readFile('demo/demo.lyx');
  await mkdir('.native',{recursive:true});
  const directory=await mkdtemp(resolve('.native/drag-integration-'));
  const path=join(directory,'demo.lyx');
  await copyFile('demo/demo.lyx',path);
  const session=new NativeSession();
  const command=async command=>{
    const result=await session.call('command',{command});
    assert.ok(!result.error,`${command}: ${result.message}`);
    return result;
  };
  const input=async params=>{
    await session.call('input',params);
    // The native input acknowledgement precedes delivery of the posted Qt event.
    return session.call('state');
  };
  const frame=()=>session.call('frame',{...size,serial:-1});
  const evidence=[];
  try{
    await session.start(path);
    // User profiles can restore 150%+ zoom and wrap the marker onto a second
    // line, invalidating the calibrated drag row after buffer-end/line-begin.
    await command('buffer-zoom 100');
    await frame();
    for(const action of ['buffer-end','paragraph-break','layout Standard',`self-insert ${marker}`,'line-begin'])
      await command(action);
    const prepared=await session.call('selection');
    const paragraph=prepared.selectionStart.at(-1).paragraph;
    assert.ok(prepared.source.includes(marker));
    const preparedFrame=await frame();
    const surface=preparedFrame.surfaces.find(value=>value.main).id;
    await writeFile(join(directory,'prepared.png'),Buffer.from(preparedFrame.surfaces.find(value=>value.main).png,'base64'));

    const click=async(x,y)=>{
      await input({type:'pointerdown',surface,x,y,button:0,buttons:1});
      return input({type:'pointerup',surface,x,y,button:0,buttons:0});
    };
    // Start from the live caret geometry; fixed rows can miss a marker near
    // the bottom of a long document or after a user's zoom preference changes.
    const left=200,right=760;
    let y;
    const caretRow=value=>Math.round(value.inputMethod.rect.y+value.inputMethod.rect.height/2);
    for(const candidate of [caretRow(preparedFrame),584,...Array.from({length:40},(_,index)=>110+index*16)]){
      const a=(await click(left,candidate)).selectionStart.at(-1);
      const b=(await click(right,candidate)).selectionStart.at(-1);
      if(a?.paragraph===paragraph && b?.paragraph===paragraph
        && a.position>=0 && b.position<=marker.length && b.position-a.position>=8){
        y=candidate;
        break;
      }
    }
    assert.notEqual(y,undefined,'Find a visible span of the inserted marker paragraph');
    assert.equal((await session.call('selection')).source,prepared.source,'Coordinate calibration must not edit the document');
    await command('buffer-write');
    const baseline=await session.call('selection');
    assert.equal(baseline.modified,false);
    const diskBaseline=await readFile(path);

    async function drag(name,start,end,coalesce){
      await command('buffer-end');
      await command('line-begin');
      const before=await frame();
      const y=caretRow(before);
      assert.equal(before.hasSelection,false);
      let unblock;
      const gate=new Promise(resolveGate=>{unblock=resolveGate;});
      const {enqueue}=createNativeInputQueue();
      const blocked=enqueue(()=>gate);
      const delivered=[];
      const moves=Array.from({length:40},(_,index)=>Math.round(start+(end-start)*(index+1)/40));
      const event=(type,x,buttons)=>({type,surface,x,y,button:0,buttons});
      const events=[event('pointerdown',start,1),...moves.map(x=>event('pointermove',x,1)),event('pointerup',end,0)];
      const pending=events.map(params=>enqueue(async()=>{
        delivered.push({type:params.type,x:params.x});
        return input(params);
      },coalesce && params.type==='pointermove'?{coalesceKey:`${surface}:left:none`}:{}));
      assert.deepEqual(delivered,[],'The explicit gate, not timing, must create the move backlog');
      unblock();
      await blocked;
      const states=await Promise.all(pending);
      const final=await session.call('selection');
      assert.equal(final.hasSelection,true);
      assert.ok(final.selection.length>=8);
      assert.ok(marker.includes(final.selection),'The native selection must be part of the inserted paragraph');
      assert.equal(final.selectionStart.at(-1).paragraph,paragraph);
      assert.equal(final.selectionEnd.at(-1).paragraph,paragraph);
      assert.equal(final.source,baseline.source,'Dragging must preserve the complete native document source');
      assert.equal(final.modified,baseline.modified,'Dragging must preserve the saved state');
      assert.deepEqual(selection(states.at(-1)),selection(final),'The state after pointerup must contain the final selection');
      assert.equal(delivered[0].type,'pointerdown');
      assert.equal(delivered.at(-1).type,'pointerup');
      assert.deepEqual(delivered.at(-2),{type:'pointermove',x:end},'The endpoint move must precede pointerup');
      const deliveredMoves=delivered.filter(value=>value.type==='pointermove').length;
      assert.equal(deliveredMoves,coalesce?1:moves.length);

      const finalFrame=await frame();
      assert.deepEqual(selection(finalFrame),selection(final),'The final painted frame must carry the final native selection');
      assert.notEqual(finalFrame.surfaces.find(value=>value.main).png,before.surfaces.find(value=>value.main).png);
      await writeFile(join(directory,`${name}.png`),Buffer.from(finalFrame.surfaces.find(value=>value.main).png,'base64'));
      // A released drag must not continue selecting when a later hover arrives.
      const hovered=await input(event('pointermove',Math.round((start+end)/2),0));
      assert.deepEqual(selection(hovered),selection(final));
      assert.deepEqual(await readFile(path),diskBaseline);
      const record={name,requestedMoves:moves.length,deliveredMoves,selection:selection(final),frameSerial:finalFrame.serial};
      evidence.push(record);
      return record;
    }

    for(const [direction,start,end] of [['forward',left,right],['reverse',right,left]]){
      const complete=await drag(`${direction}-complete`,start,end,false);
      const coalesced=await drag(`${direction}-coalesced`,start,end,true);
      assert.deepEqual(coalesced.selection,complete.selection,`${direction}: coalescing must preserve exact text and model positions`);
      assert.ok(coalesced.deliveredMoves<complete.deliveredMoves);
    }
    assert.deepEqual(await readFile('demo/demo.lyx'),original);
    await writeFile(join(directory,'results.json'),JSON.stringify({surface,y,paragraph,evidence},null,2)+'\n');
    console.log(`Native drag evidence: ${directory}`);
  }finally{session.stop();}
});
