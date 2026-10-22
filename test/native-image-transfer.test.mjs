import test from 'node:test';
import assert from 'node:assert/strict';
import {stageNativeImagePaste} from '../web/native-clipboard.mjs';

const guarded=image=>({action:'paste',formats:{},image,expectedPath:'/fixture.lyx',
  expectedSelection:{kind:'document',text:'selected',start:[1],end:[2]},expectedSourceRevision:'revision'});

test('an 8 MiB image crosses a legacy 1 MiB request limit without changing bytes or guards',async()=>{
  const bytes=Buffer.alloc(8*1024*1024);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
  const params=guarded({mimeType:'image/png',data:bytes.toString('base64')}),parts=[];
  let offset=0,begin,largest=0;
  const commit=await stageNativeImagePaste(params,async(method,request)=>{
    assert.equal(method,'clipboard');
    const wireBytes=Buffer.byteLength(JSON.stringify({sessionId:'session',method,params:request}));
    largest=Math.max(largest,wireBytes);assert.ok(wireBytes<1024*1024);
    if(request.action==='image-begin'){
      begin=request;return {uploadId:'native-upload',maxChunkBytes:196608};
    }
    assert.equal(request.action,'image-chunk');assert.equal(request.uploadId,'native-upload');
    assert.equal(request.offset,offset);
    const chunk=Buffer.from(request.data,'base64');offset+=chunk.length;parts.push(chunk);
    return {receivedBytes:offset};
  });
  assert.equal(begin.size,bytes.length);assert.equal(begin.mimeType,'image/png');
  assert.equal(begin.expectedPath,params.expectedPath);
  assert.deepEqual(begin.expectedSelection,params.expectedSelection);
  assert.equal(begin.expectedSourceRevision,params.expectedSourceRevision);
  assert.deepEqual(Buffer.concat(parts),bytes);assert.ok(parts.length>1);
  assert.ok(largest<300000);
  assert.deepEqual(commit,{action:'image-commit',uploadId:'native-upload'});
});

test('an interrupted image upload cancels only its upload and never retries or commits',async()=>{
  const calls=[],failure=new Error('The transport disconnected');
  await assert.rejects(stageNativeImagePaste(guarded({mimeType:'image/jpeg',data:'YWJjZGU='}),
    async(method,params)=>{
      calls.push(params);
      if(params.action==='image-begin')return {uploadId:'failed-upload',maxChunkBytes:3};
      if(params.action==='image-chunk'&&params.offset===3)throw failure;
      return {};
    }),error=>error===failure);
  assert.deepEqual(calls.map(item=>item.action),['image-begin','image-chunk','image-chunk','image-cancel']);
  assert.deepEqual(calls.at(-1),{action:'image-cancel',uploadId:'failed-upload'});
});

test('a malformed native chunk size releases the staged upload before reading any chunks',async()=>{
  const calls=[];
  await assert.rejects(stageNativeImagePaste(guarded({mimeType:'image/png',data:'YWJj'}),
    async(method,params)=>{
      calls.push(params);return {uploadId:'bad-size',maxChunkBytes:2};
    }),/invalid image transfer size/);
  assert.deepEqual(calls.map(item=>item.action),['image-begin','image-cancel']);
});
