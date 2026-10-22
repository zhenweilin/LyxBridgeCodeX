import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,readFile,writeFile,mkdtemp,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {inflateSync} from 'node:zlib';
import {NativeSession} from '../lib/native-session.mjs';

// Decode the native Qt PNG with Node built-ins so cancellation can be checked
// against actual document pixels, ignoring only the blinking insertion caret.
function pixels(base64){
  const png=Buffer.from(base64,'base64'),chunks=[];
  let width,height,channels;
  assert.equal(png.subarray(1,4).toString(),'PNG');
  for(let offset=8;offset<png.length;){
    const length=png.readUInt32BE(offset),type=png.toString('ascii',offset+4,offset+8);
    const data=png.subarray(offset+8,offset+8+length);
    if(type==='IHDR'){
      width=data.readUInt32BE(0);height=data.readUInt32BE(4);
      assert.equal(data[8],8,'The native screenshot must use 8-bit pixels');
      assert.ok([2,6].includes(data[9]),`Unsupported Qt PNG color type ${data[9]}`);
      assert.equal(data[12],0,'The native screenshot must be noninterlaced');
      channels=data[9]===6?4:3;
    }else if(type==='IDAT')chunks.push(data);
    offset+=length+12;
  }
  const packed=inflateSync(Buffer.concat(chunks)),stride=width*channels;
  const data=Buffer.alloc(stride*height);
  const paeth=(a,b,c)=>{
    const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);
    return pa<=pb && pa<=pc?a:pb<=pc?b:c;
  };
  for(let y=0;y<height;y++){
    const filter=packed[y*(stride+1)];
    assert.ok(filter<=4,`Unsupported PNG filter ${filter}`);
    for(let x=0;x<stride;x++){
      const left=x>=channels?data[y*stride+x-channels]:0;
      const above=y?data[(y-1)*stride+x]:0;
      const upperLeft=y && x>=channels?data[(y-1)*stride+x-channels]:0;
      const prediction=[0,left,above,Math.floor((left+above)/2),paeth(left,above,upperLeft)][filter];
      data[y*stride+x]=(packed[y*(stride+1)+1+x]+prediction)&255;
    }
  }
  return {width,height,channels,data};
}

function textPixels(surface,rect,otherCarets=[],caretMargin=7){
  const image=pixels(surface.png),sx=image.width/surface.width,sy=image.height/surface.height;
  const x0=Math.max(0,Math.floor((rect.x-12)*sx));
  const x1=Math.min(image.width,Math.ceil((rect.x+220)*sx));
  const y0=Math.max(0,Math.floor((rect.y-8)*sy));
  const y1=Math.min(image.height,Math.ceil((rect.y+rect.height+12)*sy));
  const rows=[];
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
    if([rect,...otherCarets].some(caret=>Math.abs(x/sx-caret.x)<=caretMargin))continue;
    const offset=(y*image.width+x)*image.channels;
    rows.push(image.data.subarray(offset,offset+image.channels));
  }
  assert.ok(rows.length,'The caret must identify a visible document region');
  return Buffer.concat(rows);
}

test('native IME preedit, commit, focus and caret geometry preserve the live document', {timeout:120000},async()=>{
  const original=await readFile('demo/demo.lyx');
  await mkdir('.native',{recursive:true});
  const directory=await mkdtemp(resolve('.native/ime-integration-')),path=join(directory,'demo.lyx');
  await copyFile('demo/demo.lyx',path);
  const session=new NativeSession(),records=[];
  let size={width:1000,height:800};
  const snapshot=()=>session.call('selection');
  const frame=()=>session.call('frame',{...size,serial:-1});
  const command=async command=>{
    const result=await session.call('command',{command});
    assert.ok(!result.error,`${command}: ${result.message}`);
    return result;
  };
  const input=async params=>{
    const result=await session.call('input',params);
    assert.ok(!result.error,result.message);
    return session.call('state');
  };
  const key=async(key,text='',modifiers={})=>{
    await input({type:'keydown',key,text,...modifiers});
    return input({type:'keyup',key,text,...modifiers});
  };
  const compose=(text,attributes={})=>input({type:'composition',text,...attributes});
  const commit=text=>input({type:'commit',text});
  const paragraph=async text=>{
    await command('buffer-end');await command('paragraph-break');await command('layout Standard');
    if(text)await command(`self-insert ${text}`);
  };
  const unchanged=async before=>{
    const after=await snapshot();
    assert.equal(after.source,before.source,'Preedit must not change serialized native content');
    assert.equal(after.sourceRevision,before.sourceRevision);
    assert.equal(after.modified,before.modified);
    assert.deepEqual(after.clipboardSelection,before.clipboardSelection,'Preedit attributes must not move the document selection');
    return after;
  };
  const geometry=current=>{
    const ime=current.inputMethod;
    assert.equal(ime?.enabled,true,'The focused native editor must report an IME caret');
    const surface=current.surfaces.find(item=>item.id===ime.surface);
    assert.ok(surface,'The IME caret refers to a rendered surface');
    for(const field of ['x','y','width','height'])assert.ok(Number.isFinite(ime.rect[field]),field);
    assert.ok(ime.rect.width>0 && ime.rect.height>0);
    assert.ok(ime.rect.x>=0 && ime.rect.x<surface.width,JSON.stringify(ime));
    assert.ok(ime.rect.y>=0 && ime.rect.y+ime.rect.height<=surface.height+2,JSON.stringify(ime));
    return {surface,rect:ime.rect};
  };
  const saveFrame=async name=>{
    const current=await frame();
    for(const [index,surface] of current.surfaces.entries())
      await writeFile(join(directory,`${name}-${index}.png`),Buffer.from(surface.png,'base64'));
    records.push({name,inputMethod:current.inputMethod,cursor:current.cursor});
    return current;
  };
  try{
    await session.start(path);await frame();
    await command('buffer-end');
    const headingBefore=await snapshot();
    const headingBaseline=geometry(await saveFrame('heading-direct-before'));
    for(const text of [' ','a','b','c'])await commit(text);
    const headingPainted=geometry(await saveFrame('heading-direct-committed'));
    assert.match((await snapshot()).source,/Problem Setting abc/);
    assert.equal(headingPainted.rect.y,headingBaseline.rect.y);
    assert.ok(headingPainted.rect.x>headingBaseline.rect.x);
    assert.notDeepEqual(
      textPixels(headingPainted.surface,headingBaseline.rect,[headingPainted.rect],2),
      textPixels(headingBaseline.surface,headingBaseline.rect,[headingPainted.rect],2),
      'Plain commit in the existing heading must repaint its letters without a preedit or layout reset');
    await command('undo');
    assert.equal((await snapshot()).source,headingBefore.source);

    await paragraph('IME-DIRECT:');
    await command('undo');await command('redo');
    const directBefore=await snapshot();
    const directBaseline=geometry(await saveFrame('direct-before'));
    // Plain beforeinput/commit events have no earlier composition repaint.
    // Source and caret movement alone cannot prove the letters were painted.
    await commit('abc');
    const directAfter=await snapshot();
    assert.match(directAfter.source,/IME-DIRECT:abc/);
    assert.equal(directAfter.inputMethod.composing,false);
    const directPainted=geometry(await saveFrame('direct-committed'));
    assert.equal(directPainted.surface.id,directBaseline.surface.id);
    assert.equal(directPainted.rect.y,directBaseline.rect.y,'The short commit stays on the same native line');
    assert.ok(directPainted.rect.x>directBaseline.rect.x,'The native insertion caret advances after commit');
    assert.notDeepEqual(
      textPixels(directPainted.surface,directBaseline.rect,[directPainted.rect]),
      textPixels(directBaseline.surface,directBaseline.rect,[directPainted.rect]),
      'Plain commit must paint the new letters; ignore both old and new caret pixels');
    let previousPaint=directPainted,expectedDirect='IME-DIRECT:abc';
    for(const letter of ['d','e','f']){
      await commit(letter);expectedDirect+=letter;
      assert.ok((await snapshot()).source.includes(expectedDirect));
      const painted=geometry(await saveFrame(`direct-character-${letter}`));
      assert.equal(painted.rect.y,previousPaint.rect.y);
      assert.ok(painted.rect.x>previousPaint.rect.x);
      assert.notDeepEqual(
        textPixels(painted.surface,previousPaint.rect,[painted.rect],2),
        textPixels(previousPaint.surface,previousPaint.rect,[painted.rect],2),
        `Plain single-character commit ${letter} must repaint glyphs, not only move its caret`);
      previousPaint=painted;
    }
    // LyX may group consecutive typing. Undo only as far as the exact baseline.
    let directRestored=await snapshot();
    for(let count=0;directRestored.source!==directBefore.source && count<4;count++){
      await command('undo');directRestored=await snapshot();
    }
    assert.equal(directRestored.source,directBefore.source);

    await paragraph('IME-BODY:');
    // Finish preparation's native undo group without changing the final buffer.
    const prepared=(await snapshot()).source;
    await command('undo');await command('redo');
    assert.equal((await snapshot()).source,prepared);
    const before=await snapshot(),base=await saveFrame('body-before');
    const caret=geometry(base),baselinePixels=textPixels(caret.surface,caret.rect);
    for(const text of ['n','ni','nihao']){
      const pending=await compose(text,{cursor:text.length});
      assert.equal(pending.inputPending,false);
      assert.equal(pending.inputMethod.composing,true);
      await unchanged(before);
    }
    await compose('nihao',{cursor:2,selection:{start:2,length:3}});
    await unchanged(before);
    const preview=await saveFrame('body-preedit');
    geometry(preview);
    assert.notDeepEqual(textPixels(preview.surfaces.find(item=>item.id===caret.surface.id),caret.rect),baselinePixels,
      'Uncommitted pinyin is painted by native LyX');
    const cancelled=await compose('');
    assert.equal(cancelled.inputMethod.composing,false);
    await unchanged(before);
    const cleared=await saveFrame('body-cancelled');
    assert.deepEqual(textPixels(cleared.surfaces.find(item=>item.id===caret.surface.id),caret.rect),baselinePixels,
      'Cancelling removes native preedit pixels and restores the document, apart from caret blinking');

    await compose('nihao',{cursor:5});await commit('你好');
    const first=await snapshot();
    assert.match(first.source,/IME-BODY:你好/);
    assert.equal(first.source.split('你好').length,before.source.split('你好').length+1,'One commit inserts the chosen word once');
    assert.equal(first.inputMethod.composing,false);
    await command('undo');
    assert.equal((await snapshot()).source,before.source,'A native undo restores the state before one IME commit');
    await command('redo');
    for(const [pinyin,word] of [['shijie','世界'],['ceshi','测试']]){
      const start=await snapshot();
      for(let length=1;length<=pinyin.length;length++){
        await compose(pinyin.slice(0,length),{cursor:length});
        await unchanged(start);
      }
      await commit(word);
    }
    const consecutive=await snapshot();
    assert.equal(consecutive.source.split('你好世界测试').length,2,'Consecutive candidate choices append exactly once');
    let restored=consecutive,undoCount=0;
    while(restored.source!==before.source && undoCount<3){await command('undo');undoCount++;restored=await snapshot();}
    assert.equal(restored.source,before.source,'Native undo may merge consecutive commits, but must restore all of them without losing earlier text');
    records.push({name:'consecutive-commits',undoCount});

    await paragraph('Guarded original words');await command('line-begin-select');
    const selected=await snapshot();
    const replacement={action:'replace-selection',path:selected.path,sourceRevision:selected.sourceRevision,
      selection:selected.clipboardSelection,replacement:{format:'text',text:'Guarded replacement words'}};
    await compose('nihao',{cursor:5});
    const composing=await unchanged(selected);
    assert.equal(composing.inputPending,false,'The persistent guard is tested after Qt input delivery has finished');
    assert.equal(composing.inputMethod.composing,true);
    const rejected=await session.call('clipboard',replacement);
    assert.equal(rejected.error,true);assert.equal(rejected.code,'input_pending');
    assert.notEqual(rejected.applied,true);
    await unchanged(selected);
    await compose('');
    const applied=await session.call('clipboard',replacement);
    assert.equal(applied.applied,true,'Cancelling preedit must permit the unchanged exact-selection edit');
    await command('undo');
    assert.equal((await snapshot()).source,selected.source,'Preedit rejection and cancellation add no undo entries');

    await paragraph();await key(77,'m',{meta:true});await key(88,'x');await key(94,'^',{shift:true});
    const mathBefore=await snapshot();
    assert.ok(mathBefore.selectionStart.length>=3,'The caret is inside a native superscript');
    const mathCaret=geometry(await saveFrame('math-before'));
    await compose('san',{cursor:3});await unchanged(mathBefore);
    geometry(await saveFrame('math-preedit'));
    await compose('');await unchanged(mathBefore);
    await compose('san',{cursor:3});await commit('3');
    assert.match((await snapshot()).source,/\\begin_inset Formula \$x\^\{3\}\$/);
    await key(52,'4');
    assert.match((await snapshot()).source,/\\begin_inset Formula \$x\^\{34\}\$/,'Typing continues in native math after IME commit');
    records.push({name:'math-caret',rect:mathCaret.rect});

    await command('buffer-end');
    const document=await snapshot();
    await session.call('dispatch',{command:'dialog-show findreplace'});
    await key(65,'a',{meta:true});await commit('IME search ');
    const fieldBefore=await snapshot(),fieldFrame=await saveFrame('widget-before');
    assert.equal(fieldBefore.clipboardSelection.kind,'widget');
    const fieldCaret=geometry(fieldFrame);
    await compose('zhongwen',{cursor:8});
    const fieldPreview=await snapshot();
    assert.equal(fieldPreview.source,document.source,'Widget preedit must not edit the document');
    assert.equal(fieldPreview.inputMethod.composing,true);
    geometry(await saveFrame('widget-preedit'));
    await compose('');
    assert.equal((await snapshot()).source,document.source);
    await compose('zhongwen',{cursor:8});await commit('中文');await key(65,'a',{meta:true});
    assert.equal((await snapshot()).clipboardSelection.text,'IME search 中文');
    assert.equal((await snapshot()).source,document.source,'Widget commit must not edit the document');
    records.push({name:'widget-caret',surface:fieldCaret.surface.id,rect:fieldCaret.rect});
    await key(0x1000000);
    assert.equal((await snapshot()).clipboardSelection.kind,'document');

    await paragraph('A long IME caret paragraph with wrapping words. '.repeat(18));
    await command('buffer-zoom 100');
    const longSource=(await snapshot()).source;
    await command('paragraph-up');
    const lineStart=geometry(await saveFrame('long-begin')).rect;
    await command('buffer-end');
    const lineEnd=geometry(await saveFrame('long-end')).rect;
    assert.notDeepEqual(lineEnd,lineStart,'The caret follows movement across wrapped native lines');
    size={width:640,height:800};
    const narrow=geometry(await saveFrame('long-narrow')).rect;
    assert.notDeepEqual(narrow,lineEnd,'The current caret is recomputed after native viewport reflow');
    await command('buffer-zoom 150');
    const zoomed=geometry(await saveFrame('long-zoomed')).rect;
    assert.ok(zoomed.height>narrow.height,'Native font zoom changes the reported caret height');
    assert.equal((await snapshot()).source,longSource,'Reflow and font zoom must not edit source');
    await compose('changdu',{cursor:7});
    geometry(await saveFrame('long-preedit'));
    await compose('');
    assert.equal((await snapshot()).source,longSource);
    assert.equal((await snapshot()).inputMethod.composing,false);
    assert.deepEqual(await readFile(path),original,'IME tests do not save the disposable document');
    assert.deepEqual(await readFile('demo/demo.lyx'),original,'The supplied demo remains byte-identical');
    await writeFile(join(directory,'results.json'),JSON.stringify(records,null,2)+'\n');
    console.log(`Native IME evidence: ${directory}`);
  }finally{session.stop();}
});
