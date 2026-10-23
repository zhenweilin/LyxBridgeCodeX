import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,readFile,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {NativeSession} from '../lib/native-session.mjs';

async function stopDisposableSession(session,path){
  assert.equal(session.path,path,'Only this disposable review fixture may be terminated');
  const child=session.process;
  if(!child || child.exitCode!==null || child.signalCode!==null){session.stop();return;}
  const closed=new Promise(done=>child.once('close',done));
  const force=setTimeout(()=>child.kill('SIGKILL'),1000);
  try{session.stop();await closed;}finally{clearTimeout(force);}
}

test('native revisions and multiple anchored comments persist, reject, and undo without losing formulas',{timeout:120000},async()=>{
  const directory=await mkdtemp(resolve('.native/review-integration-'));
  const path=join(directory,'review.lyx');await copyFile('demo/demo.lyx',path);
  const disk=await readFile(path,'utf8');let session=new NativeSession();
  const read=()=>session.call('selection');
  const key=async(key,text='',modifiers={})=>{
    await session.call('input',{type:'keydown',key,text,...modifiers});
    await session.call('input',{type:'keyup',key,text,...modifiers});
  };
  const command=async command=>{const r=await session.call('command',{command});assert.ok(!r.error,r.message);return read();};
  const review=async(operation,params={},before)=>{
    before??=await read();
    const result=await session.call('clipboard',{action:'review',operation,path:before.path,
      sourceRevision:before.sourceRevision,selection:before.clipboardSelection,...params});
    assert.ok(!result.error,`${operation}: ${result.code}: ${result.message}`);return result;
  };
  const replace=async(before,text,format='text')=>{
    const r=await session.call('clipboard',{action:'replace-selection',path,sourceRevision:before.sourceRevision,
      selection:before.clipboardSelection,replacement:{format,text},trackChanges:true});
    assert.ok(!r.error,`${r.code}: ${r.message}`);assert.equal(r.tracked,true);return r;
  };
  const append=async text=>{await command('buffer-end');await command('paragraph-break');await command('layout Standard');await command(`self-insert ${text}`);return command('line-begin-select');};
  const finishChanges=async operation=>{
    for(let n=0;n<10;n++){
      const s=await read();if(!s.review.hasChanges)return;
      await command('buffer-begin');await review('next');await review(operation);
    }
    assert.fail('Review did not consume revisions');
  };
  try{
    await session.start(path);await session.call('frame',{width:1100,height:800,serial:-1});
    assert.equal((await read()).capabilities.review,true);
    const before=await append('Original selected sentence');
    const changed=await replace(before,'Improved sentence');
    assert.match(changed.source,/\\change_deleted/);assert.match(changed.source,/\\change_inserted/);
    assert.match(changed.source,/Original selected sentence/);assert.match(changed.source,/Improved sentence/);
    assert.equal(changed.review.tracking,false,'AI revision leaves the manual tracking preference unchanged');
    await command('undo');assert.equal((await read()).source,before.source,'One undo restores the tracked edit');
    await command('redo');assert.equal((await read()).source,changed.source);
    await finishChanges('reject');
    assert.match((await read()).source,/Original selected sentence/);assert.doesNotMatch((await read()).source,/Improved sentence/);
    await command('buffer-end');const selected=await command('line-begin-select');
    await replace(selected,'Accepted sentence');await finishChanges('accept');
    assert.match((await read()).source,/Accepted sentence/);assert.doesNotMatch((await read()).source,/Original selected sentence/);

    const first=await append('First passage needing a citation');
    const one=await review('comment-add',{text:'Please cite the original theorem.\nKeep the assumptions.'},first);
    assert.equal(one.review.comments.length,1);const id1=one.review.comments[0].id;
    assert.match(one.source,/First passage needing a citation/);
    assert.equal(one.review.comments[0].quote,first.selection);
    await command('undo');assert.equal((await read()).source,first.source,'Adding a note is one undo step');
    await command('redo');assert.equal((await read()).review.comments[0].id,id1);
    const second=await append('Second passage with another issue');
    const two=await review('comment-add',{text:'Clarify this claim. 中文批注'},second);
    assert.equal(two.review.comments.length,2);const id2=two.review.comments[1].id;
    const resolved=await review('comment-resolve',{commentId:id1,resolved:true});
    assert.equal(resolved.review.comments[0].resolved,true);
    await command('undo');assert.equal((await read()).source,two.source,'Resolution is undoable');
    const moved=await review('comment-locate',{commentId:id1});
    assert.equal(moved.selection,first.selection,'Locate highlights the unchanged quoted passage');
    // Native edits before a note shift its anchor, while its identity and quote survive.
    await command('buffer-begin');await command('self-insert Prefix ');
    assert.equal((await read()).review.comments[0].id,id1);
    await review('comment-locate',{commentId:id2});

    await command('buffer-end');await command('paragraph-break');await command('layout Standard');
    await key(77,'m',{meta:true});await key(88,'x');await key(94,'^',{shift:true});await key(50,'2');
    const mathSelect=await command('char-backward-select');
    assert.equal(mathSelect.selection,'2');
    const mathChanged=await replace(mathSelect,'\\frac{a}{b}','math');
    assert.match(mathChanged.source,/Formula \$x\^\{2\}\$/);
    assert.match(mathChanged.source,/Formula \$x\^\{\\frac\{a\}\{b\}\}\$/);
    await command('undo');assert.equal((await read()).source,mathSelect.source,'One undo restores the complete original formula');
    await command('redo');assert.equal((await read()).source,mathChanged.source);
    await finishChanges('reject');assert.match((await read()).source,/Formula \$x\^\{2\}\$/);
    assert.doesNotMatch((await read()).source,/\\frac\{a\}\{b\}/);
    await command('buffer-end');
    const mathAgain=await command('char-backward-select');
    const mathComment=await review('comment-add',{text:'Check this exponent.'},mathAgain);
    assert.equal(mathComment.review.comments.length,3);
    assert.match(mathComment.source,/Formula \$x\^\{2\}\$/,'Annotation does not change the formula');
    // Reject stale batches without touching source or adding undo entries.
    const stale=await session.call('clipboard',{action:'review',operation:'comment-add',path,
      sourceRevision:second.sourceRevision,selection:second.clipboardSelection,text:'Must not appear'});
    assert.equal(stale.code,'revision_conflict');assert.equal((await read()).source,mathComment.source);
    await command('dialog-show document');
    const dialogBlocked=await session.call('clipboard',{action:'review',operation:'comment-resolve',path,
      sourceRevision:mathComment.sourceRevision,commentId:id1,resolved:true});
    assert.equal(dialogBlocked.code,'not_editable');
    assert.equal((await read()).source,mathComment.source,'Review cannot edit behind a native dialog');
    await key(16777216);
    assert.equal(await readFile(path,'utf8'),disk,'Nothing saves implicitly');
    await command('buffer-write');const saved=await read();
    await stopDisposableSession(session,path);session=new NativeSession();await session.start(path);
    const reopened=await read();assert.deepEqual(reopened.review.comments,saved.review.comments);
    await command(`buffer-export pdflatex ${join(directory,'review.tex')}`);
    let tex;
    for(let i=0;i<60;i++){
      tex=await readFile(join(directory,'review.tex'),'utf8').catch(()=>undefined);
      if(tex!==undefined)break;
      await new Promise(done=>setTimeout(done,50));
    }
    assert.ok(tex,'Native LaTeX export must complete');
    assert.ok(!tex.includes('Please cite the original theorem'));assert.ok(!tex.includes('Codex comment'));
    console.log(`Native review evidence: ${directory}`);
  }finally{await stopDisposableSession(session,path);}
});
