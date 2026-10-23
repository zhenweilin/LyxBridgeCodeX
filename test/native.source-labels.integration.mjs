import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {NativeSession} from '../lib/native-session.mjs';

const ert=code=>`\\begin_inset ERT\nstatus open\n\n${code.split('\n').map(line=>
  `\\begin_layout Plain Layout\n${line.replaceAll('\\','\\backslash\n')}\n\\end_layout\n`).join('\n')}\n\\end_inset`;
const reference=name=>String.raw`\begin_inset CommandInset ref
LatexCommand ref
reference "${name}"
\end_inset
`;

test('raw LaTeX line labels participate in native references, navigation, undo, reopen and PDF export',
  {timeout:120000},async()=>{
  const directory=await mkdtemp(resolve('.native/source-labels-'));
  const path=join(directory,'line-labels.lyx');
  const raw=String.raw`\begin{minipage}{\linewidth}
\begin{algorithmic}[1]
\State $x\gets 0$\label{line:init}
\While{$x<3$}
  \State $x\gets x+1$\label{line:update}
\EndWhile
\end{algorithmic}
\end{minipage}
% \label{line:comment}
\newcommand{\unusedlabel}[1]{\label{#1}\label{line:definition}}`;
  await writeFile(path,String.raw`#LyX 2.5 created this file.
\lyxformat 643
\begin_document
\begin_header
\textclass article
\begin_preamble
\usepackage{algpseudocodex}
\end_preamble
\language english
\inputencoding utf8
\end_header
\begin_body
\begin_layout Standard
Forward reference: line ${reference('line:update')}.
\end_layout
\begin_layout Standard
\begin_inset Preview
\begin_layout Standard
${ert(raw)}
\end_layout
\end_inset
\end_layout
\begin_layout Standard
Native label: \begin_inset CommandInset label
LatexCommand label
name "native:keep"
\end_inset
\end_layout
\begin_layout Standard
\begin_inset Note Note
status open
\begin_layout Plain Layout
${ert(String.raw`\label{line:hidden}`)}
\end_layout
\end_inset
\end_layout
\begin_layout Standard
Insert a reference here: 
\end_layout
\end_body
\end_document
`);
  let session=new NativeSession();
  const command=async command=>{
    const result=await session.call('command',{command});assert.ok(!result.error,`${command}: ${result.message}`);
  };
  const snapshot=()=>session.call('selection',{includeReferences:true});
  const frame=async name=>{
    const result=await session.call('frame',{width:1100,height:850,serial:-1});
    for(const [i,surface] of result.surfaces.entries())
      await writeFile(join(directory,`${name}-${i}.png`),Buffer.from(surface.png,'base64'));
    return result;
  };
  const names=value=>value.references.labels.filter(x=>!x.missing).map(x=>x.name);
  const selectRawLabel=async()=>{
    await command('label-goto line:update');
    const at=await snapshot();
    assert.equal(at.cursor.length,3,'Go to reference opens the source inside Preview and ERT');
    for(let i=0;i<String.raw`\label{line:update}`.length;i++)await command('char-forward-select');
    assert.equal((await snapshot()).selection,String.raw`\label{line:update}`);
  };
  try{
    await session.start(path);await frame('document');
    const initial=await snapshot();
    assert.deepEqual(names(initial).sort(),['line:init','line:update','native:keep']);
    assert.deepEqual(initial.references.broken,[],'Forward references to raw source are valid');
    assert.equal(initial.modified,false,'Building the index never dirties the document');
    await command('buffer-end');await command('dialog-show ref');
    const dialog=(await frame('reference-dialog')).surfaces.find(x=>!x.main);
    assert.ok(dialog,'The real native reference dialog is visible');
    await session.call('input',{type:'commit',text:'line:update'});await session.call('state');
    // Filter is initially focused. The first result is the top data row of
    // the native label tree, verified in reference-dialog-1.png.
    const pointer={surface:dialog.id,x:52,y:140,button:0};
    for(const type of ['pointerdown','pointerup','dblclick','pointerup'])
      await session.call('input',{type,...pointer,buttons:type==='pointerup'?0:1});
    await session.call('state');await frame('selected-reference');
    // LyX uses Enter in Available Labels to add items; Right moves focus to
    // Selected Labels, where Enter activates the dialog's default OK button.
    for(const key of [0x1000014,0x1000004])
      for(const type of ['keydown','keyup'])await session.call('input',{type,key,text:''});
    await session.call('state');
    assert.equal((await frame('inserted-reference')).surfaces.length,1,'Enter inserts the selected source label');
    assert.equal((await snapshot()).source.split('reference "line:update"').length-1,2);
    await selectRawLabel();await frame('source-target');
    await command(String.raw`self-insert \label{line:renamed}`);
    const renamed=await snapshot();
    assert.ok(names(renamed).includes('line:renamed'));
    assert.ok(!names(renamed).includes('line:update'));
    assert.ok(renamed.references.broken.length,'An old reference becomes broken after an explicit source rename');
    await command('undo');
    assert.ok(names(await snapshot()).includes('line:update'));
    assert.deepEqual((await snapshot()).references.broken,[]);
    await selectRawLabel();await command('char-delete-forward');
    assert.ok(!names(await snapshot()).includes('line:update'));
    await command('undo');assert.deepEqual((await snapshot()).references.broken,[]);
    await command('buffer-write');
    const saved=await readFile(path,'utf8');
    assert.equal(saved.split('\\begin_inset CommandInset label').length-1,1,'Raw labels remain raw; no duplicate native label is inserted');
    await command('buffer-export pdflatex');
    for(let i=0;i<100;i++){
      if(await readFile(join(directory,'line-labels.tex')).then(()=>true,()=>false))break;
      await new Promise(done=>setTimeout(done,100));
    }
    const tex=await readFile(join(directory,'line-labels.tex'),'utf8');
    assert.equal(tex.split(String.raw`\label{line:update}`).length-1,1);
    for(let i=0;i<2;i++)execFileSync('/Library/TeX/texbin/pdflatex',
      ['-interaction=nonstopmode','-halt-on-error','line-labels.tex'],{cwd:directory,stdio:'pipe',timeout:30000});
    const aux=await readFile(join(directory,'line-labels.aux'),'utf8');
    assert.match(aux,/\\newlabel\{line:update\}\{\{3\}/);
    const log=await readFile(join(directory,'line-labels.log'),'utf8');
    assert.doesNotMatch(log,/undefined references|multiply defined|LaTeX Error/);
    session.stop();session=new NativeSession();await session.start(path);await frame('reopened');
    assert.deepEqual(names(await snapshot()).sort(),['line:init','line:update','native:keep']);
    assert.deepEqual((await snapshot()).references.broken,[]);
    assert.equal(await readFile(path,'utf8'),saved);
    console.log(`Source label evidence: ${directory}`);
  }finally{session.stop();}
});
