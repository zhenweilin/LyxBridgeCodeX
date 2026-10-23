import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {NativeSession} from '../lib/native-session.mjs';

test('native colors preserve text styles and formulas, recolor, reset, guard stale targets and undo',
  {timeout:120000},async()=>{
  const directory=await mkdtemp(resolve('.native/color-integration-')),path=join(directory,'colors.lyx');
  const original=String.raw`#LyX 2.5 created this file.
\lyxformat 643
\begin_document
\begin_header
\textclass article
\language english
\inputencoding utf8
\end_header
\begin_body
\begin_layout Standard
\series bold
Selected color example
\series default
\end_layout
\begin_layout Standard
\begin_inset Formula $x^{2}+y$
\end_inset
\end_layout
\end_body
\end_document
`;
  await writeFile(path,original);
  let session=new NativeSession();
  const command=async command=>{const r=await session.call('command',{command});assert.ok(!r.error,r.message);};
  const snapshot=()=>session.call('selection');
  const target=()=>session.call('clipboard',{action:'color-target'});
  const apply=async(color,at=undefined)=>{
    at??=await target();assert.ok(!at.error,at.message);
    const result=await session.call('clipboard',{action:'apply-color',color,path:at.path,
      sourceRevision:at.sourceRevision,selection:at.clipboardSelection});
    assert.equal(result.applied,true,JSON.stringify(result));
    return snapshot();
  };
  const frame=async name=>{
    const r=await session.call('frame',{width:1100,height:800,serial:-1});
    for(const [i,s] of r.surfaces.entries())await writeFile(join(directory,`${name}-${i}.png`),Buffer.from(s.png,'base64'));
    return r;
  };
  const selectText=async()=>{await command('buffer-begin');await command('line-end-select');};
  const selectMath=async()=>{
    await command('buffer-end');await command('char-backward');
    const current=await snapshot();
    for(let i=0;i<current.cursor.at(-1).position;i++)await command('char-backward-select');
  };
  try{
    await session.start(path);await frame('toolbar');
    await writeFile(join(directory,'controls.json'),JSON.stringify((await session.call('selection',{includeControls:true})).controls,null,2));
    await selectText();const before=await snapshot();
    const red=await apply('#ff0000');
    assert.match(red.source,/\\color red/);assert.match(red.source,/\\series bold/);
    assert.equal(red.selection,before.selection);
    await command('undo');assert.equal((await snapshot()).source,before.source);
    await command('redo');assert.equal((await snapshot()).source,red.source);
    await selectText();const custom=await apply('#2468ac');
    assert.match(custom.source,/\\customcolor codexcolor2468ac 2468ac/);
    assert.match(custom.source,/\\color codexcolor2468ac/);
    await command('undo');assert.equal((await snapshot()).source,red.source,'Custom definition and text color undo together');
    await command('redo');await selectText();const reset=await apply('default');
    assert.doesNotMatch(reset.source,/\\color (red|codexcolor2468ac)/);
    assert.match(reset.source,/\\series bold/,'Reset changes color only');
    await command('undo');await selectText();
    const stale=await target();await command('buffer-end');
    const failed=await session.call('clipboard',{action:'apply-color',color:'#0000ff',path:stale.path,
      sourceRevision:stale.sourceRevision,selection:stale.clipboardSelection});
    assert.equal(failed.code,'selection_conflict');
    assert.equal((await snapshot()).source,custom.source);

    await selectMath();
    const mathBefore=await snapshot();assert.ok(mathBefore.cursor.length>=2);
    assert.match(mathBefore.selection,/x.*2/);
    const mathRed=await apply('#ff0000');
    assert.match(mathRed.source,/\\color\{red\}/);assert.match(mathRed.source,/x\^\{?2/);
    const mathBlue=await apply('#0000ff');
    assert.match(mathBlue.source,/\\color\{blue\}/);
    assert.doesNotMatch(mathBlue.source,/\\color\{red\}/,'Second color replaces the first inside selected math');
    await command('undo');assert.equal((await snapshot()).source,mathRed.source);
    await command('redo');await selectMath();await apply('default');
    const mathReset=await snapshot();assert.match(mathReset.source,/\\normalcolor/);
    assert.doesNotMatch(mathReset.source,/\\color\{blue\}/);
    await command('undo');
    await frame('colored');
    assert.equal(await readFile(path,'utf8'),original,'Color actions never save implicitly');
    await command('buffer-write');await command('buffer-export pdflatex');
    for(let i=0;i<100;i++){
      if(await readFile(join(directory,'colors.tex')).then(()=>true,()=>false))break;
      await new Promise(done=>setTimeout(done,100));
    }
    const tex=await readFile(join(directory,'colors.tex'),'utf8');
    assert.match(tex,/\\definecolor\{codexcolor2468ac\}/);
    execFileSync('/Library/TeX/texbin/pdflatex',['-interaction=nonstopmode','-halt-on-error','colors.tex'],
      {cwd:directory,stdio:'pipe',timeout:30000});
    const saved=await readFile(path,'utf8');session.stop();session=new NativeSession();await session.start(path);
    await frame('reopened');assert.equal((await snapshot()).source,saved);
    console.log(`Color evidence: ${directory}`);
  }finally{session.stop();}
});
