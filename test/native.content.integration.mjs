import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,readFile,writeFile,mkdtemp,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {NativeSession} from '../lib/native-session.mjs';

async function stopDisposableSession(session,path){
  const child=session.process;
  if(!child){session.stop();return;}
  assert.equal(session.path,path,'Only this test\'s native child may be terminated');
  if(child.exitCode!==null || child.signalCode!==null){session.stop();return;}
  const closed=new Promise(done=>child.once('close',done));
  // An unsaved LyX child can remain in emergency-save after SIGTERM. The
  // fallback applies only to the checked disposable process created below.
  const force=setTimeout(()=>child.kill('SIGKILL'),1000);
  try{session.stop();await closed;}
  finally{clearTimeout(force);}
}

test('native table cell edits preserve neighboring formulas, undo, and saved content across processes', {timeout:60000},async()=>{
  const original=await readFile('demo/demo.lyx');
  await mkdir('.native',{recursive:true});
  const directory=await mkdtemp(resolve('.native/content-integration-')),path=join(directory,'demo.lyx');
  await copyFile('demo/demo.lyx',path);
  const sessions=[];
  let session;
  const open=async()=>{
    session=new NativeSession();sessions.push(session);await session.start(path);
  };
  const command=async command=>{
    const result=await session.call('command',{command});
    assert.ok(!result.error,`${command}: ${result.message}`);
    return result;
  };
  const snapshot=()=>session.call('selection');
  const replace=(before,text)=>session.call('clipboard',{action:'replace-selection',path:before.path,
    sourceRevision:before.sourceRevision,selection:before.clipboardSelection,replacement:{format:'text',text}});
  const formula=/\\begin_inset Formula \$\\frac\{x\^\{2\}\}\{1\+y\}\$/;
  try{
    await open();await session.call('frame',{width:1000,height:800,serial:-1});
    for(const action of ['buffer-end','paragraph-break','layout Standard','tabular-insert 2 2',
      'self-insert CELL_A1','cell-forward','self-insert CELL_A2','cell-forward',
      'self-insert CELL_B1','cell-forward','self-insert CELL_B2','cell-backward','cell-backward'])
      await command(action);
    await command('math-insert \\frac{x^{2}}{1+y}');
    assert.match((await snapshot()).source,formula,'The neighboring cell contains a real native nested formula');
    // Leave the formula, re-enter the table at its last cell, and select A1.
    await command('buffer-end');await command('char-backward');
    for(let index=0;index<3;index++)await command('cell-backward');
    await command('line-begin');await command('line-end-select');
    const before=await snapshot();
    assert.equal(before.modified,true);
    assert.equal(before.selection,'CELL_A1');
    assert.equal(before.selectionStart.length,2);
    assert.equal(before.selectionEnd.length,2);
    assert.equal(before.selectionStart.at(-1).cell,0);
    assert.equal(before.selectionEnd.at(-1).cell,0);
    assert.equal(before.source.split('\nCELL_A1\n').length,2);

    const changed=await replace(before,'UPDATED_A1');
    assert.equal(changed.applied,true,changed.message);
    assert.equal(changed.source,before.source.replace('\nCELL_A1\n','\nUPDATED_A1\n'),
      'Only the selected cell text changes; all other text, formula structure and formatting are preserved');
    assert.match(changed.source,formula);
    assert.match(changed.source,/<lyxtabular version="3" rows="2" columns="2">/);
    assert.deepEqual(await readFile(path),original,'The model edit does not save unsaved native content');
    await command('undo');
    assert.equal((await snapshot()).source,before.source,'One undo restores the full pre-edit table');
    await command('redo');
    assert.equal((await snapshot()).source,changed.source);

    await command('line-begin');
    for(let index=0;index<'UPDATED_A1'.length+1;index++)await command('char-forward-select');
    const across=await snapshot();
    assert.equal(across.selectionStart.at(-1).cell,0);
    assert.equal(across.selectionEnd.at(-1).cell,1);
    const rejected=await replace(across,'MUST_NOT_INSERT');
    assert.equal(rejected.error,true);
    assert.equal(rejected.code,'not_editable');
    assert.notEqual(rejected.applied,true);
    assert.equal((await snapshot()).source,changed.source,'Cross-cell rejection leaves the complete document unchanged');
    await command('undo');
    assert.equal((await snapshot()).source,before.source,'A rejected edit adds no undo entry');
    await command('redo');
    assert.equal((await snapshot()).source,changed.source);
    assert.deepEqual(await readFile(path),original);

    await command('buffer-write');
    const saved=await snapshot();
    assert.equal(saved.modified,false);
    assert.equal(await readFile(path,'utf8'),saved.source);
    const frame=await session.call('frame',{width:1000,height:800,serial:-1});
    await writeFile(join(directory,'table-saved.png'),Buffer.from(frame.surfaces.find(item=>item.main).png,'base64'));
    await stopDisposableSession(session,path);
    await open();
    const reopened=await snapshot();
    assert.equal(reopened.modified,false);
    assert.equal(reopened.source,saved.source,'A new native process reopens exactly the saved table and formula');
    assert.deepEqual(await readFile('demo/demo.lyx'),original,'The supplied demo remains untouched');
    await writeFile(join(directory,'before-edit.lyx'),before.source);
    await writeFile(join(directory,'after-edit.lyx'),changed.source);
    await writeFile(join(directory,'results.json'),JSON.stringify({
      selection:before.clipboardSelection,crossCell:across.clipboardSelection,rejectedCode:rejected.code,
      sourceRevision:saved.sourceRevision,reopenedRevision:reopened.sourceRevision,
    },null,2)+'\n');
    console.log(`Native table content evidence: ${directory}`);
  }finally{
    for(const disposable of sessions)await stopDisposableSession(disposable,path);
  }
});
