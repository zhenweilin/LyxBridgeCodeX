import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,readFile,writeFile,mkdtemp,mkdir,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {NativeSession} from '../lib/native-session.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('native file dialogs keep their own IME surface while opening, canceling and saving files', {timeout:90000}, async()=>{
  const original=await readFile('demo/demo.lyx');
  await mkdir('.native',{recursive:true});
  const directory=await mkdtemp(resolve('.native/dialog-integration-'));
  const a=join(directory,'document A.lyx'),b=join(directory,'document B.lyx');
  const c=join(directory,'saved 文档.lyx'),cancelled=join(directory,'never saved.lyx');
  await copyFile('demo/demo.lyx',a);
  const secondSource=original.toString().replace('Problem Setting','Opened Dialog Fixture');
  assert.notEqual(secondSource,original.toString());
  await writeFile(b,secondSource);
  const session=new NativeSession(),records=[];
  const frame=()=>session.call('frame',{width:600,height:700,serial:-1});
  const snapshot=()=>session.call('selection');
  const input=async params=>{
    const result=await session.call('input',params);
    assert.ok(!result.error,result.message);
    return session.call('state');
  };
  const key=async(key,text='',modifiers={})=>{
    await input({type:'keydown',key,text,...modifiers});
    return input({type:'keyup',key,text,...modifiers});
  };
  const eventually=async(callback,predicate,message)=>{
    for(let attempt=0;attempt<50;attempt++){
      const result=await callback();
      if(predicate(result))return result;
      await delay(20);
    }
    assert.fail(message);
  };
  const record=async(name,current)=>{
    records.push({name,inputMethod:current.inputMethod,
      surfaces:current.surfaces.map(({png,...surface})=>surface)});
    for(const [index,surface] of current.surfaces.entries())
      await writeFile(join(directory,`${name}-${index}.png`),Buffer.from(surface.png,'base64'));
  };
  const openDialog=async(command,name)=>{
    const before=await snapshot();
    const dispatched=typeof command==='function'?await command():await session.call('dispatch',{command});
    assert.ok(!dispatched.error,dispatched.message);
    const current=await eventually(frame,
      value=>value.surfaces?.some(surface=>!surface.main && /FileDialog/.test(surface.type)),
      `${command} must open its actual native file chooser`);
    const dialog=current.surfaces.find(surface=>!surface.main && /FileDialog/.test(surface.type));
    assert.equal(current.inputMethod?.enabled,true,'The native filename field supports IME input');
    assert.equal(current.inputMethod.surface,dialog.id,'Filename caret belongs to the file dialog, not its document owner');
    const rect=current.inputMethod.rect;
    assert.ok(rect.width>0 && rect.height>0);
    assert.ok(rect.x>=0 && rect.x+rect.width<=dialog.width);
    assert.ok(rect.y>=0 && rect.y+rect.height<=dialog.height);
    // Normal frame/state polling previously crashed in mapTo() because the
    // QFileDialog owner was mistaken for the filename field's editor.
    for(let i=0;i<3;i++){
      const state=await session.call('state');
      assert.equal(state.inputMethod.surface,dialog.id);
      assert.equal((await frame()).inputMethod.surface,dialog.id);
    }
    assert.equal((await snapshot()).source,before.source);
    await record(name,current);
    return {before,dialog};
  };
  const filename=async path=>{
    await key('A'.codePointAt(0),'a',{meta:true});
    await input({type:'commit',text:path});
    const state=await key('A'.codePointAt(0),'a',{meta:true});
    assert.equal(state.clipboardSelection.kind,'widget');
    assert.equal(state.clipboardSelection.text,path,'Text input changes the native filename field');
    // QFileDialog can show its native completion popup for an existing path.
    // Escape dismisses that popup first, before the actual file chooser.
    const current=await frame();
    if(current.surfaces.some(surface=>!surface.main && surface.type==='QListView')){
      await key(0x1000000);
      assert.ok((await frame()).surfaces.some(surface=>/FileDialog/.test(surface.type)));
    }
  };
  const cancelDialog=async()=>{
    await key(0x1000000);
    await eventually(frame,value=>value.surfaces.length===1,'Escape must dismiss the file chooser');
  };
  const stopSession=async()=>{
    // Only this test's disposable engine may be terminated. A regression can
    // leave LyX inside its crash-alert event loop, which ignores SIGTERM.
    session.stop();
    if(session.process && !session.exited){
      await Promise.race([new Promise(resolve=>session.process.once('exit',resolve)),delay(500)]);
      if(!session.exited)session.process.kill('SIGKILL');
    }
  };
  try{
    await session.start(a);await frame();
    const initial=await snapshot();
    const opening=await openDialog('file-open','open-cancel');
    await input({type:'composition',text:'文😀',cursor:3,selection:{start:1,length:2}});
    const preedit=await snapshot();
    assert.equal(preedit.source,initial.source,'Filename preedit never changes the document');
    assert.equal(preedit.inputMethod.composing,true);
    assert.equal(preedit.inputMethod.surface,opening.dialog.id);
    await input({type:'composition',text:''});
    await filename(b);await cancelDialog();
    assert.equal((await snapshot()).path,a);
    assert.equal((await snapshot()).source,initial.source);

    await openDialog('file-open','open-accept');
    await filename(b);await key(0x1000004);
    const opened=await eventually(snapshot,value=>value.path===b,'Enter must open the selected temporary file');
    assert.ok(opened.source.includes('Opened Dialog Fixture'));
    assert.equal(opened.modified,false);

    await openDialog('buffer-write-as','save-as-cancel');
    await filename(cancelled);await cancelDialog();
    assert.equal((await snapshot()).path,b,'Escape keyup must not focus the first document tab');
    assert.equal((await snapshot()).source,opened.source);
    await assert.rejects(access(cancelled),{code:'ENOENT'});

    const pointerCancel=await openDialog('buffer-write-as','save-as-pointer-cancel');
    // The private Fusion file chooser's Cancel button is at its bottom right.
    // Use actual native pointer input, then make a shortcut the first keyboard
    // event after the dialog closes with no focused Qt window.
    const {dialog}=pointerCancel;
    for(const type of ['pointerdown','pointerup'])await input({type,surface:dialog.id,
      x:dialog.width-50,y:dialog.height-26,button:0,buttons:type==='pointerdown'?1:0});
    await eventually(frame,value=>value.surfaces.length===1,'Clicking Cancel must dismiss the file chooser');
    assert.equal((await snapshot()).path,b);
    await openDialog(()=>key('S'.codePointAt(0),'S',{meta:true,shift:true}),'save-as-accept');
    assert.equal((await snapshot()).path,b,'The first shortcut after pointer Cancel must remain in document B');
    await filename(c);await key(0x1000004);
    const saved=await eventually(snapshot,value=>value.path===c && !value.modified,
      'Enter must save to the new Unicode filename');
    assert.ok(saved.source.includes('Opened Dialog Fixture'));
    assert.ok((await readFile(c,'utf8')).includes('Opened Dialog Fixture'));
    assert.deepEqual(await readFile(a),original);
    assert.equal(await readFile(b,'utf8'),secondSource);
    assert.deepEqual(await readFile('demo/demo.lyx'),original);
  }finally{
    await writeFile(join(directory,'records.json'),JSON.stringify(records,null,2));
    console.log(`Native dialog evidence: ${directory}`);
    await stopSession();
  }
});
