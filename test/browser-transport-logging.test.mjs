import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {build} from 'esbuild';
import {browserBuildOptions} from '../scripts/browser-build-options.mjs';

// Use the installed SDK, not a transport mock. Only its window and console
// boundaries are controlled. This detects changes in dependencies and builds
// which accidentally restore payload logging.
async function transport({production=true}={}){
  const built=await build({...browserBuildOptions,pure:production?browserBuildOptions.pure:[],
    stdin:{contents:`import {PostMessageTransport} from '@modelcontextprotocol/ext-apps';
      globalThis.transport=new PostMessageTransport(window.parent,window.parent);`,
      resolveDir:process.cwd(),sourcefile:'transport-fixture.mjs'}});
  const listeners=new Set(),sent=[],debug=[],errors=[];
  const parent={postMessage:(message,origin)=>sent.push({message,origin})};
  const context={window:{parent,addEventListener:(type,listener)=>listeners.add(listener),
    removeEventListener:(type,listener)=>listeners.delete(listener)},
    console:{debug:(...args)=>debug.push(args),error:(...args)=>errors.push(args)}};
  vm.runInNewContext(built.outputFiles[0].text,context);
  const channel=context.transport;await channel.start();
  return {channel,parent,sent,debug,errors,listeners,
    receive:(data,source=parent)=>{for(const listener of listeners)listener({data,source});}};
}

const frame=(id,png)=>({jsonrpc:'2.0',id,result:{_meta:{'lyx/rpc':{
  ready:true,serial:id,surfaces:[{id:'main',png}],
}}}});

test('SDK baseline demonstrates full-frame debug logging; production removes it',async()=>{
  const raw=await transport({production:false}),quiet=await transport();
  let baseline=0,delivered=0;
  raw.channel.onmessage=()=>baseline++;
  quiet.channel.onmessage=message=>{
    delivered++;assert.equal(message.result._meta['lyx/rpc'].surfaces[0].png.length,256*1024);
  };
  // 1,000 distinct 256 KiB payloads: 250 MiB passes through the real parser.
  // Retain baseline log arguments only for the first 100 frames, then release
  // them; the production assertions need no image-history accumulator.
  for(let i=0;i<1000;i++){
    const png=String(i).padStart(8,'0')+'A'.repeat(256*1024-8);
    if(i<100)raw.receive(frame(i,png));
    quiet.receive(frame(i,png));
  }
  assert.equal(baseline,100);assert.equal(delivered,1000);
  assert.equal(raw.debug.filter(args=>args[0]==='Parsed message').length,100);
  assert.equal(raw.debug[0][1].result._meta['lyx/rpc'].surfaces[0].png.length,256*1024);
  assert.equal(quiet.debug.length,0,'No frame object can be retained through console.debug');
  raw.debug.length=0;await raw.channel.close();await quiet.channel.close();
});

test('quiet production transport preserves source checks, errors, delivery, and cleanup',async()=>{
  const host=await transport();let delivered=0,failed=0,closed=0;
  host.channel.onmessage=()=>delivered++;
  host.channel.onerror=()=>failed++;
  host.channel.onclose=()=>closed++;
  host.receive(frame(1,'foreign'),{});
  host.receive({unrelated:'message'});
  assert.equal(delivered,0);assert.equal(failed,0);assert.equal(host.debug.length,0);
  host.receive({jsonrpc:'2.0',id:2});
  assert.equal(failed,1);assert.equal(host.errors.length,1,'Protocol errors remain diagnosable');
  host.receive(frame(3,'valid'));assert.equal(delivered,1);
  const request={jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'native_lyx_rpc'}};
  await host.channel.send(request);
  assert.equal(host.sent.length,1);assert.equal(host.sent[0].message,request);
  assert.equal(host.debug.length,0,'Outgoing payloads are not logged either');
  await host.channel.close();assert.equal(closed,1);assert.equal(host.listeners.size,0);
  host.receive(frame(5,'after-close'));assert.equal(delivered,1);
});
