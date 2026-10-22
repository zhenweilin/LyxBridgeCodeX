import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeImePosition} from '../web/native-ime-position.mjs';

const base={inputMethod:{enabled:true,rect:{x:120,y:210,width:1,height:24}},
  surface:{width:1000,height:800},image:{left:20,top:90,width:1000,height:800},
  viewport:{left:20,top:40}};
test('candidate anchor follows native caret rather than the last mouse click',()=>{
  assert.deepEqual(nativeImePosition(base),{left:120,top:260,height:24});
  const moved={...base,inputMethod:{enabled:true,rect:{x:35,y:242,width:1,height:24}}};
  assert.deepEqual(nativeImePosition(moved),{left:35,top:292,height:24});
});
test('candidate anchor maps a scaled popup surface and a scrolled containing viewport',()=>{
  assert.deepEqual(nativeImePosition({...base,
    surface:{width:500,height:300},image:{left:100,top:160,width:250,height:150},
    scrollLeft:11,scrollTop:19}),{left:151,top:244,height:12});
});
test('offscreen caret positions remain exact instead of snapping to an unrelated visible field',()=>{
  assert.deepEqual(nativeImePosition({...base,inputMethod:{enabled:true,
    rect:{x:-30,y:-65,width:0,height:20}}}),{left:-30,top:-15,height:20});
});
test('missing old-engine metrics and invalid geometry do not invent an IME anchor',()=>{
  for(const data of [{...base,inputMethod:undefined},{...base,inputMethod:{enabled:false}},
    {...base,surface:undefined},{...base,surface:{width:0,height:800}},
    {...base,inputMethod:{enabled:true,rect:{x:NaN,y:0,width:1,height:20}}},
    {...base,inputMethod:{enabled:true,rect:{x:0,y:0,width:1,height:0}}}])
    assert.equal(nativeImePosition(data),undefined);
});
