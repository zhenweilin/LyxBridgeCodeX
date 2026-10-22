import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {copyFile,readFile,mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {startBroker,brokerFile} from '../server/native-broker.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
async function registryHash(){
  try{return hash(await readFile(brokerFile));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}

async function stopDisposableSession(session,path){
  assert.equal(session.path,path,'Only this test\'s disposable native process may be terminated');
  const child=session.process;
  if(!child || child.exitCode!==null || child.signalCode!==null){session.stop();return;}
  // LyX may remain alive while handling SIGTERM/emergency-save for an unsaved
  // buffer. Await close, and bound that graceful path for this disposable copy.
  const closed=new Promise(done=>child.once('close',done));
  const force=setTimeout(()=>child.kill('SIGKILL'),1000);
  try{session.stop();await closed;}
  finally{clearTimeout(force);}
}

test('real stdio model tools safely edit an isolated native buffer, preserve unsaved work and use native undo', {timeout:120000},async()=>{
  const original=await readFile('demo/demo.lyx'),registryBefore=await registryHash();
  await mkdir('.native',{recursive:true});
  const directory=await mkdtemp(resolve('.native/model-edit-integration-'));
  const path=join(directory,'demo.lyx');
  await copyFile('demo/demo.lyx',path);
  const broker=await startBroker({port:0,registryPath:null});
  const client=new Client({name:'native-model-edit-integration',version:'1.0.0'});
  const exposed=[];
  let stderr='';
  try{
    const descriptor=await broker.open(path);
    const sessionId=descriptor.sessionId;
    const transport=new StdioClientTransport({
      command:process.execPath,args:[resolve('test/fixtures/native-rpc-stdio.mjs')],stderr:'pipe',
      env:{...process.env,LYX_TEST_BROKER:JSON.stringify(descriptor)},
    });
    transport.stderr.on('data',chunk=>{stderr+=chunk.toString();});
    await client.connect(transport);
    const call=async(name,arguments_)=>{
      const result=await client.callTool({name,arguments:arguments_});
      exposed.push(result);
      return result;
    };
    const rpc=async(method,params={})=>{
      const result=await call('native_lyx_rpc',{sessionId,method,params});
      assert.ok(!result.isError,result.content?.[0]?.text);
      return result._meta['lyx/rpc'];
    };
    const read=async()=>{
      const result=await call('read_native_lyx',{sessionId});
      assert.ok(!result.isError,result.content?.[0]?.text);
      const value=result.structuredContent;
      assert.deepEqual(JSON.parse(result.content[0].text),value);
      assert.equal(value.path,path);
      assert.equal(value.sessionId,sessionId);
      assert.equal(value.sourceRevision,hash(value.source));
      return value;
    };
    const settled=async()=>{
      for(let attempt=0;attempt<50;attempt++){
        const value=await read();
        if(value.inputPending!==true)return value;
        await new Promise(done=>setTimeout(done,10));
      }
      assert.fail('The disposable native input queue did not settle');
    };
    const command=async command=>{
      await rpc('dispatch',{command});
      return settled();
    };
    const key=async(key,text='',modifiers={})=>{
      await rpc('input',{type:'keydown',key,text,...modifiers});
      await rpc('input',{type:'keyup',key,text,...modifiers});
      return settled();
    };
    const request=(snapshot,replacement)=>({sessionId,path:snapshot.path,sourceRevision:snapshot.sourceRevision,
      selection:snapshot.clipboardSelection,replacement});
    const replace=async(snapshot,replacement)=>{
      const result=await call('replace_native_lyx_selection',request(snapshot,replacement));
      assert.ok(!result.isError,result.content?.[0]?.text);
      const value=result.structuredContent;
      assert.equal(value.applied,true);
      assert.equal(value.modified,true);
      assert.equal(value.previousSourceRevision,snapshot.sourceRevision);
      assert.equal(value.sourceRevision,hash(value.source));
      assert.equal(value.source,(await read()).source);
      assert.deepEqual(await readFile(path),original,'Model edits must not implicitly save');
      return value;
    };

    const initial=await read();
    assert.equal(initial.editingSupported,true,'Build the current native edit bridge before running this test');
    assert.equal(initial.modified,false);
    assert.equal(initial.inputPending,false);
    await rpc('frame',{width:1000,height:800});
    for(const action of ['buffer-end','paragraph-break','layout Standard','self-insert Unsaved user context survives model editing',
      'paragraph-break','self-insert Original MCP selected text','line-begin-select'])await command(action);
    const before=await read();
    assert.equal(before.selection,'Original MCP selected text');
    assert.equal(before.clipboardSelection.kind,'document');
    assert.equal(before.modified,true);
    for(const [code,changes] of [
      ['revision_conflict',{sourceRevision:initial.sourceRevision}],
      ['selection_conflict',{selection:{...before.clipboardSelection,text:'A stale selected string'}}],
    ]){
      const rejected=await call('replace_native_lyx_selection',{
        ...request(before,{format:'text',text:'Must never appear'}),...changes,
      });
      assert.equal(rejected.isError,true);
      assert.equal(rejected.structuredContent.code,code);
      assert.equal(rejected.structuredContent.applied,false);
      assert.equal(rejected.structuredContent.outcome,'not_applied');
      const unchanged=await read();
      assert.equal(unchanged.source,before.source);
      assert.deepEqual(unchanged.clipboardSelection,before.clipboardSelection);
    }

    const changed=await replace(before,{format:'text',text:'Updated MCP selected text\nSecond line 中文'});
    assert.match(changed.source,/Unsaved user context survives model editing/);
    assert.doesNotMatch(changed.source,/Original MCP selected text/);
    assert.match(changed.source,/Updated MCP selected text/);
    assert.match(changed.source,/Second line 中文/);
    assert.equal((await command('undo')).source,before.source,'A single native undo restores the whole model edit');
    assert.equal((await command('redo')).source,changed.source);

    for(const action of ['buffer-end','paragraph-break','layout Standard'])await command(action);
    await key(77,'m',{meta:true});await key(88,'x');await key(94,'^',{shift:true});await key(50,'2');
    const mathBefore=await command('char-backward-select');
    assert.equal(mathBefore.selection,'2');
    assert.ok(mathBefore.selectionStart.length>=3,'The replacement must target a native nested math cell');
    const mathAfter=await replace(mathBefore,{format:'math',text:'\\frac{a}{b}'});
    assert.match(mathAfter.source,/\\begin_inset Formula \$x\^\{\\frac\{a\}\{b\}\}\$/);
    assert.equal((await command('undo')).source,mathBefore.source);
    assert.equal((await command('redo')).source,mathAfter.source);

    const missing=await call('read_native_lyx',{sessionId:'missing-model-edit-session'});
    assert.equal(missing.isError,true);
    const extraUrl=await call('replace_native_lyx_selection',{
      ...request(mathBefore,{format:'math',text:'z'}),url:'https://example.invalid',
    });
    assert.equal(extraUrl.isError,true);
    assert.equal((await read()).source,mathAfter.source);
    const finalFrame=await rpc('frame',{width:1000,height:800,serial:-1});
    await writeFile(join(directory,'model-edited-native.png'),Buffer.from(finalFrame.surfaces.find(surface=>surface.main).png,'base64'));
    await writeFile(join(directory,'model-edit-results.json'),JSON.stringify({before,changed,mathBefore,mathAfter},null,2)+'\n');
    assert.ok(!JSON.stringify(exposed).includes(descriptor.token),'Model and UI results must not expose the broker token');
    assert.ok(!JSON.stringify(exposed).includes(descriptor.url),'Model and UI results must not expose the private transport URL');
    assert.ok(!stderr.includes(descriptor.token));
    assert.deepEqual(await readFile(path),original);
    assert.deepEqual(await readFile('demo/demo.lyx'),original);
    assert.equal(await registryHash(),registryBefore,'The production broker registry must remain unchanged');
    console.log(`MCP native edit evidence: ${directory}`);
  }finally{
    try{await client.close();}
    finally{
      const closed=new Promise(done=>broker.server.close(done));
      broker.server.closeAllConnections();
      await Promise.all([closed,...[...broker.sessions.values()].map(session=>stopDisposableSession(session,path))]);
    }
  }
});
