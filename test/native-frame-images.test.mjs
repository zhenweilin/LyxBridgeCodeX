import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeFrameImages} from '../web/native-frame-images.mjs';
const canvas=()=>({width:0,height:0,drawn:[],getContext(){return {
  clearRect(){},drawImage:bitmap=>this.drawn.push(bitmap.bytes),
};}});
function harness() {
  let decoded=0,live=0,peak=0;
  const frames=createNativeFrameImages({bitmapFromBlob:async blob=>{
    assert.equal(blob.type,'image/png');decoded++;live++;peak=Math.max(peak,live);
    return {width:400,height:300,bytes:Buffer.from(await blob.arrayBuffer()),close(){live--;}};
  }});
  return {frames,decoded:()=>decoded,live:()=>live,peak:()=>peak};
}
test('sustained frame replacement closes decoded bitmaps and preserves PNG bytes',async()=>{
  const h=harness(),image=canvas();
  for(let i=0;i<1000;i++){
    const bytes=Buffer.from([137,80,78,71,0,255,i%256]);
    await h.frames.update(image,bytes.toString('base64'));
    assert.deepEqual(image.drawn.pop(),bytes);assert.equal(h.live(),0);
    assert.equal(image.width,400);assert.equal(image.height,300);assert.equal(image.src,undefined);
  }
  assert.equal(h.decoded(),1000);assert.equal(h.peak(),1);
  h.frames.clear();assert.equal(image.width,0);assert.equal(image.height,0);
});
test('unchanged frames skip decoding; closing a surface and reusing it refreshes pixels',async()=>{
  const h=harness(),main=canvas(),dialog=canvas();
  for(let i=0;i<100;i++)await h.frames.update(main,'AA==');
  assert.equal(h.decoded(),1);
  await h.frames.update(dialog,'AQ==');h.frames.remove(dialog);
  assert.equal(dialog.width,0);assert.equal(main.width,400);
  h.frames.clear();assert.equal(main.width,0);
  await h.frames.update(main,'AA==');assert.equal(h.decoded(),3);h.frames.clear();
});
test('a pending decode cannot repaint after a document switch and still closes its bitmap',async()=>{
  let finish,closed=0;
  const frames=createNativeFrameImages({bitmapFromBlob:()=>new Promise(resolve=>finish=resolve)}),image=canvas();
  const pending=frames.update(image,'AA==');frames.clear();
  finish({width:400,height:300,close(){closed++;}});await pending;
  assert.equal(closed,1);assert.equal(image.width,0);assert.equal(image.drawn.length,0);
});
test('failed decode or drawing can be retried and every decoded bitmap is closed',async()=>{
  let failDecode=true,closed=0;
  const frames=createNativeFrameImages({bitmapFromBlob:async()=>{
    if(failDecode)throw new Error('Decode failed');
    return {width:400,height:300,close(){closed++;}};
  }}),image=canvas();
  await assert.rejects(frames.update(image,'AA=='),/Decode failed/);
  failDecode=false;await frames.update(image,'AA==');assert.equal(closed,1);
  image.getContext=()=>({clearRect(){},drawImage(){throw new Error('Draw failed');}});
  await assert.rejects(frames.update(image,'AQ=='),/Draw failed/);assert.equal(closed,2);
  image.getContext=canvas().getContext;
  await frames.update(image,'AQ==');assert.equal(closed,3);
  await assert.rejects(frames.update(image,'not base64!'));assert.equal(closed,3);
  frames.clear();
});
