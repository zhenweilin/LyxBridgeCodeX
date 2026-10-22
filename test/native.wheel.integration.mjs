import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {NativeSession} from '../lib/native-session.mjs';
import {normalizeNativeWheel,nativeWheelQueueOptions} from '../web/native-wheel.mjs';
import {createNativeInputQueue} from '../web/native-input-queue.mjs';

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

function documentPixels(frame){
  const surface=frame.surfaces.find(item=>item.main),image=pixels(surface.png),rows=[];
  const sx=image.width/surface.width,sy=image.height/surface.height;
  // Fixed document crop excludes chrome and the caret's narrow x band.
  for(let y=Math.ceil(110*sy);y<Math.floor(350*sy);y++)
    for(const [left,right] of [[45,190],[210,600]])
      rows.push(image.data.subarray((y*image.width+Math.ceil(left*sx))*image.channels,
        (y*image.width+Math.floor(right*sx))*image.channels));
  return Buffer.concat(rows);
}

for(const speed of [1,2])test(`browser wheel units and pinch use native metrics at wheel speed ${speed} without editing source`,{timeout:120000},async()=>{
  const directory=await mkdtemp(resolve('.native/wheel-integration-')),path=join(directory,'demo.lyx');
  const original=await readFile('demo/demo.lyx');
  // Keep the supplied demo's document configuration in this disposable fixture.
  // Use a long plain-text body so scroll limits and clickable ERT/inset headers
  // cannot conceal the unit conversion or change layout during viewport probes.
  const paragraphs=Array.from({length:80},(_,index)=>`\\begin_layout Standard\nWheel fixture paragraph ${index+1}: enough document content to measure pixel, line and page scrolling.\n\\end_layout\n`).join('\n');
  const fixture=original.toString().replace(/\\begin_body[\s\S]*\\end_body/,`\\begin_body\n${paragraphs}\n\\end_body`);
  assert.notEqual(fixture,original.toString());
  await writeFile(path,fixture);
  const profile=join(directory,'profile');await mkdir(profile);
  await writeFile(join(profile,'preferences'),`\\mouse_wheel_speed ${speed}\n\\scroll_wheel_zoom alt\n\\cursor_follows_scrollbar false\n`);
  const session=new NativeSession(),records=[];
  const oldProfile=process.env.LYX_USER_PROFILE;
  const command=async command=>{
    const result=await session.call('command',{command});
    assert.ok(!result.error,`${command}: ${result.message}`);
  };
  const frame=()=>session.call('frame',{width:1000,height:400,serial:-1});
  let surface;
  const wheel=async(deltaY,deltaMode=0,extra={},scale=1)=>{
    const payload=normalizeNativeWheel({deltaX:0,deltaY,deltaMode,clientX:200*scale,clientY:200*scale,...extra},
      {surface,bounds:{left:0,top:0},scale});
    assert.ok(payload);
    await session.call('input',payload);await session.call('state');
    return payload;
  };
  const reset=async()=>{
    await command('buffer-zoom 100');await command('buffer-end');await command('buffer-begin');
    await frame();
    // Put the caret well inside the visible plain text. Its actual y remains
    // meaningful for the bounded pixel/line checks after scrolling upward.
    for(const type of ['pointerdown','pointerup']){
      await session.call('input',{type,surface,x:200,y:280,button:0,buttons:type==='pointerdown'?1:0});
      await session.call('state');
    }
    return frame();
  };
  const y=value=>value.inputMethod.rect.y;
  const measure=async(name,operation)=>{
    const before=await reset();await operation();const after=await frame();
    if(/native.*(notch|step)|browser.*(lines|page)/.test(name))
      await writeFile(join(directory,`${records.length}-${name.replaceAll(/[^a-zA-Z0-9]+/g,'-')}.png`),Buffer.from(after.surfaces.find(item=>item.main).png,'base64'));
    const rendered=documentPixels(after);
    const snapshot=await session.call('selection');
    assert.equal(snapshot.source,baseline.source,`${name}: source unchanged`);
    assert.equal(snapshot.modified,false,`${name}: scroll/zoom must not dirty the buffer`);
    records.push({name,before:before.inputMethod.rect,after:after.inputMethod.rect,distance:y(before)-y(after),imageHash:createHash('sha256').update(rendered).digest('hex')});
    return {before,after,distance:y(before)-y(after),rendered};
  };
  let baseline;
  try{
    process.env.LYX_USER_PROFILE=profile;
    try{await session.start(path);}finally{
      if(oldProfile===undefined)delete process.env.LYX_USER_PROFILE;else process.env.LYX_USER_PROFILE=oldProfile;
    }
    surface=(await frame()).surfaces[0].id;baseline=await session.call('selection');
    const pixels=await measure('40 pixels',()=>wheel(40));
    assert.equal(pixels.distance,40*speed,'Pixel distance respects the native wheel-speed preference');
    const merged=await measure('coalesced 320 fractional pixels',async()=>{
      const nativeSurface=(await frame()).surfaces.find(item=>item.id===surface);
      const {enqueue}=createNativeInputQueue();let release;const waiting=new Promise(resolve=>release=resolve);
      const active=enqueue(()=>waiting),tasks=[];let calls=0;
      for(let i=0;i<320;i++){
        const data=normalizeNativeWheel({deltaX:0,deltaY:.125,deltaMode:0,clientX:200,clientY:200},
          {surface,bounds:{left:0,top:0}});
        const {coalesceKey,mergeParams}=nativeWheelQueueOptions(data,nativeSurface);
        assert.ok(coalesceKey,'The real frame must identify the document viewport');
        tasks.push(enqueue(async input=>{calls++;await session.call('input',input);await session.call('state');},
          {coalesceKey,data,merge:mergeParams}));
      }
      release();await Promise.all([active,...tasks]);assert.equal(calls,1);
    });
    assert.equal(merged.distance,pixels.distance);
    assert.deepEqual(merged.rendered,pixels.rendered,'Coalescing must retain the exact native scroll position');
    const fractional=await measure('ten fractional pixel events',async()=>{for(let i=0;i<10;i++)await wheel(.1);});
    assert.equal(fractional.distance,speed,'Subpixel deltas accumulate instead of vanishing');
    const reversed=await measure('opposite pixel directions',async()=>{await wheel(40);await wheel(-15);});
    assert.equal(reversed.distance,25*speed);
    const scaled=await measure('pixel input at half panel scale',()=>wheel(10,0,{},.5));
    assert.equal(scaled.distance,20*speed,'CSS pixels are mapped to native pixels at panel scale');
    const nativeLine=await measure('native wheel notch',async()=>{
      await session.call('input',{type:'wheel',surface,x:200,y:200,dx:0,dy:0,ax:0,ay:-120});
      await session.call('state');
    });
    const lines=await measure('browser 3 lines',()=>wheel(3,1));
    assert.ok(nativeLine.distance>3);assert.deepEqual(lines.rendered,nativeLine.rendered,
      'Three browser lines match the actual native wheel notch at the configured speed');
    const nativePage=await measure('native scrollbar page step',async()=>{
      // In the captured 1000x400 Fusion surface, the right scrollbar track at
      // (990,340) is below its initial thumb. A complete click invokes Qt's
      // native single page-step action. LFUN scroll page uses a different
      // BufferView path (9px different in this fixture), so it is not an oracle.
      for(const type of ['pointerdown','pointerup']){
        await session.call('input',{type,surface,x:990,y:340,button:0,buttons:type==='pointerdown'?1:0});
        await session.call('state');
      }
    });
    const page=await measure(`browser ${1/speed} page at wheel speed ${speed}`,()=>wheel(1/speed,2));
    assert.notDeepEqual(nativePage.rendered,nativeLine.rendered,'Native page and line scrolls reach different text');
    assert.deepEqual(page.rendered,nativePage.rendered,'Page units match native scrollbar rendering exactly');
    const horizontal=await measure('horizontal document wheel',()=>wheel(0,0,{deltaX:40}));
    assert.equal(horizontal.distance,0,'LyX ignores horizontal-dominant document wheels');
    const zoom=await measure('browser Ctrl pixel-wheel zoom',()=>wheel(-40,0,{ctrlKey:true}));
    assert.ok(zoom.after.inputMethod.rect.height>zoom.before.inputMethod.rect.height,
      'Browser zoom intent must change native font scale, even with Alt configured for modifier-wheel zoom');
    const legacyModifier=await measure('native Alt wheel zoom',async()=>{
      await session.call('input',{type:'wheel',surface,x:200,y:200,dx:0,dy:0,ax:0,ay:120,alt:true});
      await session.call('state');
    });
    const normalizedModifier=await measure('normalized Alt line-wheel zoom',()=>wheel(-3,1,{altKey:true}));
    assert.deepEqual(normalizedModifier.after.inputMethod.rect,legacyModifier.after.inputMethod.rect,
      'Configured native modifier-wheel zoom keeps its original behavior');
    if(speed===1){
      const beforeDialog=await reset();
      const opening=await session.call('dispatch',{command:'file-open'});
      assert.ok(!opening.error,opening.message);
      let dialogFrame,dialog;
      for(let attempt=0;attempt<40;attempt++){
        dialogFrame=await frame();dialog=dialogFrame.surfaces.find(item=>!item.main && /FileDialog/.test(item.type));
        if(dialog)break;
        await new Promise(resolveWait=>setTimeout(resolveWait,25));
      }
      assert.ok(dialog,'A real native file dialog must open');
      await writeFile(join(directory,'file-dialog.png'),Buffer.from(dialog.png,'base64'));
      // The central file-list region belongs to the dialog's native window,
      // even when that window's QObject parent is the document work area.
      for(const ctrlKey of [false,true]){
        const input=normalizeNativeWheel({deltaX:0,deltaY:-40,deltaMode:0,clientX:dialog.width/2,clientY:dialog.height/2,ctrlKey},
          {surface:dialog.id,bounds:{left:0,top:0},scale:1});
        await session.call('input',input);await session.call('state');
      }
      await session.call('input',{type:'keydown',key:0x1000000});await session.call('state');
      await session.call('input',{type:'keyup',key:0x1000000});await session.call('state');
      const afterDialog=await frame();
      assert.equal(afterDialog.surfaces.length,1,'Escape closes the isolated file dialog');
      assert.deepEqual(afterDialog.inputMethod.rect,beforeDialog.inputMethod.rect,
        'Wheel and browser zoom over a file dialog must not scroll or zoom the underlying document');
      assert.equal((await session.call('selection')).source,baseline.source);
      records.push({name:'file-dialog wheel isolation',before:beforeDialog.inputMethod.rect,after:afterDialog.inputMethod.rect});
    }
    await reset();
    await wheel(-1e6,0,{ctrlKey:true});const max=await frame();
    await wheel(-1e6,0,{ctrlKey:true});const maxAgain=await frame();
    assert.deepEqual(maxAgain.inputMethod.rect,max.inputMethod.rect,'LyX clamps repeated zoom-in to its native maximum');
    // A maximum zoom can require several multiplicative steps to reach the
    // native minimum; the browser intentionally bounds each gesture's factor.
    for(let i=0;i<3;i++)await wheel(1e6,0,{ctrlKey:true});
    const min=await frame();
    await wheel(1e6,0,{ctrlKey:true});const minAgain=await frame();
    assert.deepEqual(minAgain.inputMethod.rect,min.inputMethod.rect,'LyX clamps repeated zoom-out to its native minimum');
    assert.ok(max.inputMethod.rect.height>min.inputMethod.rect.height);
    records.push({name:'native zoom limits',maximum:max.inputMethod.rect,minimum:min.inputMethod.rect});
    const final=await session.call('selection');assert.equal(final.source,baseline.source);assert.equal(final.modified,false);
    assert.equal(await readFile(path,'utf8'),fixture);assert.deepEqual(await readFile('demo/demo.lyx'),original);
    await writeFile(join(directory,'zoom-maximum.png'),Buffer.from(max.surfaces[0].png,'base64'));
    await writeFile(join(directory,'zoom-minimum.png'),Buffer.from(min.surfaces[0].png,'base64'));
  }finally{
    await writeFile(join(directory,'results.json'),JSON.stringify(records,null,2)+'\n');
    console.log(`Native wheel evidence: ${directory}`);
    const child=session.process,closed=child?.exitCode===null && child?.signalCode===null
      ?new Promise(resolveClosed=>child.once('close',resolveClosed)):Promise.resolve();
    session.stop();
    const timer=setTimeout(()=>{if(child?.exitCode===null&&child?.signalCode===null)child.kill('SIGKILL');},1000);
    await closed;clearTimeout(timer);
  }
});
