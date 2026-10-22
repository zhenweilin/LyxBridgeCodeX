import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createServer} from 'node:http';
import {createHash,randomBytes} from 'node:crypto';
import {deflateSync,inflateSync} from 'node:zlib';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {NativeSession} from '../lib/native-session.mjs';
import {brokerFile} from '../server/native-broker.mjs';

const delay=ms=>new Promise(done=>setTimeout(done,ms));
const maxImageBytes=8*1024*1024;
const legacyLimit=1024*1024;
const signature=Buffer.from([137,80,78,71,13,10,26,10]);
function chunk(type,data){
  const name=Buffer.from(type),result=Buffer.alloc(data.length+12);
  result.writeUInt32BE(data.length);name.copy(result,4);data.copy(result,8);
  let crc=0xffffffff;
  for(const byte of Buffer.concat([name,data])){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}
  result.writeUInt32BE((crc^0xffffffff)>>>0,result.length-4);return result;
}
function image(padded=false){
  const width=32,height=24,header=Buffer.alloc(13),rgb=Buffer.alloc(width*height*3),raw=Buffer.alloc(height*(width*3+1));
  header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  for(let i=0;i<rgb.length;i++)rgb[i]=(i*31+Math.floor(i/97))%256;
  for(let y=0;y<height;y++)rgb.copy(raw,y*(width*3+1)+1,y*width*3,(y+1)*width*3);
  let bytes=Buffer.concat([signature,chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
  if(padded)bytes=Buffer.concat([bytes.subarray(0,-12),chunk('npAD',Buffer.alloc(maxImageBytes-bytes.length-12)),bytes.subarray(-12)]);
  return {width,height,rgb,bytes};
}
function pngRgb(bytes){
  assert.deepEqual(bytes.subarray(0,8),signature);
  let width,height,channels;const compressed=[];
  for(let at=8;at<bytes.length;){
    const size=bytes.readUInt32BE(at),type=bytes.toString('ascii',at+4,at+8),data=bytes.subarray(at+8,at+8+size);
    if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);assert.equal(data[8],8);assert.ok([2,6].includes(data[9]));channels=data[9]===2?3:4;}
    if(type==='IDAT')compressed.push(data);at+=size+12;
  }
  const raw=inflateSync(Buffer.concat(compressed)),stride=width*channels,decoded=Buffer.alloc(height*stride);
  const paeth=(a,b,c)=>{const p=a+b-c,da=Math.abs(p-a),db=Math.abs(p-b),dc=Math.abs(p-c);return da<=db&&da<=dc?a:db<=dc?b:c;};
  for(let y=0;y<height;y++)for(let x=0;x<stride;x++){
    const filter=raw[y*(stride+1)],a=x>=channels?decoded[y*stride+x-channels]:0,b=y?decoded[(y-1)*stride+x]:0,c=y&&x>=channels?decoded[(y-1)*stride+x-channels]:0;
    assert.ok(filter<=4);decoded[y*stride+x]=(raw[y*(stride+1)+x+1]+[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter])&255;
  }
  const rgb=Buffer.alloc(width*height*3);
  for(let i=0;i<width*height;i++)decoded.copy(rgb,i*3,i*channels,i*channels+3);
  return {width,height,rgb};
}
async function registryHash(){
  try{return createHash('sha256').update(await readFile(brokerFile)).digest('hex');}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}

test('chunked images cross a legacy 1 MiB relay with guarded, expiring, single-use native uploads', {timeout:180000},async()=>{
  await mkdir('.native',{recursive:true});
  const directory=await mkdtemp(resolve('.native/image-chunks-integration-')),path=join(directory,'chunks.lyx');
  const source=String.raw`#LyX 2.4 created this file.
\lyxformat 620
\begin_document
\begin_header
\textclass article
\language english
\end_header
\begin_body
\begin_layout Standard
Chunk image fixture.
\end_layout
\end_body
\end_document
`;
  await writeFile(path,source);
  const otherPath=join(directory,'other.lyx');
  await writeFile(otherPath,source);
  const registryBefore=await registryHash(),session=new NativeSession();
  const token=randomBytes(32).toString('hex');
  let largestAccepted=0,rejectedLarge=0,server,reopened,expiryEvidence;
  const client=new Client({name:'native-image-chunks-test',version:'0.2.9'});
  try{
    await session.start(path);
    // This disposable route deliberately keeps the OLD all-operation 1 MiB
    // request cap. It never connects to the user's broker or native engines.
    server=createServer((request,response)=>{
      let size=0,body='';
      request.on('data',part=>{size+=part.length;if(size<=legacyLimit)body+=part;});
      request.on('end',async()=>{
        response.setHeader('Content-Type','application/json');
        if(request.headers.authorization!==`Bearer ${token}`){response.writeHead(401);response.end('{}');return;}
        if(size>legacyLimit){rejectedLarge++;response.writeHead(400);response.end(JSON.stringify({error:'Legacy broker request limit is 1 MiB'}));return;}
        try{
          const args=JSON.parse(body);
          assert.equal(args.sessionId,session.id);
          assert.ok(['frame','input','selection','state','dispatch','clipboard'].includes(args.method));
          largestAccepted=Math.max(largestAccepted,size);
          response.end(JSON.stringify(await session.call(args.method,args.params)));
        }catch(error){response.writeHead(400);response.end(JSON.stringify({error:String(error.message)}));}
      });
    });
    await new Promise(done=>server.listen(0,'127.0.0.1',done));
    const descriptor={url:`http://127.0.0.1:${server.address().port}`,token,path,sessionId:session.id};
    await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('test/fixtures/native-rpc-stdio.mjs')],
      stderr:'pipe',env:{...process.env,LYX_TEST_BROKER:JSON.stringify(descriptor)}}));
    const raw=async(method,params={})=>{
      const response=await client.callTool({name:'native_lyx_rpc',arguments:{sessionId:session.id,method,params}});
      assert.ok(!JSON.stringify(response).includes(token));
      if(!response.isError)assert.deepEqual(response.content,[]);
      return response._meta['lyx/rpc'];
    };
    const rpc=async(method,params={})=>{const result=await raw(method,params);assert.ok(result&&!result.error,result?.message);return result;};
    const clipboard=params=>rpc('clipboard',params);
    const snapshot=()=>rpc('selection');
    const frame=()=>rpc('frame',{width:900,height:700,serial:-1});
    const input=async params=>{await rpc('input',params);return rpc('state');};
    const key=async key=>{await input({type:'keydown',key});return input({type:'keyup',key});};
    const command=async command=>{await rpc('dispatch',{command});return rpc('state');};
    const guards=snapshot=>({expectedPath:snapshot.path,expectedSelection:snapshot.clipboardSelection,expectedSourceRevision:snapshot.sourceRevision});
    const begin=(snapshot,bytes,mimeType='image/png')=>clipboard({action:'image-begin',mimeType,size:bytes.length,...guards(snapshot)});
    const send=async(upload,bytes)=>{
      for(let offset=0;offset<bytes.length;offset+=upload.maxChunkBytes){
        const part=bytes.subarray(offset,offset+upload.maxChunkBytes);
        const result=await clipboard({action:'image-chunk',uploadId:upload.uploadId,offset,data:part.toString('base64')});
        assert.equal(result.receivedBytes,offset+part.length);
      }
    };
    const reject=async(params,pattern)=>{const result=await raw('clipboard',params);assert.equal(result.error,true);if(pattern)assert.match(result.message,pattern);return result;};
    const eventually=async(callback,predicate,message)=>{
      for(let i=0;i<75;i++){const value=await callback();if(predicate(value))return value;await delay(20);}
      assert.fail(message);
    };
    await frame();await command('buffer-end');await command('word-backward-select');
    const selected=await snapshot(),small=image();
    assert.equal(selected.capabilities.imagePasteChunks,true,'Build the chunked image bridge first');
    assert.equal(selected.hasSelection,true);
    const request={action:'image-begin',mimeType:'image/png',size:small.bytes.length,...guards(selected)};
    for(const invalid of [
      {...request,size:0},{...request,size:maxImageBytes+1},{...request,size:1.5},{...request,mimeType:'image/gif'},
      {...request,expectedPath:path+'.other'},{...request,expectedSelection:{}},{...request,expectedSourceRevision:'0'.repeat(64)},
    ])await reject(invalid);
    assert.equal((await snapshot()).source,selected.source);

    let upload=await begin(selected,small.bytes);
    assert.equal(upload.maxChunkBytes,196608);assert.equal(upload.expiresInMs,120000);
    await reject(request,/already active/);
    await reject({action:'image-cancel',uploadId:'not-this-upload'},/expired/);
    await send(upload,small.bytes);
    assert.equal((await snapshot()).source,selected.source,'Receiving bytes must not replace the selection');
    assert.deepEqual((await readdir(directory)).sort(),['chunks.lyx','other.lyx'],'Uploading bytes must not create graphics or temporary files');
    await clipboard({action:'image-cancel',uploadId:upload.uploadId});
    await reject({action:'image-commit',uploadId:upload.uploadId},/expired/);

    for(const badChunk of [
      {offset:1,data:small.bytes.toString('base64')},
      {offset:0,data:'not base64'},
      {offset:0,data:''},
      {offset:0,data:Buffer.alloc(196609).toString('base64')},
      {offset:0,data:Buffer.alloc(small.bytes.length+1).toString('base64')},
    ]){
      upload=await begin(selected,small.bytes);
      await reject({action:'image-chunk',uploadId:upload.uploadId,...badChunk});
      await reject({action:'image-commit',uploadId:upload.uploadId},/expired/);
      assert.equal((await snapshot()).source,selected.source);
    }
    upload=await begin(selected,small.bytes);
    await clipboard({action:'image-chunk',uploadId:upload.uploadId,offset:0,data:small.bytes.subarray(0,20).toString('base64')});
    await reject({action:'image-chunk',uploadId:upload.uploadId,offset:0,data:small.bytes.subarray(0,20).toString('base64')},/out of order/);
    upload=await begin(selected,small.bytes);
    await reject({action:'image-commit',uploadId:upload.uploadId},/incomplete/);
    for(const [bytes,mime] of [[Buffer.from('not an image'),'image/png'],[small.bytes,'image/jpeg']]){
      upload=await begin(selected,bytes,mime);await send(upload,bytes);
      await reject({action:'image-commit',uploadId:upload.uploadId},/type/);
      assert.equal((await snapshot()).source,selected.source);
    }

    upload=await begin(selected,small.bytes);await send(upload,small.bytes);
    await command('font-bold');
    const formatted=await snapshot();
    assert.deepEqual(formatted.clipboardSelection,selected.clipboardSelection);
    assert.notEqual(formatted.sourceRevision,selected.sourceRevision);
    await reject({action:'image-commit',uploadId:upload.uploadId},/changed/);
    assert.equal((await snapshot()).source,formatted.source,'Same text and positions must not bypass the source guard');
    await command('undo');
    assert.equal((await snapshot()).source,selected.source);
    await command('buffer-end');await command('word-backward-select');
    let before=await snapshot();
    upload=await begin(before,small.bytes);await send(upload,small.bytes);
    await command('buffer-begin');
    await reject({action:'image-commit',uploadId:upload.uploadId},/changed/);
    assert.equal((await snapshot()).source,before.source);
    await command('buffer-end');before=await snapshot();
    upload=await begin(before,small.bytes);await send(upload,small.bytes);
    await input({type:'composition',text:'candidate'});
    await reject({action:'image-commit',uploadId:upload.uploadId},/composition/);
    await reject({...request,...guards(before)},/composition/);
    await input({type:'composition',text:''});
    assert.equal((await snapshot()).source,before.source);

    upload=await begin(before,small.bytes);await send(upload,small.bytes);
    await command(`file-open ${otherPath}`);
    assert.equal((await snapshot()).path,otherPath);
    await reject({action:'image-commit',uploadId:upload.uploadId},/changed/);
    await command(`buffer-switch ${path}`);
    await command('buffer-end');
    assert.equal((await snapshot()).source,before.source);
    before=await snapshot();

    upload=await begin(before,small.bytes);await send(upload,small.bytes);
    await rpc('dispatch',{command:'buffer-write-as'});
    await eventually(frame,value=>value.surfaces.some(surface=>/FileDialog/.test(surface.type)),'Save As opens a native dialog');
    assert.equal((await rpc('state')).inputPending,true);
    await reject({action:'image-commit',uploadId:upload.uploadId},/pending/);
    await key(0x1000000);
    await eventually(frame,value=>value.surfaces.length===1,'Escape closes Save As');
    assert.equal((await snapshot()).source,before.source);

    // Expiration is a real timer, with no test-only production time override.
    // The document remains untouched throughout the pending upload's lifetime.
    upload=await begin(await snapshot(),small.bytes);
    const expiring=upload,expiryWallStart=Date.now(),expiryMonotonicStart=performance.now(),expiresAt=expiryWallStart+upload.expiresInMs;
    await send(upload,small.bytes);
    await delay(Math.max(0,expiresAt-Date.now()+100));
    const expiryResult=await raw('clipboard',{action:'image-commit',uploadId:expiring.uploadId});
    expiryEvidence={wallElapsedMs:Date.now()-expiryWallStart,monotonicElapsedMs:performance.now()-expiryMonotonicStart,
      rejected:expiryResult.error===true,message:expiryResult.message};
    assert.equal(expiryResult.error,true,JSON.stringify(expiryEvidence));
    assert.match(expiryResult.message,/expired/);
    assert.equal((await snapshot()).source,before.source);

    const large=image(true);assert.equal(large.bytes.length,maxImageBytes);
    const oversizedDirect=await raw('clipboard',{action:'paste',formats:{},image:{mimeType:'image/png',data:large.bytes.toString('base64')},...guards(before)});
    assert.equal(oversizedDirect.error,true);assert.match(oversizedDirect.message,/Legacy broker request limit/);
    assert.equal(rejectedLarge,1,'The disposable legacy relay really rejects an unchunked image');
    upload=await begin(before,large.bytes);
    await reject({action:'image-cancel',uploadId:expiring.uploadId},/expired/);
    await send(upload,large.bytes);
    assert.equal((await snapshot()).source,before.source);
    assert.deepEqual((await readdir(directory)).sort(),['chunks.lyx','other.lyx']);
    await clipboard({action:'image-commit',uploadId:upload.uploadId});
    await eventually(frame,value=>value.surfaces.some(surface=>/save the pasted graphic/i.test(surface.title)),'Commit uses native LyX image paste');
    await reject({action:'image-commit',uploadId:upload.uploadId},/expired/);
    await key(0x1000004);
    const pasted=await eventually(snapshot,value=>value.source.includes('\\begin_inset Graphics'),'The native save dialog inserts a Graphics inset');
    assert.deepEqual(pngRgb(await readFile(join(directory,'pasted1.png'))),{width:large.width,height:large.height,rgb:large.rgb});
    assert.equal((pasted.source.match(/\\begin_inset Graphics/g)||[]).length,1,'A repeated commit must not insert a second graphic');
    await command('undo');assert.equal((await snapshot()).source,before.source);
    await command('redo');assert.equal((await snapshot()).source,pasted.source);
    await command('buffer-write');
    const saved=await snapshot();assert.equal(saved.modified,false);
    session.stop();
    reopened=new NativeSession();await reopened.start(path);
    assert.equal((await reopened.call('selection')).source,saved.source);
    assert.ok(largestAccepted<legacyLimit);
    assert.equal(await registryHash(),registryBefore);
    await writeFile(join(directory,'result.json'),JSON.stringify({imageBytes:large.bytes.length,largestAcceptedRequestBytes:largestAccepted,
      legacyLimitBytes:legacyLimit,rejectedUnchunked:true,expirationVerified:true,expiryEvidence,pixelsPreserved:true,savedAndReopened:true},null,2));
    console.log(`Native chunked image evidence: ${directory}`);
  }finally{
    if(expiryEvidence)await writeFile(join(directory,'expiry-check.json'),JSON.stringify(expiryEvidence,null,2));
    reopened?.stop();session.stop();await client.close();
    if(server){const closed=new Promise(done=>server.close(done));server.closeAllConnections();await closed;}
  }
});
