import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {OpenAIUiToolMetadataSchema,OpenAIUiResourceMetadataSchema} from '@openai/mcp-extensions/server';
import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';

test('real stdio MCP handshake, file handler metadata, resource and demo tool',async()=>{
 const client=new Client({name:'lyx-preview-test',version:'1.0.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:[resolve('server/mcp.mjs')],stderr:'pipe'});
 try {
  await client.connect(transport);
  const list=await client.listTools();
  const viewer=list.tools.find(t=>t.name==='view_lyx_file');
  const meta=OpenAIUiToolMetadataSchema.parse(viewer._meta['openai/ui']);
  assert.deepEqual(meta.entrypoints,[{type:'file',extensions:['.lyx']}]);
  const resource=await client.readResource({uri:'ui://lyx-preview/viewer'});
  OpenAIUiResourceMetadataSchema.parse(resource.contents[0]._meta['openai/ui']);
  assert.match(resource.contents[0].text,/add to chat/);
  assert.doesNotMatch(resource.contents[0].text,/console\.debug\s*\(/,
    'The published preview bundle must not log complete transport payloads');
  const native=await client.readResource({uri:viewer._meta.ui.resourceUri});
  assert.match(native.contents[0].text,/Native LyX editing area/);
  assert.doesNotMatch(native.contents[0].text,/console\.debug\s*\(/,
    'The published native bundle must not log complete PNG frame messages');
  assert.match(native.contents[0].text,/console\.error\s*\(/,
    'Removing debug payloads must retain transport error diagnostics');
  assert.equal(viewer._meta.ui.resourceUri,'ui://lyx-preview/native-editor-v3',
    'New file entrypoints must remain readable by already-running 0.2.2 chat servers');
  assert.equal(list.tools.find(tool=>tool.name==='open_lyx')._meta.ui.resourceUri,viewer._meta.ui.resourceUri);
  const cachedV4=await client.readResource({uri:'ui://lyx-preview/native-editor-v4'});
  assert.equal(cachedV4.contents[0].uri,'ui://lyx-preview/native-editor-v4');
  assert.equal(cachedV4.contents[0].text,native.contents[0].text,
    'Cached 0.2.3 entries must also load the current editor after reconnecting');
  assert.equal(native.contents[0]._meta.ui.csp?.connectDomains,undefined,'Plugin relay requires no localhost CSP permission');
  const relay=list.tools.find(tool=>tool.name==='native_lyx_rpc');
  assert.deepEqual(relay._meta.ui.visibility,['app']);
  assert.deepEqual(relay.inputSchema.properties.method.enum,['frame','input','selection','state','dispatch','clipboard']);
  const rejected=await client.callTool({name:'native_lyx_rpc',arguments:{sessionId:'untrusted-session',method:'command',params:{command:'buffer-write'}}});
  assert.equal(rejected.isError,true,'The app relay rejects methods outside its allowlist');
  const result=await client.callTool({name:'open_lyx_preview',arguments:{path:resolve('test/fixtures/demo.lyx')}});
  assert.ok(!result.isError,JSON.stringify(result));assert.equal(result.structuredContent.blocks.length,5);
  assert.match(result.structuredContent.html,/mathvariant="bold">D/);
  const rendered=await client.callTool({name:'render_lyx',arguments:{source:await readFile('test/fixtures/demo.lyx','utf8')},_meta:{'openai/resource':{path:resolve('test/fixtures/demo.lyx')}}});
  assert.ok(!rendered.isError,JSON.stringify(rendered));assert.equal(rendered.structuredContent.path,resolve('test/fixtures/demo.lyx'));
  assert.deepEqual(rendered.structuredContent.warnings,[]);
 }finally{await client.close();}
});
