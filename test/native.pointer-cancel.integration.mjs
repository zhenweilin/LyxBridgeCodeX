import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,readFile,writeFile,mkdtemp,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {NativeSession} from '../lib/native-session.mjs';

const size={width:1000,height:800};
const marker='CANCELALPHA CANCELBETA CANCELGAMMA CANCELDELTA CANCELEPSILON CANCELZETA';
const delay=milliseconds=>new Promise(resolveDelay=>setTimeout(resolveDelay,milliseconds));
const selection=state=>({cursor:state.cursor,text:state.selection,start:state.selectionStart,end:state.selectionEnd});
const label=text=>text.replaceAll('&','').split('\t')[0];

test('native pointer cancellation stops selection and edge scrolling without activating menus', {timeout:90000}, async()=>{
  const original=await readFile('demo/demo.lyx');
  await mkdir('.native',{recursive:true});
  const directory=await mkdtemp(resolve('.native/pointer-cancel-integration-'));
  const path=join(directory,'demo.lyx');
  await copyFile('demo/demo.lyx',path);
  const session=new NativeSession();
  const records=[];
  const command=async command=>{
    const result=await session.call('command',{command});
    assert.ok(!result.error,`${command}: ${result.message}`);
    return result;
  };
  const input=async params=>{
    await session.call('input',params);
    // input replies before Qt receives its queued event; state is the barrier.
    return session.call('state');
  };
  const frame=()=>session.call('frame',{...size,serial:-1});
  const source=async()=>(await session.call('selection')).source;
  const cancel=()=>input({type:'pointercancel'});
  const point=(surface,item)=>({surface:surface.id,
    x:Math.round(item.x+item.width/2),y:Math.round(item.y+item.height/2),button:0});
  const click=async pointer=>{
    await input({type:'pointerdown',...pointer,buttons:pointer.button===2?2:1});
    return input({type:'pointerup',...pointer,buttons:0});
  };
  const escape=async()=>{
    await input({type:'keydown',key:0x1000000});
    await input({type:'keyup',key:0x1000000});
  };
  const saveFrame=async name=>{
    const current=await frame();
    await writeFile(join(directory,`${name}.png`),Buffer.from(current.surfaces.find(item=>item.main).png,'base64'));
    return current;
  };
  const openEdit=async()=>{
    const main=(await frame()).surfaces.find(item=>item.main);
    const edit=main.menuActions.find(item=>label(item.text)==='Edit');
    assert.ok(edit,'The native Edit menu is present');
    await click(point(main,edit));
    const popup=(await frame()).surfaces.find(item=>item.isMenu
      && item.menuActions.some(action=>action.clipboardAction==='copy'));
    assert.ok(popup,'The native Edit popup opens');
    return popup;
  };
  try{
    await session.start(path);
    await frame();
    await command('buffer-end');
    await command('paragraph-break');
    await command('layout Standard');
    // Add disposable native paragraphs so an edge drag cannot immediately reach
    // the document boundary and pass merely because there is nowhere to scroll.
    const paragraphs=Array.from({length:100},(_,index)=>`Cancel scroll paragraph ${index}: alpha beta gamma delta.`);
    const pasted=await session.call('clipboard',{action:'paste',formats:{
      'text/plain':Buffer.from([...paragraphs,marker].join('\n\n')).toString('base64'),
    }});
    assert.ok(!pasted.error,pasted.message);
    await session.call('state');
    await command('buffer-end');
    await command('line-begin');
    const baseline=await session.call('selection');
    assert.match(baseline.source,/Cancel scroll paragraph 99/);
    assert.ok(baseline.source.includes(marker));
    const paragraph=baseline.selectionStart.at(-1).paragraph;
    const main=(await saveFrame('prepared')).surfaces.find(item=>item.main);
    const surface=main.id;
    const left=200,right=760;
    let y;
    for(const candidate of [584,...Array.from({length:40},(_,index)=>110+index*16)]){
      const a=(await click({surface,x:left,y:candidate,button:0})).selectionStart.at(-1);
      const b=(await click({surface,x:right,y:candidate,button:0})).selectionStart.at(-1);
      if(a?.paragraph===paragraph && b?.paragraph===paragraph
          && a.position>=0 && b.position<=marker.length && b.position-a.position>=8){
        y=candidate;break;
      }
    }
    assert.notEqual(y,undefined,'Locate the native marker using real cursor positions');
    assert.equal(await source(),baseline.source,'Coordinate calibration must not modify content');

    await input({type:'pointerdown',surface,x:left,y,button:0,buttons:1});
    const dragged=await input({type:'pointermove',surface,x:Math.round((left+right)/2),y,buttons:1});
    assert.equal(dragged.hasSelection,true);
    assert.ok(marker.includes(dragged.selection));
    const cancelled=await cancel();
    assert.deepEqual(selection(cancelled),selection(dragged),'Cancel retains the selection reached before interruption');
    for(const x of [right,left,right]){
      const hovered=await input({type:'pointermove',surface,x,y,buttons:0});
      assert.deepEqual(selection(hovered),selection(cancelled),'Hover after cancellation must not extend the old drag');
    }
    await delay(250);
    assert.deepEqual(selection(await session.call('state')),selection(cancelled));
    records.push({case:'document-drag',selection:selection(cancelled)});

    // A new gesture must work: cancel must clear, rather than permanently lock,
    // the captured native widget and LyX's internal mouse-selecting state.
    await input({type:'pointerdown',surface,x:right,y,button:0,buttons:1});
    await input({type:'pointermove',surface,x:left,y,buttons:1});
    const resumed=await input({type:'pointerup',surface,x:left,y,button:0,buttons:0});
    assert.equal(resumed.hasSelection,true);
    assert.ok(resumed.selection.length>cancelled.selection.length);
    assert.equal(await source(),baseline.source);

    // Move well inside the long disposable section, then let LyX's actual
    // synthetic-mouse timer run with no subsequent pointer events.
    await command('buffer-end');
    for(let index=0;index<3;index++)await command('screen-up');
    await frame();
    await input({type:'pointerdown',surface,x:300,y:400,button:0,buttons:1});
    await input({type:'pointermove',surface,x:300,y:300,buttons:1});
    await input({type:'pointermove',surface,x:300,y:80,buttons:1});
    let previous=await session.call('state');
    const autoScroll=[];
    for(let index=0;index<15 && autoScroll.length<2;index++){
      await delay(100);
      const next=await session.call('state');
      if(JSON.stringify(selection(next))!==JSON.stringify(selection(previous)))
        autoScroll.push(selection(next));
      previous=next;
    }
    assert.equal(autoScroll.length,2,'Edge selection must advance twice without pointer input before testing cancellation');
    const stopped=await cancel();
    for(let index=0;index<4;index++){
      await delay(100);
      assert.deepEqual(selection(await session.call('state')),selection(stopped),
        'Cancelling must stop LyX edge-scroll timer, not only clear browser drag state');
    }
    records.push({case:'edge-scroll',observed: autoScroll,stopped:selection(stopped)});
    await saveFrame('edge-scroll-cancelled');
    assert.equal(await source(),baseline.source);

    await command('buffer-end');
    await command('line-begin');
    await frame();
    const contextVariants=[{button:2,buttons:2},
      ...(process.platform==='darwin'?[{button:0,buttons:1,ctrl:true}]:[])];
    for(const modifiers of contextVariants){
      await input({type:'pointerdown',surface,x:250,y,...modifiers});
      await cancel();
      await input({type:'pointermove',surface,x:280,y,buttons:0});
      assert.ok(!(await frame()).surfaces.some(item=>item.isMenu),'Cancelled right-click must not open a context menu');
      await click({surface,x:250,y,button:0});
      assert.ok(!(await frame()).surfaces.some(item=>item.isMenu),'The next left-click must not inherit context-click state');
    }
    // Verify a fresh, genuine context click remains functional after cancel.
    await click({surface,x:250,y,button:2});
    assert.ok((await frame()).surfaces.some(item=>item.isMenu));
    await escape();
    assert.ok(!(await frame()).surfaces.some(item=>item.isMenu));

    await command('buffer-end');
    await command('line-begin-select');
    const selected=await session.call('state');
    assert.equal(selected.hasSelection,true);

    // The bridge parses both RPC lines before Qt handles the posted press. A
    // synchronous cancel would clear pressed_ too early, then the old press
    // would still open Edit after the browser had already cancelled it.
    const batchMain=(await frame()).surfaces.find(item=>item.main);
    const edit=batchMain.menuActions.find(item=>label(item.text)==='Edit');
    assert.ok(edit,'The native menu bar exposes Edit for the batched regression');
    let batched;
    session.socket.cork();
    try{
      batched=Promise.all([
        session.call('input',{type:'pointerdown',...point(batchMain,edit),buttons:1}),
        session.call('input',{type:'pointercancel'}),
      ]);
    }finally{session.socket.uncork();}
    await batched;
    await session.call('state');
    assert.ok(!(await frame()).surfaces.some(item=>item.isMenu),
      'A menu-bar press cancelled in the same socket batch must not open a delayed popup');
    assert.equal(await source(),baseline.source);
    records.push({case:'batched-menu-press-cancel',popup:false});

    for(const action of ['copy','cut']){
      let popup=await openEdit();
      const item=popup.menuActions.find(item=>item.clipboardAction===action);
      assert.equal(item?.enabled,true,`${action} is enabled before interruption`);
      await input({type:'pointerdown',...point(popup,item),buttons:1});
      const interrupted=await cancel();
      assert.ok(!interrupted.menuClipboard?.id,`Cancelled ${action} must not create a pending native command`);
      assert.ok(!['copy','cut','paste'].includes(interrupted.menuClipboard?.action),
        `Cancelled ${action} must not dispatch its native command`);
      assert.ok(!(await frame()).surfaces.some(item=>item.isMenu),'Cancel hides the native popup without releasing its action');
      assert.equal(await source(),baseline.source);

      popup=await openEdit();
      const retry=popup.menuActions.find(item=>item.clipboardAction===action);
      assert.equal(retry?.enabled,true,`${action} stays enabled after cancellation`);
      const completed=await click(point(popup,retry));
      assert.equal(completed.menuClipboard?.action,action,'A subsequent complete menu click dispatches normally');
      await session.call('clipboard',{action:'menu-cancel',requestId:completed.menuClipboard.id});
      assert.equal(await source(),baseline.source,'Neither cancellation nor an unconfirmed Cut may alter the source');
    }
    await cancel(); // Repeated cancellation with no pressed widget is harmless.
    assert.equal((await session.call('state')).modified,baseline.modified);
    assert.deepEqual(await readFile(path),original,'The disposable fixture was never written to disk');
    assert.deepEqual(await readFile('demo/demo.lyx'),original,'The user-provided demo remains byte-identical');
    await saveFrame('recovered');
    await writeFile(join(directory,'results.json'),JSON.stringify({surface,y,paragraph,records},null,2)+'\n');
    console.log(`Native pointer cancellation evidence: ${directory}`);
  }finally{session.stop();}
});
