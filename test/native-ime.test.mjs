import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeIme} from '../web/native-ime.mjs';

function fixture(){
  const events=[],changes=[];
  let clears=0;
  const ime=createNativeIme({emit:value=>events.push(value),clear:()=>clears++,onCompositionChange:value=>changes.push(value)});
  return {ime,events,changes,get clears(){return clears;}};
}
function event(inputType,data,options={}){
  return {inputType,data,cancelable:true,defaultPrevented:false,
    preventDefault(){this.defaultPrevented=true;},...options};
}
const key=(type,value,options={})=>({type,key:value,code:`Key${value.toUpperCase()}`,...options});
const commits=events=>events.filter(value=>value.type==='commit').map(value=>value.text);
const typed=events=>events.filter(value=>['commit','keydown'].includes(value.type)).map(value=>value.text);

test('ordinary characters carry key identity only after browser text confirmation, without duplicate input',()=>{
  const {ime,events}=fixture();
  assert.equal(ime.key(key('keydown','a')),'browser');
  assert.deepEqual(events,[]);
  const before=event('insertText','a');
  assert.equal(ime.beforeinput(before),true);
  assert.equal(before.defaultPrevented,true);
  ime.input(event('insertText','a'));
  assert.equal(ime.key(key('keyup','a')),'ignore');
  assert.deepEqual(events,[
    {type:'commit',key:65,text:'a',shift:false,repeat:false},
  ]);
});

test('the first printable key can start composition without an early native character',()=>{
  const {ime,events,changes}=fixture();
  assert.equal(ime.key(key('keydown','n',{isComposing:false})),'browser');
  ime.compositionstart();
  ime.compositionupdate({data:'ni'});
  assert.equal(ime.key(key('keyup','n',{isComposing:true})),'ignore');
  assert.deepEqual(commits(events),[]);
  ime.compositionend({data:'你'});
  assert.deepEqual(commits(events),['你']);
  assert.deepEqual(changes,[true,false]);
});

for(const updateFirst of [false,true])
  test(`compositionupdate and beforeinput may arrive in either documented order (${updateFirst})`,()=>{
    const {ime,events}=fixture();
    ime.compositionstart();
    const before=event('insertCompositionText','中文',{isComposing:true,cancelable:false});
    if(updateFirst)ime.compositionupdate({data:'中文'});
    ime.beforeinput(before);
    if(!updateFirst)ime.compositionupdate({data:'中文'});
    ime.input(event('insertCompositionText','中文',{isComposing:true,cancelable:false}));
    assert.equal(before.defaultPrevented,false);
    assert.deepEqual(events,[{type:'composition',text:'中文',cursor:2}]);
    ime.compositionend({data:'中文'});
    assert.deepEqual(commits(events),['中文']);
  });

for(const inputType of ['insertText','insertFromComposition','insertCompositionText'])
  test(`compositionend suppresses only its immediate ${inputType} beforeinput/input echo`,()=>{
    const {ime,events}=fixture();
    ime.compositionstart();ime.compositionupdate({data:'中文'});ime.compositionend({data:'中文'});
    const before=event(inputType,'中文');
    ime.beforeinput(before);ime.input(event(inputType,'中文'));
    assert.equal(before.defaultPrevented,true);
    assert.deepEqual(commits(events),['中文']);
    assert.equal(ime.composing,false);
  });

test('an input-only composition echo does not recommit the finished candidate',()=>{
  const {ime,events}=fixture();
  ime.compositionstart();ime.compositionend({data:'你'});
  ime.input(event('insertText','你'));
  assert.deepEqual(commits(events),['你']);
});

test('a new key clears deduplication even when the next real text is identical',()=>{
  const {ime,events}=fixture();
  ime.compositionstart();ime.compositionend({data:'a'});
  assert.equal(ime.key(key('keydown','a')),'browser');
  ime.beforeinput(event('insertText','a'));
  ime.input(event('insertText','a'));
  assert.deepEqual(typed(events),['a','a']);
});

test('new compositions and new beforeinput intentions preserve repeated identical text',()=>{
  const {ime,events}=fixture();
  ime.compositionstart();ime.compositionend({data:'你'});
  ime.compositionstart();ime.compositionend({data:'你'});
  ime.beforeinput(event('insertText','你'));ime.input(event('insertText','你'));
  ime.beforeinput(event('insertText','你'));ime.input(event('insertText','你'));
  assert.deepEqual(commits(events),['你','你','你']);
});

test('empty compositionend clears native preedit without committing the last candidate',()=>{
  const {ime,events,changes}=fixture();
  ime.compositionstart();ime.compositionupdate({data:'候选'});
  ime.compositionend({data:''});
  ime.input(event('insertCompositionText','候选',{isComposing:true}));
  assert.deepEqual(commits(events),[]);
  assert.deepEqual(events.at(-1),{type:'composition',text:''});
  assert.deepEqual(changes,[true,false]);
  assert.equal(ime.composing,false);
  ime.key(key('keydown','a'));ime.beforeinput(event('insertText','a'));
  assert.deepEqual(typed(events),['a']);
});

test('blur cancellation is idempotent and ignores delayed composition updates and end',()=>{
  const {ime,events,changes}=fixture();
  ime.compositionstart();ime.compositionupdate({data:'拼音'});
  assert.equal(ime.cancel(),true);
  assert.equal(ime.cancel(),false);
  assert.equal(ime.compositionupdate({data:'残留'}),false);
  assert.equal(ime.compositionend({data:'错误提交'}),false);
  ime.beforeinput(event('insertText','错误提交'));ime.input(event('insertText','错误提交'));
  assert.deepEqual(events,[{type:'composition',text:'拼音',cursor:2},{type:'composition',text:''}]);
  assert.deepEqual(changes,[true,false]);
  ime.compositionstart();ime.compositionend({data:'重新输入'});
  assert.deepEqual(commits(events),['重新输入']);
});

test('a noncancelable beforeinput waits for input and commits once',()=>{
  const {ime,events}=fixture();
  const before=event('insertText','é',{cancelable:false});
  ime.beforeinput(before);
  assert.equal(before.defaultPrevented,false);
  assert.deepEqual(events,[]);
  ime.input(event('insertText','é'));
  assert.deepEqual(events,[{type:'commit',text:'é'}]);
});

test('input can supply text when beforeinput or input.data is missing',()=>{
  const {ime,events}=fixture();
  ime.input(event('insertText',null,{target:{value:'语音输入'}}));
  ime.beforeinput(event('insertText','é',{cancelable:false}));
  ime.input(event('insertText',null));
  assert.deepEqual(commits(events),['语音输入','é']);
});

test('a new beforeinput clears a previous canceled-input receipt',()=>{
  const {ime,events}=fixture();
  ime.beforeinput(event('insertText','a'));
  ime.beforeinput(event('insertText','a',{cancelable:false}));
  ime.input(event('insertText','a'));
  assert.deepEqual(commits(events),['a','a']);
});

test('an input-only insertion with different text is not swallowed by an older receipt',()=>{
  const {ime,events}=fixture();
  ime.beforeinput(event('insertText','a'));
  ime.input(event('insertText','🙂'));
  assert.deepEqual(commits(events),['a','🙂']);
});

test('canceling an inactive or active composition does not block direct text without keydown',()=>{
  for(const active of [false,true]){
    const {ime,events}=fixture();
    if(active){ime.compositionstart();ime.compositionupdate({data:'草稿'});}
    ime.cancel();
    ime.beforeinput(event('insertText','🙂'));
    ime.input(event('insertText','🙂'));
    ime.cancel();
    ime.input(event('insertText','speech input'));
    assert.deepEqual(commits(events),['🙂','speech input']);
  }
});

test('a fresh direct insertion matching old preedit is not assumed to be canceled text',()=>{
  const {ime,events}=fixture();
  ime.compositionstart();ime.compositionupdate({data:'same'});ime.cancel();
  ime.input(event('insertText','same'));
  assert.deepEqual(commits(events),['same']);
});

test('Dead, Process, 229, AltGraph and macOS Option text remain with the browser',()=>{
  const {ime,events}=fixture();
  for(const value of [
    key('keydown','Dead',{altKey:true}),key('keydown','Process'),key('keydown','n',{keyCode:229}),
    key('keydown','@',{ctrlKey:true,altKey:true,getModifierState:name=>name==='AltGraph'}),
    key('keydown','π',{altKey:true}),
  ]){
    assert.equal(ime.key(value),'browser');
    assert.equal(ime.key({...value,type:'keyup'}),'ignore');
  }
  assert.deepEqual(events,[]);
  ime.beforeinput(event('insertText','é'));
  assert.deepEqual(commits(events),['é']);
});

test('native shortcuts and nontext keys retain matching native releases, clipboard keys do not',()=>{
  const {ime}=fixture();
  for(const value of [key('keydown','m',{metaKey:true}),key('keydown','z',{ctrlKey:true}),
    key('keydown','ArrowLeft',{altKey:true}),key('keydown','Backspace'),key('keydown','Enter')]){
    assert.equal(ime.key(value),'native');
    assert.equal(ime.key({...value,type:'keyup'}),'native');
    assert.equal(ime.key({...value,type:'keyup'}),'ignore');
  }
  for(const value of ['c','x','v']){
    assert.equal(ime.key(key('keydown',value,{metaKey:true})),'browser');
    assert.equal(ime.key(key('keyup',value,{metaKey:true})),'ignore');
  }
});

test('composition swallows candidate navigation and Enter without orphan native releases',()=>{
  const {ime,events}=fixture();
  ime.compositionstart();
  assert.equal(ime.key(key('keydown','ArrowDown',{isComposing:true})),'browser');
  assert.equal(ime.key(key('keydown','Enter',{isComposing:true})),'browser');
  ime.compositionend({data:'中文'});
  assert.equal(ime.key(key('keyup','Enter',{isComposing:false})),'ignore');
  assert.deepEqual(commits(events),['中文']);
});

test('a modifier pressed before composition can still release natively',()=>{
  const {ime}=fixture();
  assert.equal(ime.key(key('keydown','Shift')),'native');
  ime.compositionstart();
  assert.equal(ime.key(key('keyup','Shift',{isComposing:true})),'native');
});

test('preedit cursor and selection use DOM UTF-16 positions only for this exact composition text',()=>{
  const {ime,events}=fixture();
  ime.compositionstart();
  ime.compositionupdate({data:'🙂中',target:{value:'old',selectionStart:0,selectionEnd:1}});
  assert.deepEqual(events.at(-1),{type:'composition',text:'🙂中',cursor:3});
  ime.input(event('insertCompositionText','🙂中',{isComposing:true,target:{value:'🙂中',selectionStart:2,selectionEnd:3}}));
  assert.deepEqual(events.at(-1),{type:'composition',text:'🙂中',cursor:3,selection:{start:2,length:1}});
  ime.compositionupdate({data:'中文',target:{value:'prefix中文',selectionStart:6,selectionEnd:8}});
  assert.deepEqual(events.at(-1),{type:'composition',text:'中文',cursor:2});
  ime.compositionupdate({data:'中文',target:{value:'中文',selectionStart:0,selectionEnd:4}});
  assert.deepEqual(events.at(-1),{type:'composition',text:'中文',cursor:2});
});

test('ordinary LyX math characters retain native keymap handling and Shift',()=>{
  const {ime,events}=fixture();
  for(const value of ['x','^','2','_','"','\\']){
    assert.equal(ime.key(key('keydown',value,{shiftKey:value==='^'})),'browser');
    ime.beforeinput(event('insertText',value));
    assert.equal(ime.key(key('keyup',value)),'ignore');
  }
  assert.deepEqual(typed(events),['x','^','2','_','"','\\']);
  assert.equal(events[1].shift,true);
});

test('confirmed Space and uppercase continuation keys preserve native shortcut identity',()=>{
  const {ime,events}=fixture();
  for(const [value,shiftKey] of [[' ',false],['A',true]]){
    assert.equal(ime.key(key('keydown',value,{shiftKey})),'browser');
    ime.beforeinput(event('insertText',value));
    ime.input(event('insertText',value));
    assert.equal(ime.key(key('keyup',value,{shiftKey})),'ignore');
  }
  assert.deepEqual(events,[
    {type:'commit',key:32,text:' ',shift:false,repeat:false},
    {type:'commit',key:65,text:'A',shift:true,repeat:false},
  ]);
});

test('noncancelable and input-only text preserve a confirmed key exactly once',()=>{
  for(const before of [true,false]){
    const {ime,events}=fixture();
    ime.key(key('keydown','t',{repeat:true}));
    if(before)ime.beforeinput(event('insertText','t',{cancelable:false}));
    assert.deepEqual(events,[]);
    ime.input(event('insertText','t'));
    assert.deepEqual(events,[
      {type:'commit',key:84,text:'t',shift:false,repeat:true},
    ]);
  }
});

test('composition, replacement and blur never reuse a preceding printable key',()=>{
  for(const mode of ['composition','replacement','blur']){
    const {ime,events}=fixture();
    ime.key(key('keydown','a'));
    if(mode==='composition'){
      ime.compositionstart();ime.compositionend({data:'a'});
    }else{
      if(mode==='blur')ime.cancel();
      ime.beforeinput(event(mode==='replacement'?'insertReplacementText':'insertText','a'));
    }
    assert.deepEqual(events,[{type:'commit',text:'a'}]);
  }
});

test('a released key without text confirmation cannot become a later direct insertion',()=>{
  const {ime,events}=fixture();
  ime.key(key('keydown','a'));ime.key(key('keyup','a'));
  ime.input(event('insertText','a'));
  assert.deepEqual(events,[{type:'commit',text:'a'}]);
});

test('paste and nontext editing intentions are left to their dedicated native handlers',()=>{
  const {ime,events}=fixture();
  assert.equal(ime.beforeinput(event('insertFromPaste','paste')),false);
  assert.equal(ime.input(event('insertFromPaste','paste')),false);
  assert.equal(ime.beforeinput(event('deleteContentBackward',null)),false);
  assert.deepEqual(events,[]);
});

test('a duplicate compositionend cannot commit the same session twice',()=>{
  const {ime,events,changes}=fixture();
  ime.compositionstart();ime.compositionend({data:'完成'});
  assert.equal(ime.compositionend({data:'完成'}),false);
  assert.deepEqual(commits(events),['完成']);
  assert.deepEqual(changes,[true,false]);
});
