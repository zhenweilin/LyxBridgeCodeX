import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {copyNativeClipboardWithGesture,completeNativeMenuClipboard,createNativeMenuClipboardGesture,createNativeMenuClipboard} from '../web/native-menu-clipboard.mjs';
import {encodeClipboardText,readBrowserClipboard} from '../web/native-clipboard.mjs';

function browser({accepted=true,dispatch=true}={}) {
  const listeners=new Map(),values=new Map(),elements=[];
  let removed=false,restored=false;
  const doc={
    activeElement:{focus(){restored=true;}},
    body:{append(){},insertBefore(){}},
    querySelector(){return {};},
    getElementById(){return {focus(){}};},
    createElement(tag){
      const element={tag,style:{},children:[],listeners:new Map(),setAttribute(){},focus(){},select(){},remove(){removed=true;},
        append(...children){this.children.push(...children);},addEventListener(name,fn){this.listeners.set(name,fn);}};
      elements.push(element);return element;
    },
    addEventListener(name,fn){listeners.set(name,fn);},
    removeEventListener(name){listeners.delete(name);},
    execCommand(command){
      assert.equal(command,'copy');
      if(dispatch)listeners.get('copy')?.({preventDefault(){},stopImmediatePropagation(){},clipboardData:{setData:(type,value)=>values.set(type,value)}});
      return accepted;
    },
  };
  return {doc,values,elements,clean:()=>removed&&restored&&listeners.size===0};
}
const clipboard={text:'Formula x²\nSecond paragraph',formats:{
  'application/x-lyx':encodeClipboardText('\\begin_inset Formula $x^{2}$\n\\end_inset'),
  'text/plain':encodeClipboardText('Formula x²\nSecond paragraph'),
}};

test('menu clipboard click transfers native MIME and cleans its temporary focus',()=>{
  const fake=browser();
  const result=copyNativeClipboardWithGesture(clipboard,{document:fake.doc,crypto:{randomUUID}});
  const pasted=readBrowserClipboard({getData:type=>fake.values.get(type)??''});
  assert.equal(pasted.copyId,result.copyId);
  assert.deepEqual(pasted.formats,clipboard.formats);
  assert.equal(fake.values.get('text/plain'),clipboard.text);
  assert.ok(fake.clean());
});

for(const scenario of [{accepted:false},{dispatch:false}]) {
  test(`native menu Cut is not committed when browser copy fails: ${JSON.stringify(scenario)}`,async()=>{
    const fake=browser(scenario);let committed=false;
    await assert.rejects(completeNativeMenuClipboard({id:'cut-request',action:'cut',clipboard},{
      writeClipboard:value=>copyNativeClipboardWithGesture(value,{document:fake.doc,crypto:{randomUUID}}),
      rpc:()=>{committed=true;},
    }),/did not allow/);
    assert.equal(committed,false);
    assert.ok(fake.clean());
  });
}

test('menu Cut acknowledges only after clipboard write and reports uncertain RPC outcomes',async()=>{
  const calls=[];
  await assert.rejects(completeNativeMenuClipboard({id:'cut-request',action:'cut',clipboard},{
    writeClipboard:value=>{assert.equal(value,clipboard);calls.push('write');},
    rpc:async(method,params)=>{calls.push('commit');assert.equal(method,'clipboard');assert.deepEqual(params,{action:'menu-commit',requestId:'cut-request'});throw new Error('connection closed');},
  }),error=>error.message==='connection closed'&&error.clipboardWritten===true);
  assert.deepEqual(calls,['write','commit']);
});

const origin={ready:true,path:'/tmp/example.lyx',clipboardSelection:{kind:'document',hasSelection:true,text:'Formula x²',
  start:[{pit:0,pos:0}],end:[{pit:0,pos:10}]}};
const nativeClipboard={...clipboard,origin};
const clone=value=>structuredClone(value);
function popup(action='cut') {
  return {id:'menu',main:false,isMenu:true,type:'lyx::frontend::Menu',menuActions:[{clipboardAction:action,text:'A translated menu label',enabled:true,separator:false,x:0,y:20,width:160,height:24}]};
}
function pointer(type, overrides={}) {
  return {type,surface:'menu',pointerId:7,x:60,y:30,button:0,buttons:type==='pointerdown'?1:0,...overrides};
}
function pending(action='cut',id='fresh-request') {
  return {...clone(origin),menuClipboard:{id,action,clipboard:clone(nativeClipboard)}};
}
function pressAndRelease(controller,{state=origin,surface=popup(),up={},upContext={}}={}) {
  controller.handlePointer(pointer('pointerdown'),{state,surface});
  return controller.handlePointer(pointer('pointerup',up),{state,surface,...upContext});
}

for (const action of ['copy','cut']) {
  test(`native menu ${action} writes inside pointerup, then commits only its correlated native result`,async()=>{
    const fake=browser(),calls=[];
    let inPointerUp=false;
    const controller=createNativeMenuClipboard({document:fake.doc,notice(){},
      writeClipboard:value=>{
        assert.equal(inPointerUp,true,'Clipboard write cannot wait for an RPC or polling callback');
        calls.push('write');
        return copyNativeClipboardWithGesture(value,{document:fake.doc,crypto:{randomUUID}});
      },rpc:async(method,params)=>{calls.push('commit');assert.equal(method,'clipboard');assert.deepEqual(params,{action:'menu-commit',requestId:'fresh-request'});},
    });
    assert.equal(controller.prepare(origin,nativeClipboard),true);
    controller.handlePointer(pointer('pointerdown'),{surface:popup(action),state:origin});
    assert.deepEqual(calls,[]);
    inPointerUp=true;
    const receipt=controller.handlePointer(pointer('pointerup'),{surface:popup(action),state:origin});
    inPointerUp=false;
    assert.ok(receipt);
    assert.deepEqual(calls,['write']);
    const state=pending(action);
    assert.equal(await controller.update(state),false,'Polling alone cannot commit');
    assert.equal(fake.elements.find(item=>item.tag==='aside').hidden,false);
    assert.equal(await controller.update(state,{receipt}),true);
    assert.deepEqual(calls,['write','commit']);
    assert.equal(fake.elements.find(item=>item.tag==='aside').hidden,true);
    assert.equal(await controller.update(state,{receipt}),false,'A receipt cannot commit twice');
    assert.deepEqual(calls,['write','commit']);
    assert.deepEqual(readBrowserClipboard({getData:type=>fake.values.get(type)??''}).formats,clipboard.formats);
    controller.destroy();
  });
}

test('prepared menu snapshots are independent of mutable selection caches and retain all MIME bytes',()=>{
  const input=clone(nativeClipboard);let written;
  input.formats['text/html']=encodeClipboardText('<p>Formula x²</p>');
  const expected=clone(input);
  const gesture=createNativeMenuClipboardGesture({writeClipboard:value=>{written=value;}});
  assert.equal(gesture.prepare(origin,input),true);
  input.text='Changed cache';input.formats['application/x-lyx']='';input.origin.path='/tmp/other.lyx';
  const receipt=pressAndRelease(gesture);
  assert.equal(written.text,expected.text);
  assert.deepEqual(written.formats,expected.formats);
  const state=pending();state.menuClipboard.clipboard=expected;
  assert.equal(gesture.takeMatchingRequest(state,receipt).id,'fresh-request');
});

const mismatches={
  'action':state=>{state.menuClipboard.action='copy';},
  'current path':state=>{state.path='/tmp/other.lyx';},
  'current selection':state=>{state.clipboardSelection.end[0].pos++;},
  'origin path':state=>{state.menuClipboard.clipboard.origin.path='/tmp/other.lyx';},
  'origin selection':state=>{state.menuClipboard.clipboard.origin.clipboardSelection.start[0].pos++;},
  'native MIME bytes':state=>{state.menuClipboard.clipboard.formats['application/x-lyx']=encodeClipboardText('different formula');},
  'extra allowed MIME format':state=>{state.menuClipboard.clipboard.formats['text/html']=encodeClipboardText('<p>Changed</p>');},
  'missing MIME format':state=>{delete state.menuClipboard.clipboard.formats['text/plain'];},
  'clipboard text':state=>{state.menuClipboard.clipboard.text+=' changed';},
  'missing native request':state=>{delete state.menuClipboard;},
};
for (const [name,mutate] of Object.entries(mismatches)) {
  test(`menu gesture never commits with mismatched ${name}`,()=>{
    let writes=0;
    const gesture=createNativeMenuClipboardGesture({writeClipboard:()=>{writes++;}});
    gesture.prepare(origin,nativeClipboard);
    const receipt=pressAndRelease(gesture),state=pending();
    mutate(state);
    assert.equal(writes,1);
    assert.equal(gesture.takeMatchingRequest(state,receipt),undefined);
    assert.equal(gesture.takeMatchingRequest(pending(),receipt),undefined,'A rejected receipt is consumed');
  });
}

test('MIME and selection object key ordering do not alter exact semantic matching',()=>{
  const gesture=createNativeMenuClipboardGesture({writeClipboard(){}});
  gesture.prepare(origin,nativeClipboard);
  const receipt=pressAndRelease(gesture),state=pending();
  state.menuClipboard.clipboard.formats=Object.fromEntries(Object.entries(clipboard.formats).reverse());
  state.menuClipboard.clipboard.origin.clipboardSelection=Object.fromEntries(Object.entries(origin.clipboardSelection).reverse());
  assert.ok(gesture.takeMatchingRequest(state,receipt));
});

test('an already pending menu request cannot consume a new click receipt',()=>{
  const gesture=createNativeMenuClipboardGesture({writeClipboard(){}}),state=pending('cut','old-request');
  gesture.prepare(state,nativeClipboard);
  const receipt=pressAndRelease(gesture,{state});
  assert.equal(gesture.takeMatchingRequest(state,receipt),undefined);
});

const invalidGestures={
  'missing semantic action':()=>{const surface=popup();delete surface.menuActions[0].clipboardAction;surface.menuActions[0].text='Copy';return {surface};},
  'disabled item':()=>{const surface=popup();surface.menuActions[0].enabled=false;return {surface};},
  'separator':()=>{const surface=popup();surface.menuActions[0].separator=true;return {surface};},
  'main window':()=>({surface:{...popup(),main:true}}),
  'missing native menu flag':()=>{const surface=popup();delete surface.isMenu;return {surface};},
  'dialog widget menu':()=>({surface:{...popup(),type:'QWidget',isMenu:false}}),
  'another pointer':()=>({up:{pointerId:8}}),
  'another surface':()=>({up:{surface:'another-menu'}}),
  'outside menu item':()=>({up:{y:45}}),
  'right click':()=>({up:{button:2}}),
  'changed menu action':()=>({upContext:{surface:popup('copy')}}),
  'changed current selection':()=>{const state=clone(origin);state.clipboardSelection.text='Changed';return {upContext:{state}};},
};
for (const [name,options] of Object.entries(invalidGestures)) {
  test(`menu clipboard does not write for ${name}`,()=>{
    let writes=0;
    const gesture=createNativeMenuClipboardGesture({writeClipboard:()=>{writes++;}});
    gesture.prepare(origin,nativeClipboard);
    assert.equal(pressAndRelease(gesture,options()),undefined);
    assert.equal(writes,0);
  });
}

test('invalid native MIME or origin never becomes a prepared menu clipboard',()=>{
  const invalid=[undefined,{...nativeClipboard,origin:undefined},{...nativeClipboard,formats:{}},
    {...nativeClipboard,formats:{'text/plain':'not-base64'}},{...nativeClipboard,formats:{'application/unsafe':'YQ=='}},
    {...nativeClipboard,formats:{'text/plain':encodeClipboardText('x'.repeat(512*1024+1))}}];
  for (const clipboard of invalid) {
    let writes=0;
    const gesture=createNativeMenuClipboardGesture({writeClipboard:()=>{writes++;}});
    assert.equal(gesture.prepare(origin,clipboard),false);
    assert.equal(pressAndRelease(gesture),undefined);
    assert.equal(writes,0);
  }
});

test('invalidating before release prevents writing and invalidating after release prevents committing',()=>{
  let writes=0;
  const gesture=createNativeMenuClipboardGesture({writeClipboard:()=>{writes++;}});
  gesture.prepare(origin,nativeClipboard);
  gesture.handlePointer(pointer('pointerdown'),{surface:popup(),state:origin});
  gesture.invalidateGesture();
  assert.equal(gesture.handlePointer(pointer('pointerup'),{surface:popup(),state:origin}),undefined);
  assert.equal(writes,0);
  gesture.prepare(origin,nativeClipboard);
  const receipt=pressAndRelease(gesture);
  gesture.invalidateGesture();
  assert.equal(gesture.takeMatchingRequest(pending(),receipt),undefined);
  assert.equal(writes,1);
});

test('a later click replaces any unconfirmed receipt from an earlier click',()=>{
  const gesture=createNativeMenuClipboardGesture({writeClipboard(){}});
  gesture.prepare(origin,nativeClipboard);
  const first=pressAndRelease(gesture),second=pressAndRelease(gesture);
  assert.equal(gesture.takeMatchingRequest(pending(),first),undefined);
  assert.ok(gesture.takeMatchingRequest(pending(),second));
});

for (const scenario of [{accepted:false},{dispatch:false}]) {
  test(`single-click clipboard failure preserves native Cut and its confirmation fallback: ${JSON.stringify(scenario)}`,async()=>{
    const fake=browser(scenario),calls=[],notices=[];
    const controller=createNativeMenuClipboard({document:fake.doc,notice:message=>notices.push(message),
      writeClipboard:value=>copyNativeClipboardWithGesture(value,{document:fake.doc,crypto:{randomUUID}}),
      rpc:async()=>{calls.push('commit');},
    });
    controller.prepare(origin,nativeClipboard);
    const receipt=pressAndRelease(controller);
    assert.equal(receipt,undefined);
    assert.equal(await controller.update(pending(),{receipt}),false);
    const banner=fake.elements.find(item=>item.tag==='aside');
    assert.equal(banner.hidden,false);
    assert.equal(banner.children[1].textContent,'Confirm Cut');
    assert.deepEqual(calls,[]);
    assert.match(notices[0],/confirmation button/);
    controller.destroy();
  });
}

test('automatic commit transport failure retains confirmation UI and reports uncertain cut outcome',async()=>{
  const fake=browser(),notices=[];let calls=0;
  const controller=createNativeMenuClipboard({document:fake.doc,notice:message=>notices.push(message),writeClipboard(){},
    rpc:async()=>{calls++;throw new Error('connection closed');}});
  controller.prepare(origin,nativeClipboard);
  const receipt=pressAndRelease(controller),state=pending();
  assert.equal(await controller.update(state,{receipt}),false);
  assert.equal(fake.elements.find(item=>item.tag==='aside').hidden,false);
  assert.match(notices.at(-1),/Content was written to the system clipboard; the native operation is not yet confirmed/);
  assert.equal(await controller.update(state,{receipt}),false);
  assert.equal(calls,1,'No automatic retry after an uncertain native result');
  controller.destroy();
});

test('native Paste shows its real keyboard shortcut and can only cancel without writing or committing',async()=>{
  const fake=browser(),calls=[];let writes=0;
  const controller=createNativeMenuClipboard({document:fake.doc,notice(){},writeClipboard:()=>{writes++;},
    rpc:async(method,params)=>{calls.push({method,params});}});
  const state=pending('paste','paste-request');
  await controller.update(state);
  const banner=fake.elements.find(item=>item.tag==='aside');
  const [label,complete,cancel]=banner.children;
  assert.equal(banner.hidden,false);
  assert.equal(label.textContent,'Press ⌘V to paste (Windows/Linux: Ctrl+V)');
  assert.equal(complete.hidden,true);
  assert.equal(cancel.disabled,false);
  await complete.listeners.get('click')();
  assert.deepEqual(calls,[],'Even an accidental hidden-button callback cannot commit Paste');
  await cancel.listeners.get('click')();
  assert.equal(writes,0,'Paste guidance must never read or replace the browser clipboard');
  assert.deepEqual(calls,[{method:'clipboard',params:{action:'menu-cancel',requestId:'paste-request'}}]);
  assert.equal(banner.hidden,true);
  await controller.update(state);
  assert.equal(banner.hidden,true,'An outdated state cannot reopen the cancelled prompt');
  controller.destroy();
});

test('native Paste prompt disappears when a real paste clears pending and later Copy can confirm normally',async()=>{
  const fake=browser();
  const controller=createNativeMenuClipboard({document:fake.doc,notice(){},rpc:async()=>{throw new Error('No automatic clipboard action expected');}});
  await controller.update(pending('paste','paste-request'));
  const banner=fake.elements.find(item=>item.tag==='aside');
  assert.equal(banner.hidden,false);
  await controller.update(origin);
  assert.equal(banner.hidden,true);
  await controller.update(pending('copy','next-copy'));
  assert.equal(banner.hidden,false);
  assert.equal(banner.children[1].hidden,false);
  assert.equal(banner.children[1].textContent,'Copy to system clipboard');
  controller.destroy();
});

test('detaching menu UI preserves only an already written receipt for its original RPC',async()=>{
  const fake=browser(),calls=[];let writes=0,focuses=0;
  fake.doc.getElementById=()=>({focus(){focuses++;}});
  const controller=createNativeMenuClipboard({document:fake.doc,notice(){},writeClipboard:()=>{writes++;},
    rpc:async(method,params)=>{calls.push({method,params});}});
  controller.prepare(origin,nativeClipboard);
  const receipt=pressAndRelease(controller);
  assert.equal(writes,1);
  controller.destroy();
  assert.equal(controller.prepare(origin,nativeClipboard),false);
  assert.equal(pressAndRelease(controller),undefined);
  assert.equal(await controller.update(pending(),{receipt}),true);
  assert.deepEqual(calls,[{method:'clipboard',params:{action:'menu-commit',requestId:'fresh-request'}}]);
  assert.equal(await controller.update(pending(),{receipt}),false,'The receipt may commit only once');
  const banner=fake.elements.find(item=>item.tag==='aside');
  await banner.children[1].listeners.get('click')();
  await banner.children[2].listeners.get('click')();
  assert.equal(calls.length,1,'Detached controls cannot submit another operation');
  assert.equal(writes,1);
  assert.equal(focuses,0,'A completed old operation must not steal focus from the new panel');
});
