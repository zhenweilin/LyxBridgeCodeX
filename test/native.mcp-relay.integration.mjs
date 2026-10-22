import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {copyFile,readFile,mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {startBroker,brokerFile} from '../server/native-broker.mjs';

async function registryHash(){
  try{return createHash('sha256').update(await readFile(brokerFile)).digest('hex');}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}

test('real stdio MCP relay carries native frames and input only in UI metadata, without exposing broker credentials', {timeout:120000}, async () => {
  const original=await readFile('demo/demo.lyx');
  const registryBefore=await registryHash();
  await mkdir('.native',{recursive:true});
  const directory=await mkdtemp(resolve('.native/mcp-relay-integration-'));
  const path=join(directory,'demo.lyx');
  await copyFile('demo/demo.lyx',path);
  const broker=await startBroker({port:0,registryPath:null});
  const client=new Client({name:'lyx-native-relay-test',version:'1.0.0'});
  let stderr='';
  try{
    const privateDescriptor=await broker.open(path);
    const transport=new StdioClientTransport({
      command:process.execPath,args:[resolve('test/fixtures/native-rpc-stdio.mjs')],stderr:'pipe',
      env:{...process.env,LYX_TEST_BROKER:JSON.stringify(privateDescriptor)},
    });
    transport.stderr.on('data',chunk=>{stderr+=chunk.toString();});
    await client.connect(transport);
    const exposed=[];
    const opened=await client.callTool({name:'open_lyx',arguments:{path}});
    exposed.push(opened);
    assert.ok(!opened.isError);
    assert.deepEqual(opened._meta['lyx/native'],{path,sessionId:privateDescriptor.sessionId});
    assert.deepEqual(opened.structuredContent,opened._meta['lyx/native']);
    const tools=await client.listTools();
    const relay=tools.tools.find(tool=>tool.name==='native_lyx_rpc');
    assert.deepEqual(relay._meta.ui.visibility,['app']);
    const rpc=async(method,params={})=>{
      const response=await client.callTool({name:'native_lyx_rpc',arguments:{sessionId:privateDescriptor.sessionId,method,params}});
      exposed.push(response);
      assert.ok(!response.isError,response.content?.[0]?.text);
      assert.deepEqual(response.content,[],'Frames and source must never be model-facing tool content');
      assert.equal(response.structuredContent,undefined);
      return response._meta['lyx/rpc'];
    };
    const frame=await rpc('frame',{width:1000,height:800});
    assert.equal(frame.path,path);
    assert.equal(frame.ready,true);
    const main=frame.surfaces.find(surface=>surface.main);
    assert.equal(main.width,1000);
    assert.equal(main.height,800);
    const png=Buffer.from(main.png,'base64');
    assert.deepEqual(png.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
    await writeFile(join(directory,'mcp-native-frame.png'),png);
    await rpc('dispatch',{command:'buffer-end'});
    await rpc('input',{type:'keydown',key:0x1000004});
    await rpc('input',{type:'keyup',key:0x1000004});
    await rpc('dispatch',{command:'layout Standard'});
    const beforeTyping=await rpc('selection');
    const typed=await rpc('input',{type:'commit',text:'MCP relay native typing',replyWithState:true});
    assert.equal(typed.stateAfterInput,true);
    assert.equal(typed.inputPending,false,'The combined response follows delivery of the posted native typing event');
    assert.equal(typed.modified,true);
    assert.notDeepEqual(typed.cursor,beforeTyping.cursor,'The combined response includes the cursor after insertion');
    assert.equal(typed.source,undefined,'The input state does not unnecessarily serialize the full document');
    const selection=await rpc('selection');
    assert.match(selection.source,/MCP relay native typing/);
    assert.equal(selection.modified,true);
    assert.notEqual(selection.sourceRevision,beforeTyping.sourceRevision);
    assert.deepEqual(typed.cursor,selection.cursor);
    const selected=await rpc('input',{type:'keydown',key:0x1000012,shift:true,replyWithState:true});
    assert.equal(selected.stateAfterInput,true);
    assert.equal(selected.inputPending,false);
    assert.equal(selected.hasSelection,true,'The combined response exposes the selection created by this input');
    assert.equal(selected.selection,'g');
    assert.equal(selected.clipboardSelection.text,'g');
    const released=await rpc('input',{type:'keyup',key:0x1000012,shift:true});
    assert.equal(released.stateAfterInput,undefined,'Uncombined input remains compatible with older frontends');
    const copied=await rpc('clipboard',{action:'copy',expectedPath:selected.path,expectedSelection:selected.clipboardSelection});
    assert.deepEqual(copied.clipboard.origin.clipboardSelection,selected.clipboardSelection,
      'The returned post-input state is immediately usable by guarded clipboard operations');
    const replaced=await rpc('input',{type:'commit',text:'G',replyWithState:true});
    assert.equal(replaced.stateAfterInput,true);
    assert.equal(replaced.hasSelection,false);
    const afterReplacement=await rpc('selection');
    assert.match(afterReplacement.source,/MCP relay native typinG/);
    assert.doesNotMatch(afterReplacement.source,/MCP relay native typing/);
    assert.deepEqual(replaced.clipboardSelection,afterReplacement.clipboardSelection);
    assert.equal((await rpc('state')).path,path);
    assert.ok((await rpc('clipboard',{action:'read'})).clipboard);
    const error=await client.callTool({name:'native_lyx_rpc',arguments:{sessionId:'missing-native-session',method:'state',params:{}}});
    exposed.push(error);
    assert.equal(error.isError,true);
    assert.equal(error._meta['lyx/rpc'].error,true);
    assert.match(error._meta['lyx/rpc'].message,/session not found/);
    const unsupported=await client.callTool({name:'native_lyx_rpc',arguments:{sessionId:privateDescriptor.sessionId,method:'command',params:{}}});
    exposed.push(unsupported);
    assert.equal(unsupported.isError,true);
    const arbitraryUrl=await client.callTool({name:'native_lyx_rpc',arguments:{sessionId:privateDescriptor.sessionId,method:'state',params:{},url:'https://example.invalid'}});
    exposed.push(arbitraryUrl);
    assert.equal(arbitraryUrl.isError,true);
    assert.ok(!JSON.stringify(exposed).includes(privateDescriptor.token),'The broker bearer token never crosses the MCP boundary');
    assert.ok(!JSON.stringify(opened).includes(privateDescriptor.url),'Plugin descriptors do not expose a localhost URL');
    assert.ok(!stderr.includes(privateDescriptor.token));
    assert.deepEqual(await readFile(path),original,'Relay input changes the test buffer, never the disk fixture');
    assert.deepEqual(await readFile('demo/demo.lyx'),original);
    assert.equal(await registryHash(),registryBefore,'The live editor registry remains unchanged');
    console.log(`MCP relay evidence: ${directory}`);
  }finally{
    await client.close();
    for(const session of broker.sessions.values())session.stop();
    const closed=new Promise(done=>broker.server.close(done));
    broker.server.closeAllConnections();
    await closed;
  }
});
