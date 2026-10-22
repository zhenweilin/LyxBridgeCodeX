import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,readFile,writeFile,mkdtemp,mkdir,cp,lstat,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {NativeSession} from '../lib/native-session.mjs';
import {nativeUserProfile} from '../lib/native-profile.mjs';

test('LaTeX pseudocode menu, nesting, undo, native previews and PDF use the same source', {timeout:120000},async()=>{
  const directory=await mkdtemp(resolve('.native/pseudocode-integration-'));
  const path=join(directory,'example.lyx'),profile=join(directory,'profile'),temporary=join(directory,'tmp');
  await mkdir(temporary);await mkdir(profile);
  await cp(await nativeUserProfile(),profile,{recursive:true,filter:async source=>{
    const info=await lstat(source);return info.isDirectory()||info.isFile()||info.isSymbolicLink();
  }}).catch(error=>{if(error.code!=='ENOENT')throw error;});
  const prefs=join(profile,'preferences');
  await writeFile(prefs,(await readFile(prefs,'utf8').catch(()=>''))+`\n\\tempdir_path "${temporary}"\n\\preview off\n`);
  await copyFile('test/fixtures/demo.lyx',path);
  const original=await readFile(path,'utf8'),session=new NativeSession();
  const oldProfile=process.env.LYX_USER_PROFILE;process.env.LYX_USER_PROFILE=profile;
  const command=async command=>{const r=await session.call('command',{command});assert.ok(!r.error,r.message);return r;};
  const snapshot=()=>session.call('selection');
  const frame=()=>session.call('frame',{width:1000,height:900,serial:-1});
  const key=async(key,text='')=>{for(const type of ['keydown','keyup'])await session.call('input',{type,key,text});await session.call('state');};
  const choose=async name=>{
    await command('drop-layouts-choice');
    assert.ok((await frame()).surfaces.some(x=>x.type==='QComboBoxPrivateContainer'));
    for(const c of name)await key(c.toUpperCase().charCodeAt(0),c);
    await key(0x1000010);await key(0x1000004);
    const confirmed=await frame();
    if(confirmed.surfaces.length!==1){
      await writeFile(join(directory,'menu-failure.json'),JSON.stringify(confirmed.surfaces.map(({png,...x})=>x),null,2));
      for(const x of confirmed.surfaces)await writeFile(join(directory,`failure-${x.type.replaceAll(':','')}.png`),Buffer.from(x.png,'base64'));
      console.log('Menu failure evidence:',directory,name);
    }
    assert.equal(confirmed.surfaces.length,1,'Enter confirms a pseudocode menu entry');
  };
  try{
    await session.start(path);await frame();
    await command('buffer-end');await command('paragraph-break');
    const baseline=(await snapshot()).source;
    await choose('LaTeX While');
    const first=await snapshot();assert.match(first.source,/\\begin_inset Preview/);
    assert.match(first.source,/While\{/);assert.match(first.source,/usepackage\[noEnd=false\]\{algpseudocodex\}/);
    assert.equal(first.cursor.length,3,'The cursor edits raw LaTeX inside Preview and ERT');
    await command('undo');assert.equal((await snapshot()).source,baseline,'Insertion and preamble are one undo action');
    await command('redo');assert.equal((await snapshot()).source,first.source);
    await command('undo');await command('buffer-end');await choose('LaTeX While');

    // Insert a complete For block before EndWhile, using the env menu while in ERT.
    await command('inset-begin');for(let i=0;i<4;i++)await command('paragraph-down');await command('line-begin');
    await choose('LaTeX For');
    const nested=(await snapshot()).source;
    assert.match(nested,/For\{\$i=1/);assert.match(nested,/EndFor/);
    // A macro defined as a native FormulaMacro must also resolve in raw previews.
    await command('inset-begin');await command('paragraph-down');await command('paragraph-down');await command('line-begin');
    assert.equal((await snapshot()).cursor.length,3);
    await command('self-insert \\State $\\Dbf=0$');await command('paragraph-break');
    const sourceView=await frame();await writeFile(join(directory,'source.png'),Buffer.from(sourceView.surfaces.find(x=>x.main).png,'base64'));
    await choose('Render LaTeX Pseudocode');
    assert.equal((await snapshot()).cursor.length,1,'Rendering exits the source and Preview inset');

    let images=[];
    for(let i=0;i<100;i++){
      images=(await readdir(temporary,{recursive:true})).filter(name=>/lyxpreview.*\d+\.(png|ppm)$/.test(name));
      if(images.length)break;
      await new Promise(done=>setTimeout(done,300));
    }
    assert.ok(images.length,'The native LaTeX renderer produced a preview image');
    // File creation precedes the native loader's asynchronous completion callback.
    await new Promise(done=>setTimeout(done,1000));await session.call('state');
    const rendered=await frame();await writeFile(join(directory,'rendered.png'),Buffer.from(rendered.surfaces.find(x=>x.main).png,'base64'));
    await command('buffer-export pdflatex');
    for(let i=0;i<50;i++){
      if(await readFile(join(directory,'example.tex')).then(()=>true,()=>false))break;
      await new Promise(done=>setTimeout(done,100));
    }
    const tex=await readFile(join(directory,'example.tex'),'utf8');
    assert.match(tex,/\\While\{/);assert.match(tex,/\\For\{/);assert.match(tex,/\\State \$\\Dbf=0\$/);
    assert.ok(tex.indexOf('\\For{')<tex.indexOf('\\EndWhile'));
    execFileSync('/Library/TeX/texbin/pdflatex',['-interaction=nonstopmode','-halt-on-error','example.tex'],{cwd:directory,stdio:'pipe',timeout:30000});
    assert.ok((await readFile(join(directory,'example.pdf'))).length>1000);
    const log=await readFile(join(session.directory,'engine.log'),'utf8');
    assert.doesNotMatch(log,/ASSERTION|SIGSEGV|Undefined control sequence|ModuleNotFoundError/);
    assert.equal(await readFile(path,'utf8'),original,'Test edits never save over the source fixture');
    console.log(`Pseudocode evidence: ${directory}`);
  }finally{
    session.stop();if(oldProfile===undefined)delete process.env.LYX_USER_PROFILE;else process.env.LYX_USER_PROFILE=oldProfile;
  }
});

test('every standalone env template compiles in a new article', {timeout:120000},async()=>{
  const directory=await mkdtemp(resolve('.native/pseudocode-templates-'));
  const path=join(directory,'templates.lyx'),session=new NativeSession();
  await writeFile(path,String.raw`#LyX 2.4 created this file.
\lyxformat 620
\begin_document
\begin_header
\textclass article
\language english
\inputencoding utf8
\end_header
\begin_body
\begin_layout Standard
Standalone template compilation
\end_layout
\end_body
\end_document
`);
  const command=async command=>{
    const result=await session.call('command',{command});assert.ok(!result.error,result.message);
  };
  try{
    await session.start(path);
    await session.call('frame',{width:1000,height:900,serial:-1});
    for(const name of ['Pseudocode','While','For','For All','If / Else','Repeat / Until',
      'Function','Procedure','State','Return','Comment','Input / Output']){
      await command('buffer-end');await command('paragraph-break');
      await command(`layout LaTeX ${name}`);
      await command('layout Render LaTeX Pseudocode');
    }
    const snapshot=await session.call('selection');
    assert.equal(snapshot.source.split('\\begin_inset Preview').length-1,12);
    assert.equal(snapshot.source.split('usepackage[noEnd=false]{algpseudocodex}').length-1,1);
    await command('buffer-export pdflatex');
    for(let i=0;i<100;i++){
      if(await readFile(join(directory,'templates.tex')).then(()=>true,()=>false))break;
      await new Promise(done=>setTimeout(done,100));
    }
    execFileSync('/Library/TeX/texbin/pdflatex',['-interaction=nonstopmode','-halt-on-error','templates.tex'],
      {cwd:directory,stdio:'pipe',timeout:30000});
    assert.ok((await readFile(join(directory,'templates.pdf'))).length>1000);
  }finally{session.stop();}
});
