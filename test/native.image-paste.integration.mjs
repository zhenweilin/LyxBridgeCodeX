import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {deflateSync,inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createConnection} from 'node:net';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startBroker,brokerFile} from '../server/native-broker.mjs';
import {NativeSession} from '../lib/native-session.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const signature=Buffer.from([137,80,78,71,13,10,26,10]);
const crc32=bytes=>{
  let crc=0xffffffff;
  for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}
  return(crc^0xffffffff)>>>0;
};
function chunk(type,data){
  const name=Buffer.from(type),out=Buffer.alloc(data.length+12);
  out.writeUInt32BE(data.length);name.copy(out,4);data.copy(out,8);
  out.writeUInt32BE(crc32(Buffer.concat([name,data])),data.length+8);return out;
}
function png(width,height,{headerOnly=false}={}){
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  let raw=Buffer.alloc(0),rgb=Buffer.alloc(0);
  if(!headerOnly){
    rgb=Buffer.alloc(width*height*3);let random=0x12345678;
    for(let i=0;i<rgb.length;i++){random^=random<<13;random^=random>>>17;random^=random<<5;rgb[i]=random&255;}
    raw=Buffer.alloc(height*(1+width*3));
    for(let y=0;y<height;y++)rgb.copy(raw,y*(width*3+1)+1,y*width*3,(y+1)*width*3);
  }
  return {rgb,bytes:Buffer.concat([signature,chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))])};
}
function decodePng(bytes){
  assert.deepEqual(bytes.subarray(0,8),signature);
  let width,height,channels;const chunks=[];
  for(let i=8;i<bytes.length;){
    const size=bytes.readUInt32BE(i),type=bytes.toString('ascii',i+4,i+8),data=bytes.subarray(i+8,i+8+size);
    if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);assert.equal(data[8],8);assert.ok([2,6].includes(data[9]));channels=data[9]===6?4:3;}
    if(type==='IDAT')chunks.push(data);i+=size+12;
  }
  const raw=inflateSync(Buffer.concat(chunks)),stride=width*channels,decoded=Buffer.alloc(width*height*channels);
  const paeth=(a,b,c)=>{const p=a+b-c,da=Math.abs(p-a),db=Math.abs(p-b),dc=Math.abs(p-c);return da<=db&&da<=dc?a:db<=dc?b:c;};
  for(let y=0;y<height;y++)for(let x=0;x<stride;x++){
    const type=raw[y*(stride+1)],a=x>=channels?decoded[y*stride+x-channels]:0,b=y?decoded[(y-1)*stride+x]:0,c=y&&x>=channels?decoded[(y-1)*stride+x-channels]:0;
    assert.ok(type<=4);decoded[y*stride+x]=(raw[y*(stride+1)+x+1]+[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][type])&255;
  }
  const rgb=Buffer.alloc(width*height*3);
  for(let i=0;i<width*height;i++)decoded.copy(rgb,i*3,i*channels,i*channels+3);
  return {width,height,rgb};
}
async function registryHash(){
  try{return createHash('sha256').update(await readFile(brokerFile)).digest('hex');}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}

test('image paste through real stdio and broker preserves pixels, native dialogs, undo and target guards', {timeout:120000},async()=>{
  await mkdir('.native',{recursive:true});
  const directory=await mkdtemp(resolve('.native/image-paste-integration-')),path=join(directory,'image-paste.lyx');
  const source=String.raw`#LyX 2.4 created this file.
\lyxformat 620
\begin_document
\begin_header
\textclass article
\language english
\end_header
\begin_body
\begin_layout Standard
Native image paste fixture.
\end_layout
\end_body
\end_document
`;
  await writeFile(path,source);
  const registryBefore=await registryHash(),broker=await startBroker({port:0,registryPath:null});
  const client=new Client({name:'image-paste-test',version:'1.0.0'});
  let reopened;
  try{
    const descriptor=await broker.open(path);
    await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('test/fixtures/native-rpc-stdio.mjs')],
      stderr:'pipe',env:{...process.env,LYX_TEST_BROKER:JSON.stringify(descriptor)}}));
    const raw=async(method,params={})=>{
      const response=await client.callTool({name:'native_lyx_rpc',arguments:{sessionId:descriptor.sessionId,method,params}});
      assert.ok(!JSON.stringify(response).includes(descriptor.token),'Relay responses must not expose broker credentials');
      if(!response.isError)assert.deepEqual(response.content,[]);
      return response._meta?.['lyx/rpc'];
    };
    const rpc=async(method,params={})=>{const value=await raw(method,params);assert.ok(value && !value.error,value?.message);return value;};
    const frame=()=>rpc('frame',{width:900,height:700,serial:-1});
    const snapshot=()=>rpc('selection');
    const input=async params=>{await rpc('input',params);return rpc('state');};
    const key=async key=>{await input({type:'keydown',key});return input({type:'keyup',key});};
    const command=async command=>{await rpc('dispatch',{command});return rpc('state');};
    const eventually=async(callback,predicate,message)=>{
      for(let i=0;i<60;i++){const value=await callback();if(predicate(value))return value;await delay(20);}
      assert.fail(message);
    };
    const guarded=(snapshot,image,formats={})=>({action:'paste',formats,image,
      expectedPath:snapshot.path,expectedSelection:snapshot.clipboardSelection,expectedSourceRevision:snapshot.sourceRevision});
    await frame();await command('buffer-end');
    let before=await snapshot();assert.equal(before.capabilities.imagePaste,true,'Build the image-paste bridge first');
    const small=png(32,24),image={mimeType:'image/png',data:small.bytes.toString('base64')};
    await command('word-backward-select');before=await snapshot();assert.equal(before.hasSelection,true);
    const invalid=[
      {...guarded(before,image),expectedPath:path+'.other'},
      {...guarded(before,image),expectedSelection:{...before.clipboardSelection,text:'stale'}},
      {...guarded(before,image),expectedSourceRevision:'0'.repeat(64)},
      guarded(before,{mimeType:'image/gif',data:image.data}),
      guarded(before,{mimeType:'image/jpeg',data:image.data}),
      guarded(before,{mimeType:'image/png',data:'not base64'}),
      guarded(before,{mimeType:'image/png',data:Buffer.from('not an image').toString('base64')}),
      guarded(before,{mimeType:'image/png',data:png(8192,8192,{headerOnly:true}).bytes.toString('base64')}),
      guarded(before,{mimeType:'image/png',data:Buffer.alloc(8*1024*1024+1).toString('base64')}),
    ];
    for(const params of invalid){
      const result=await raw('clipboard',params);assert.equal(result.error,true);
      assert.equal((await snapshot()).source,before.source,'Rejected image must preserve selected text');
    }
    const ordinaryTooLarge=await raw('frame',{padding:' '.repeat(1024*1024)});
    assert.equal(ordinaryTooLarge.error,true);
    assert.match(ordinaryTooLarge.message,/request is too large/);
    assert.equal((await snapshot()).source,before.source,'The image envelope must not relax ordinary RPC limits');
    await input({type:'composition',text:'candidate'});
    assert.match((await raw('clipboard',guarded(before,image))).message,/composition/);
    await input({type:'composition',text:''});await command('buffer-end');before=await snapshot();

    // A real valid image larger than the old 1 MiB HTTP cap crosses both stdio
    // MCP and the authenticated broker, not only the native socket.
    const large=png(768,512);assert.ok(large.bytes.length>1024*1024);
    // A legal, unknown ancillary PNG chunk exercises the full 8 MiB limit
    // without allocating a huge bitmap. PNG decoders must ignore this chunk.
    const imageBytes=8*1024*1024;
    large.bytes=Buffer.concat([large.bytes.subarray(0,-12),
      chunk('npAD',Buffer.alloc(imageBytes-large.bytes.length-12)),large.bytes.subarray(-12)]);
    assert.equal(large.bytes.length,imageBytes);
    await rpc('clipboard',guarded(before,{mimeType:'image/png',data:large.bytes.toString('base64')}));
    const dialog=await eventually(frame,value=>value.surfaces.some(s=>/save the pasted graphic/i.test(s.title)),
      'Native LyX must ask where to save its pasted image');
    for(const[index,surface]of dialog.surfaces.entries())await writeFile(join(directory,`image-dialog-${index}.png`),Buffer.from(surface.png,'base64'));
    assert.equal((await snapshot()).source,before.source,'Opening the save dialog with a caret does not change source');
    await key(0x1000004);
    const pasted=await eventually(snapshot,value=>value.source.includes('\\begin_inset Graphics'),
      'Accepting the native dialog must create a real Graphics inset');
    const stored=decodePng(await readFile(join(directory,'pasted1.png')));
    assert.equal(stored.width,768);assert.equal(stored.height,512);assert.deepEqual(stored.rgb,large.rgb);
    await command('undo');assert.equal((await snapshot()).source,before.source);
    await command('redo');assert.equal((await snapshot()).source,pasted.source);
    await command('buffer-end');const afterImage=await snapshot();
    const jpeg=await readFile('.native/lyx-source/lib/examples/Curricula_Vitae/REPLACEphoto.jpg');
    await rpc('clipboard',guarded(afterImage,{mimeType:'image/jpeg',data:jpeg.toString('base64')}));
    await eventually(frame,value=>value.surfaces.some(s=>/save the pasted graphic/i.test(s.title)),'JPEG paste must use the same native image workflow');
    await key(0x1000000);
    await eventually(frame,value=>value.surfaces.length===1,'Cancel must dismiss the graphics save dialog');
    assert.equal((await snapshot()).source,afterImage.source,'Canceled image paste at a caret leaves the document unchanged');
    await rpc('clipboard',guarded(afterImage,image,{'text/plain':Buffer.from('Text keeps native priority').toString('base64')}));
    assert.ok((await snapshot()).source.includes('Text keeps native priority'));
    assert.equal((await frame()).surfaces.length,1,'Text takes precedence over an accompanying image');
    await command('undo');assert.equal((await snapshot()).source,afterImage.source);
    await command('buffer-write');
    const saved=await snapshot();assert.equal(saved.modified,false);
    const native=broker.sessions.get(descriptor.sessionId);
    // A malformed private-socket client cannot fill a bounded buffer forever.
    // The engine must disconnect only that client and keep serving the broker.
    const oversized=createConnection(native.socketPath);
    oversized.on('error',()=>{});
    try{
      await new Promise((done,reject)=>{oversized.once('connect',done);oversized.once('error',reject);});
      const closed=new Promise((done,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Oversized partial native request did not close')),3000);
        oversized.once('close',()=>{clearTimeout(timer);done();});
      });
      oversized.write(Buffer.alloc(12*1024*1024+64*1024+1,32));
      await closed;
      assert.equal((await snapshot()).source,saved.source);
    }finally{oversized.destroy();}
    native.stop();
    reopened=new NativeSession();await reopened.start(path);
    assert.equal((await reopened.call('selection')).source,saved.source,'Saved image inset survives reopening');
    const reopenedFrame=await reopened.call('frame',{width:900,height:700,serial:-1});
    await writeFile(join(directory,'reopened.png'),Buffer.from(reopenedFrame.surfaces[0].png,'base64'));
    assert.equal(await registryHash(),registryBefore);
    await writeFile(join(directory,'result.json'),JSON.stringify({largePngBytes:large.bytes.length,pixelsPreserved:true,savedAndReopened:true},null,2));
    console.log(`Native image paste evidence: ${directory}`);
  }finally{
    reopened?.stop();await client.close();
    for(const session of broker.sessions.values())session.stop();
    const closed=new Promise(done=>broker.server.close(done));broker.server.closeAllConnections();await closed;
  }
});
