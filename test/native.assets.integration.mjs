import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,readFile,writeFile,mkdtemp,mkdir,cp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {NativeSession} from '../lib/native-session.mjs';

async function stopDisposableSession(session,path){
  const child=session.process;
  if(!child){session.stop();return;}
  assert.equal(session.path,path,'Only this test\'s native child may be terminated');
  if(child.exitCode!==null || child.signalCode!==null){session.stop();return;}
  const closed=new Promise(done=>child.once('close',done));
  const force=setTimeout(()=>child.kill('SIGKILL'),1000);
  try{session.stop();await closed;}
  finally{clearTimeout(force);}
}

test('native references, citations and relative graphics survive undo, save, reopen and relocation', {timeout:60000},async()=>{
  const original=await readFile('demo/demo.lyx');
  await mkdir('.native',{recursive:true});
  const directory=await mkdtemp(resolve('.native/assets-integration-'));
  const source=join(directory,'source'),relocated=join(directory,'relocated'),path=join(source,'demo.lyx');
  await mkdir(join(source,'assets'),{recursive:true});await mkdir(join(source,'references'));
  await copyFile('demo/demo.lyx',path);
  const library=process.env.LYX_CODEX_LIBRARY??JSON.parse(await readFile('.native/engine.json','utf8')).library;
  const image=await readFile(join(library,'doc/clipart/ToolbarEnvBox.png'));
  await writeFile(join(source,'assets/native figure.png'),image);
  const bibliography='@article{native2026,\n  author={Alice Author and Bob Writer},\n  title={Native Citation Fixture},\n  journal={Integration Journal},\n  year={2026},\n  volume={1},\n  pages={1--2}\n}\n';
  await writeFile(join(source,'references/review.bib'),bibliography);
  const sessions=[];
  let session;
  const open=async file=>{
    session=new NativeSession();sessions.push({session,path:file});await session.start(file);
  };
  const command=async command=>{
    const result=await session.call('command',{command});
    assert.ok(!result.error,`${command}: ${result.message}`);return result;
  };
  const snapshot=()=>session.call('selection');
  const frame=()=>session.call('frame',{width:1000,height:1000,serial:-1});
  const paragraph=async text=>{
    await command('buffer-end');await command('paragraph-break');await command('layout Standard');
    if(text)await command(`self-insert ${text}`);
  };
  const checkUndo=async before=>{
    const changed=await snapshot();
    await command('undo');assert.equal((await snapshot()).source,before.source);
    await command('redo');assert.equal((await snapshot()).source,changed.source);
    return changed;
  };
  const key=async(key,text='',modifiers={})=>{
    await session.call('input',{type:'keydown',key,text,...modifiers});
    await session.call('input',{type:'keyup',key,text,...modifiers});
    return session.call('state');
  };
  const click=async(surface,x,y)=>{
    await session.call('input',{type:'pointerdown',surface,x,y,button:0,buttons:1});
    await session.call('input',{type:'pointerup',surface,x,y,button:0,buttons:0});
    return session.call('state');
  };
  try{
    await open(path);await frame();await command('buffer-end');
    await command('label-insert sec:native-assets');
    const label=await snapshot();
    assert.match(label.source,/CommandInset label\nLatexCommand label\nname "sec:native-assets"/);
    await paragraph('Cross-reference:');
    const beforeReference=await snapshot();
    await command('inset-insert ref LatexCommand ref reference "sec:native-assets" \\end_inset');
    const reference=await checkUndo(beforeReference);
    assert.match(reference.source,/CommandInset ref\nLatexCommand ref\nreference "sec:native-assets"/);
    const target=await command('label-goto sec:native-assets');
    assert.notDeepEqual(target.cursor,reference.cursor);
    assert.equal(target.cursor[0].paragraph,label.cursor[0].paragraph,'The native reference resolves to its label');

    await paragraph();
    await command('inset-insert bibtex LatexCommand bibtex btprint "btPrintCited" bibfiles "references/review" options "plain" encoding "default" \\end_inset');
    await paragraph('Citation:');
    const beforeCitation=await snapshot();
    await command('citation-insert native2026');
    const citation=await checkUndo(beforeCitation);
    assert.match(citation.source,/CommandInset citation\nLatexCommand cite\nkey "native2026"/);

    await paragraph('Relative graphic:');
    const beforeGraphics=await snapshot();
    // Graphics parameters are line-based: a filename can itself contain spaces.
    await command('inset-insert graphics\nfilename assets/native figure.png\nwidth 120pt\n\\end_inset');
    const graphics=await checkUndo(beforeGraphics);
    assert.match(graphics.source,/\\begin_inset Graphics\n\s*filename assets\/native figure\.png\n/);
    assert.match(graphics.source,/bibfiles "references\/review"/);
    assert.ok(!graphics.source.includes(join(source,'assets')),'The graphic path stays relative');
    assert.deepEqual(await readFile(path),original,'No insertion implicitly saves the document');
    await command('buffer-write');
    const saved=await snapshot();
    assert.equal(saved.modified,false);assert.equal(await readFile(path,'utf8'),saved.source);
    await stopDisposableSession(session,path);

    await open(path);
    assert.equal((await snapshot()).source,saved.source,'A new native process reopens the exact saved source');
    await stopDisposableSession(session,path);
    await cp(source,relocated,{recursive:true});
    const relocatedPath=join(relocated,'demo.lyx');
    await open(relocatedPath);await command('buffer-end');
    assert.equal((await snapshot()).source,saved.source,'Moving the whole asset tree preserves the source');
    assert.deepEqual(await readFile(join(relocated,'assets/native figure.png')),image);
    assert.equal(await readFile(join(relocated,'references/review.bib'),'utf8'),bibliography);
    const relocatedFrame=await frame();
    await writeFile(join(directory,'relocated-document.png'),Buffer.from(relocatedFrame.surfaces.find(item=>item.main).png,'base64'));

    // Select and copy the actual rendered citation details, proving that the
    // relative .bib was parsed after relocation, not just retained as a path.
    await session.call('dispatch',{command:'citation-insert'});
    const pickerFrame=await frame();
    const picker=pickerFrame.surfaces.find(item=>item.type==='lyx::frontend::GuiCitation');
    assert.ok(picker,'The native citation picker opens');
    // These locations were inspected in the pinned LyX/Fusion dialog. Clicking
    // the NoFocus viewport must focus its QTextEdit owner for native shortcuts.
    await click(picker.id,70,82);
    const previewFocus=await click(picker.id,Math.round(picker.width/2),picker.height-232);
    assert.ok(Object.hasOwn(previewFocus.clipboardSelection,'revision'),'Clicking the native citation preview gives its QTextEdit keyboard focus');
    const selected=await key(65,'a',{meta:process.platform==='darwin',ctrl:process.platform!=='darwin'});
    assert.equal(selected.clipboardSelection.kind,'widget');
    const detailsFrame=await frame();
    await writeFile(join(directory,'citation-details.png'),Buffer.from(detailsFrame.surfaces.find(item=>item.id===picker.id).png,'base64'));
    assert.ok(selected.clipboardSelection.hasSelection,JSON.stringify(selected.clipboardSelection));
    const copied=await session.call('clipboard',{action:'copy'});
    assert.ok(!copied.error,copied.message);
    const details=copied.clipboard.text;
    for(const text of ['Alice','Bob','Native Citation Fixture','Integration Journal','2026'])
      assert.ok(details.includes(text),`The citation preview contains ${text}: ${details}`);
    await key(0x1000000);
    assert.equal((await snapshot()).source,saved.source,'Inspecting and canceling the picker does not edit the document');
    assert.deepEqual(await readFile('demo/demo.lyx'),original,'The supplied demo remains untouched');
    await writeFile(join(directory,'results.json'),JSON.stringify({
      citationDetails:details,sourceRevision:saved.sourceRevision,relocatedPath,
      referenceTarget:target.cursor,referenceUndoExact:true,citationUndoExact:true,graphicsUndoExact:true,
    },null,2)+'\n');
    console.log(`Native relative asset evidence: ${directory}`);
  }finally{
    for(const disposable of sessions)await stopDisposableSession(disposable.session,disposable.path);
  }
});
