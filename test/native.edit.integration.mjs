import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile, readFile, mkdtemp, mkdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';
import {NativeSession} from '../lib/native-session.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const delay=ms=>new Promise(resolveDelay=>setTimeout(resolveDelay,ms));

test('native guarded selection edits preserve unsaved work, replace nested math, and undo atomically', {timeout:120000}, async()=>{
  const originalPath=resolve('demo/demo.lyx'),original=await readFile(originalPath);
  await mkdir('.native',{recursive:true});
  const directory=await mkdtemp(resolve('.native/edit-integration-'));
  const path=join(directory,'demo.lyx');
  await copyFile(originalPath,path);
  const session=new NativeSession();
  const snapshot=()=>session.call('selection');
  const frame=()=>session.call('frame',{width:1000,height:800,serial:-1});
  const command=async value=>{
    const result=await session.call('command',{command:value});
    assert.ok(!result.error,`${value}: ${result.message}`);
    return result;
  };
  const key=async(key,text='',modifiers={})=>{
    await session.call('input',{type:'keydown',key,text,...modifiers});
    await session.call('input',{type:'keyup',key,text,...modifiers});
  };
  const paragraph=async text=>{
    await command('buffer-end');await key(0x1000004);await command('layout Standard');
    if(text)await session.call('input',{type:'commit',text});
  };
  const request=(current,replacement)=>({action:'replace-selection',path:current.path,
    sourceRevision:current.sourceRevision,selection:structuredClone(current.clipboardSelection),replacement});
  const edit=async(current,replacement)=>{
    const result=await session.call('clipboard',request(current,replacement));
    assert.ok(!result.error,`${result.code}: ${result.message}`);
    assert.equal(result.applied,true,'A successful result confirms mutation, not dispatch alone');
    assert.equal(result.previousSourceRevision,current.sourceRevision);
    assert.equal(result.sourceRevision,hash(result.source));
    assert.equal(result.source,(await snapshot()).source,'The returned source is the committed native buffer');
    assert.equal(result.modified,true);
    assert.deepEqual(await readFile(path),original,'Replacing a selection never saves implicitly');
    return result;
  };
  const rejectWithoutChanges=async(params,code)=>{
    const before=await snapshot();
    const result=await session.call('clipboard',params);
    assert.equal(result.error,true);
    assert.equal(result.code,code,result.message);
    assert.notEqual(result.applied,true);
    const after=await snapshot();
    assert.equal(after.source,before.source,'Rejected edits do not mutate the native document');
    assert.equal(after.sourceRevision,before.sourceRevision);
    assert.deepEqual(after.clipboardSelection,before.clipboardSelection,'Rejected edits preserve native selection');
    assert.deepEqual(await readFile(path),original,'Rejected edits do not write the backing file');
  };
  const eventually=async(read,predicate,message)=>{
    for(let attempt=0;attempt<80;attempt++){
      const value=await read();
      if(predicate(value))return value;
      await delay(25);
    }
    assert.fail(`${message}; fixture: ${directory}`);
  };
  try{
    await session.start(path);await frame();
    const initial=await snapshot();
    assert.equal(initial.capabilities?.editSelection,true,'Build the native selection-edit bridge before running this test');
    assert.equal(initial.sourceRevision,hash(initial.source));
    await paragraph('Unsaved surrounding content must survive');
    await paragraph('Original selected words');
    await command('line-begin-select');
    const before=await snapshot();
    assert.equal(before.selection,'Original selected words');
    assert.equal(before.modified,true);
    // Put both protocol lines in one native socket batch. The first request
    // posts a Qt input event, so an old source hash alone cannot prove that the
    // user has no earlier input still waiting to update the document model.
    session.socket.cork();
    const concurrentInput=session.call('input',{type:'commit',text:'Concurrent native user input'});
    const concurrentEdit=session.call('clipboard',request(before,{format:'text',text:'Must never overwrite pending input'}));
    session.socket.uncork();
    const [,refused]=await Promise.all([concurrentInput,concurrentEdit]);
    assert.equal(refused.error,true);
    assert.ok(['input_pending','revision_conflict'].includes(refused.code),refused.message);
    assert.notEqual(refused.applied,true,'Input acknowledged before its Qt event must still block an old edit');
    const typed=await eventually(snapshot,value=>value.source.includes('Concurrent native user input'),'Queued native input must complete');
    assert.doesNotMatch(typed.source,/Must never overwrite pending input/);
    await command('undo');
    assert.equal((await snapshot()).source,before.source);
    await command('buffer-end');await command('line-begin-select');
    assert.deepEqual((await snapshot()).clipboardSelection,before.clipboardSelection);
    // Paste and UI command dispatch acknowledge before executing, just like
    // posted input. They must participate in the same pending-edit barrier.
    for(const pending of [
      {name:'paste',method:'clipboard',text:'Concurrent native clipboard paste',
        params:{action:'paste',formats:{
          'text/plain':Buffer.from('Concurrent native clipboard paste').toString('base64'),
        }}},
      {name:'dispatch',method:'dispatch',text:'Concurrent dispatched native input',
        params:{command:'self-insert Concurrent dispatched native input'}},
    ]){
      const unchanged=await snapshot();
      assert.equal(unchanged.source,before.source);
      assert.deepEqual(unchanged.clipboardSelection,before.clipboardSelection);
      session.socket.cork();
      const earlier=session.call(pending.method,pending.params);
      const later=session.call('clipboard',request(unchanged,
        {format:'text',text:`Must never overwrite pending ${pending.name}`}));
      session.socket.uncork();
      const [acknowledged,rejected]=await Promise.all([earlier,later]);
      assert.ok(!acknowledged.error,`${pending.name}: ${acknowledged.message}`);
      assert.equal(rejected.error,true,`${pending.name} must block the stale replacement`);
      assert.ok(['input_pending','revision_conflict'].includes(rejected.code),rejected.message);
      assert.notEqual(rejected.applied,true);
      const completed=await eventually(snapshot,value=>value.source.includes(pending.text),
        `Queued ${pending.name} must complete`);
      assert.ok(!completed.source.includes(`Must never overwrite pending ${pending.name}`));
      assert.match(completed.source,/Unsaved surrounding content must survive/);
      assert.deepEqual(await readFile(path),original,`${pending.name} and a rejected edit never save`);
      await command('undo');
      assert.equal((await snapshot()).source,unchanged.source,
        `One undo must restore only the user's ${pending.name}; rejection adds no undo entry`);
      await command('buffer-end');await command('line-begin-select');
      assert.deepEqual((await snapshot()).clipboardSelection,before.clipboardSelection);
    }
    const replacement={format:'text',text:'Updated selected words\nSecond paragraph 中文'};
    const changed=await edit(before,replacement);
    assert.match(changed.source,/Unsaved surrounding content must survive/);
    assert.doesNotMatch(changed.source,/Original selected words/);
    assert.match(changed.source,/\\begin_layout Standard\nUpdated selected words\n\\end_layout\s+\\begin_layout Standard\nSecond paragraph 中文\n\\end_layout/);
    assert.notEqual(changed.sourceRevision,before.sourceRevision);
    await command('undo');
    assert.equal((await snapshot()).source,before.source,'One native undo restores the complete pre-edit source');
    await command('redo');
    assert.equal((await snapshot()).source,changed.source,'The same edit belongs to native redo');

    // Keep a successful edit immediately below failed requests in undo history.
    // If validation records even an empty undo entry, the final undo will fail
    // to restore the complete original selection and surrounding user edits.
    await command('buffer-end');await command('line-begin-select');
    const selected=await snapshot(),valid=request(selected,{format:'text',text:'Never inserted'});
    await rejectWithoutChanges({...valid,sourceRevision:before.sourceRevision},'revision_conflict');
    await rejectWithoutChanges({...valid,path:join(directory,'other.lyx')},'document_mismatch');
    await rejectWithoutChanges({...valid,selection:{...valid.selection,text:'Different selection'}},'selection_conflict');
    const wrongPosition=structuredClone(valid);
    wrongPosition.selection.start[0].position++;
    await rejectWithoutChanges(wrongPosition,'selection_conflict');
    await rejectWithoutChanges({...valid,replacement:{format:'text',text:'invalid\0text'}},'invalid_replacement');
    await rejectWithoutChanges({...valid,replacement:{format:'math',text:'x'}},'invalid_replacement');
    await command('undo');
    assert.equal((await snapshot()).source,before.source,'Failed guards add no undo step');

    await paragraph();
    await key(77,'m',{meta:true});await key(88,'x');await key(94,'^',{shift:true});await key(50,'2');
    await command('char-backward-select');
    const mathBefore=await snapshot();
    assert.equal(mathBefore.selection,'2');
    assert.ok(mathBefore.selectionStart.length>=3,'The selection is nested inside the superscript cell');
    const invalidMath=request(mathBefore,{format:'math',text:'}'});
    await rejectWithoutChanges(invalidMath,'invalid_replacement');
    await rejectWithoutChanges(request(mathBefore,{format:'text',text:'3'}),'invalid_replacement');
    const staleMath=request(mathBefore,{format:'math',text:'3'});
    staleMath.selection.start=structuredClone(staleMath.selection.start);
    staleMath.selection.start[0].position++;
    await rejectWithoutChanges(staleMath,'selection_conflict');
    const mathAfter=await edit(mathBefore,{format:'math',text:'\\frac{a}{b}'});
    assert.match(mathAfter.source,/\\begin_inset Formula \$x\^\{\\frac\{a\}\{b\}\}\$/,
      'Replacement stays native math and does not wrap the old selection in the fraction');
    await key(51,'3');
    assert.match((await snapshot()).source,/\\frac\{a\}\{b\}3/,'Native typing can continue in the edited math cell');
    await command('undo');
    assert.equal((await snapshot()).source,mathAfter.source,'User typing has its own undo step');
    await command('undo');
    assert.equal((await snapshot()).source,mathBefore.source,'A second undo restores exactly the pre-Codex formula');
    await command('redo');
    assert.equal((await snapshot()).source,mathAfter.source);

    await command('buffer-begin');await command('word-forward-select');
    const documentSelection=await snapshot();
    const blocked=request(documentSelection,{format:'text',text:'Must not replace document or widget'});
    await session.call('dispatch',{command:'dialog-show findreplace'});
    await key(65,'a',{meta:true});
    await session.call('input',{type:'commit',text:'Search field text'});
    await key(65,'a',{meta:true});
    await eventually(snapshot,value=>value.clipboardSelection.kind==='widget','The native search field must own focus');
    await rejectWithoutChanges(blocked,'not_editable');
    await key(0x1000000);
    await eventually(snapshot,value=>value.clipboardSelection.kind==='document','Escape returns focus to the document');
    await session.call('dispatch',{command:'buffer-reload'});
    await eventually(frame,value=>value.surfaces.some(surface=>surface.modal),'Reload opens the native unsaved-change modal');
    assert.equal((await snapshot()).inputPending,true,
      'Deferred native commands stay pending throughout a nested modal event loop');
    await rejectWithoutChanges(blocked,'input_pending');
    await key(0x1000000);
    await eventually(frame,value=>value.surfaces.length===1,'Escape cancels the modal');
    assert.equal((await snapshot()).source,mathAfter.source);
    assert.deepEqual(await readFile(path),original);

    // Only the explicit native Save command below writes the disposable file.
    await command('buffer-write');
    const saved=await snapshot();
    assert.equal(saved.modified,false);
    assert.equal(await readFile(path,'utf8'),saved.source);
    assert.deepEqual(await readFile(originalPath),original,'The user-provided demo is untouched');
    console.log(`Native guarded-edit evidence: ${directory}`);
  }finally{session.stop();}
});
