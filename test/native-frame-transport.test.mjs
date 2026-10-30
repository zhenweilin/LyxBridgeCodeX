import test from 'node:test';
import assert from 'node:assert/strict';
import {readNativeFrame} from '../web/native-frame-transport.mjs';

const args={sessionId:'test-session',params:{width:1671,height:1211,serial:4}};
const result={content:[],_meta:{'lyx/rpc':{ready:true,serial:5,surfaces:[{id:'main',png:'test-frame'}]}}};
const unused={callServerTool(){assert.fail('Frames must not also reach the logging adapter');}};

test('frames use the documented host bridge with the same server, session and dimensions',async()=>{
  const calls=[],host={callTool(name,params){assert.equal(this,host);calls.push({name,params});return result;}};
  assert.equal(await readNativeFrame(args,{app:unused,openai:host}),result);
  assert.deepEqual(calls,[{name:'native_lyx_rpc',params:{sessionId:args.sessionId,method:'frame',params:args.params}}]);
});

test('hosts without the compatibility API retain the standard MCP frame route',async()=>{
  for(const openai of [undefined,{}, {callTool:undefined}]){
    const calls=[];const app={callServerTool(request){calls.push(request);return result;}};
    assert.equal(await readNativeFrame(args,{app,openai}),result);
    assert.deepEqual(calls,[{name:'native_lyx_rpc',arguments:{sessionId:args.sessionId,method:'frame',params:args.params}}]);
  }
});

test('compatibility result wrappers preserve hidden metadata',async()=>{
  for(const reply of [{call_tool_result:result},{mcp_tool_result:result},
    {meta:{call_tool_result:result}},{meta:{mcp_tool_result:result}}])
    assert.equal(await readNativeFrame(args,{app:unused,openai:{callTool:async()=>reply}}),result);
  const alias=await readNativeFrame(args,{app:unused,openai:{callTool:async()=>({content:[],meta:result._meta})}});
  assert.equal(alias._meta,result._meta);
});

test('native failure envelopes and transport rejection are preserved, never retried',async()=>{
  const failure={isError:true,content:[{type:'text',text:'Native session exited'}],
    _meta:{'lyx/rpc':{error:true,code:'session_exited',message:'Native session exited'}}};
  assert.equal(await readNativeFrame(args,{app:unused,openai:{callTool:async()=>failure}}),failure);
  assert.equal(await readNativeFrame(args,{app:unused,openai:{callTool:async()=>({mcp_tool_result:failure})}}),failure);
  assert.equal(await readNativeFrame(args,{app:unused,openai:{callTool:async()=>({isError:true,mcp_tool_result:failure})}}),failure);
  const error=new Error('Host transport unavailable');let calls=0;
  await assert.rejects(readNativeFrame(args,{app:unused,openai:{callTool:async()=>{calls++;throw error;}}}),e=>e===error);
  assert.equal(calls,1);
});

test('an incomplete compatibility result fails without replay through the logging path',async()=>{
  for(const reply of [undefined,{}, {content:[]},{meta:{unrelated:'metadata'}}])
    await assert.rejects(readNativeFrame(args,{app:unused,openai:{callTool:async()=>reply}}),/did not return native LyX state/);
});
