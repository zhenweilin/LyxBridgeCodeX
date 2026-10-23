// End-to-end local transports; excludes model thinking and the desktop host.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {parseArgs} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startBroker,brokerFile} from '../server/native-broker.mjs';
import {createCli} from '../lib/native-cli.mjs';
import {createNativeEditor} from '../lib/native-editor.mjs';
import {callNativeRpc} from '../lib/native-broker-client.mjs';

const {values}=parseArgs({options:{baseline:{type:'boolean'},samples:{type:'string',default:'15'},output:{type:'string'}}});
const samples=Number(values.samples);
assert.ok(Number.isInteger(samples)&&samples>=3&&samples<=100);
const directory=await mkdtemp(resolve('.native/edit-benchmark-'));
const registry=await readFile(brokerFile).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
const original=await readFile('demo/demo.lyx','utf8');
const header=original.slice(0,original.indexOf('\\begin_body')+'\\begin_body'.length);
const broker=await startBroker({port:0,registryPath:null});
const report={baseline:!!values.baseline,samples,scope:'Local native engine + broker + transports; excludes Codex host and model latency',documents:[]};
const ok=r=>{assert.ok(!r?.error&&!r?.isError,r?.message??r?.content?.[0]?.text);return r.structuredContent??r;};
const stats=items=>{const sorted=items.map(x=>x.ms).sort((a,b)=>a-b);return {
  medianMs:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.ceil(sorted.length*.95)-1],
  medianBytes:items.map(x=>x.bytes).sort((a,b)=>a-b)[Math.floor(items.length/2)]};};
async function stop(session){
  const child=session.process;if(!child||child.exitCode!==null||child.signalCode!==null){session.stop();return;}
  const closed=once(child,'close');const timer=setTimeout(()=>child.kill('SIGKILL'),1000);
  try{session.stop();await closed;}finally{clearTimeout(timer);}
}
function cliTransport(descriptor){
  const child=spawn(process.execPath,['test/fixtures/native-cli.mjs'],{stdio:['pipe','pipe','pipe'],env:{...process.env,LYX_TEST_BROKER:JSON.stringify(descriptor)}});
  const lines=createInterface({input:child.stdout});const iterator=lines[Symbol.asyncIterator]();
  return {child,async call(request){child.stdin.write(JSON.stringify(request)+'\n');const line=await iterator.next();assert.ok(!line.done);return JSON.parse(line.value);},
    async close(){child.stdin.end();await once(child,'close');lines.close();}};
}
try{
  for(const paragraphs of [20,2000]){
    const path=join(directory,`document-${paragraphs}.lyx`);
    const source=header+'\n'+Array.from({length:paragraphs},(_,i)=>`\\begin_layout Standard\nParagraph ${i}. A representative paragraph with enough words to exercise serialization and layout in a longer research document.\n\\end_layout\n`).join('')+
      '\\begin_layout Standard\nBenchmark original selected sentence.\n\\end_layout\n\\end_body\n\\end_document\n';
    await writeFile(path,source);
    const descriptor=await broker.open(path),session=broker.sessions.get(descriptor.sessionId),sessionId=descriptor.sessionId;
    await session.call('frame',{width:1100,height:800,serial:-1});
    const command=async command=>{ok(await session.call('command',{command}));};
    const select=async()=>{await command('buffer-end');await command('line-begin-select');};
    const full=async()=>ok(await session.call('selection'));
    const client=new Client({name:'edit-benchmark',version:'1.0.0'});
    const transport=new StdioClientTransport({command:process.execPath,args:[resolve('test/fixtures/benchmark-mcp.mjs')],stderr:'pipe',
      env:{...process.env,LYX_TEST_BROKER:JSON.stringify(descriptor),LYX_BENCHMARK_MODULE:values.baseline?'.native/edit-optimization-baseline/mcp.mjs':'server/mcp.mjs'}});
    let errors='';transport.stderr.on('data',data=>{errors+=data;});
    await client.connect(transport);
    const mcp=(name,args)=>client.callTool({name,arguments:{sessionId,...args}});
    const direct=createCli({editor:createNativeEditor({rpc:(args,options)=>callNativeRpc(args,{...options,broker:descriptor})})});
    const cli=values.baseline?null:cliTransport(descriptor);
    const metrics={paragraphs,sourceBytes:Buffer.byteLength(source),operations:{}};
    async function measure(name,setup,operation,verify){
      const items=[];
      for(let i=-3;i<samples;i++){
        const data=await setup();const start=performance.now();const result=await operation(data);const ms=performance.now()-start;
        ok(result);if(verify)await verify(result,data);
        if(i>=0)items.push({ms,bytes:Buffer.byteLength(JSON.stringify(result))});
      }
      metrics.operations[name]=stats(items);
    }
    const replacement={format:'text',text:'Benchmark improved selected sentence.'};
    const setup=async capture=>{await select();const before=await full();return {before,target:ok(await capture())};};
    const verify=async(result,{before})=>{
      assert.equal(ok(result).tracked,true);assert.match((await full()).source,/Benchmark improved selected sentence/);
      await command('undo');assert.equal((await full()).source,before.source,'Every measured edit is one exact undo step');
    };
    try{
      await select();
      await measure('mcpFullRead',async()=>{},()=>mcp('read_native_lyx'));
      await measure('mcpSelection',select,()=>mcp('read_native_lyx_selection'));
      await measure('mcpTrackedEdit',()=>setup(()=>mcp('read_native_lyx_selection')),
        ({target})=>mcp('replace_native_lyx_snapshot',{snapshotId:target.snapshotId,replacement}),verify);
      if(cli){
        const request=(command,args={})=>({command,args:{sessionId,...args}});
        await measure('directTrackedEdit',()=>setup(()=>direct(request('selection'))),
          ({target})=>direct(request('replace',{snapshotId:target.snapshotId,replacement})),verify);
        await measure('cliWarmTrackedEdit',()=>setup(()=>cli.call(request('selection'))),
          ({target})=>cli.call(request('replace',{snapshotId:target.snapshotId,replacement})),verify);
        await measure('cliColdTrackedEdit',()=>setup(()=>direct(request('selection'))),async({target})=>{
          const cold=cliTransport(descriptor);try{return await cold.call(request('replace',{snapshotId:target.snapshotId,replacement}));}finally{await cold.close();}
        },verify);
        await measure('cliApplyTwoEdits',async()=>{await select();return {before:await full()};},
          ()=>cli.call(request('apply',{edits:[{find:'original',replace:'improved'},{find:'sentence.',replace:'sentence!'}]})),async(result,{before})=>{
            assert.equal(ok(result).tracked,true);assert.match((await full()).source,/Benchmark improved selected sentence!/);
            await command('undo');assert.equal((await full()).source,before.source);
          });
      }
      assert.equal(await readFile(path,'utf8'),source,'Edits must never save implicitly');
      report.documents.push(metrics);console.log(JSON.stringify(metrics));
    }finally{await client.close();if(cli)await cli.close();await stop(session);broker.sessions.delete(sessionId);}
  }
  assert.deepEqual(await readFile(brokerFile).catch(e=>{if(e.code!=='ENOENT')throw e;return null;}),registry);
  const output=values.output??join(directory,'results.json');await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(`Saved benchmark: ${output}`);
}finally{
  const closed=new Promise(done=>broker.server.close(done));broker.server.closeAllConnections();
  await Promise.all([closed,...[...broker.sessions.values()].map(stop)]);
}
