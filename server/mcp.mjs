import {McpServer} from '@modelcontextprotocol/server';
import {serveStdio,StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import {OpenAIExtensions,getResourcePath} from '@openai/mcp-extensions/server';
import {registerAppResource,registerAppTool,RESOURCE_MIME_TYPE} from '@modelcontextprotocol/ext-apps/server';
import {z} from 'zod';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {renderFile,renderLyx} from '../lib/lyx.mjs';
import {openNativeDocument,reopenNativeDocument,callNativeRpc,nativeRpcMethods} from '../lib/native-broker-client.mjs';
import {imageNativeRequestBytes} from '../lib/native-rpc-limits.mjs';

const uri='ui://lyx-preview/viewer';
const viewerURL=new URL('../dist/viewer.html',import.meta.url);
// Keep the file entrypoint compatible with already-running 0.2.2 servers.
// The host may refresh its tool catalog before reconnecting the chat's server.
const nativeUri='ui://lyx-preview/native-editor-v3';
const nativeResourceUris=[nativeUri,'ui://lyx-preview/native-editor-v4'];
const nativeURL=new URL('../dist/native.html',import.meta.url);
const annotations={readOnlyHint:true,destructiveHint:false,openWorldHint:false};
const nativeSessionId=z.string().min(1).max(128);
const revision=z.string().regex(/^[a-fA-F0-9]{64}$/);
const nativePosition=z.object({
  paragraph:z.number().int().min(0).max(2147483647),
  position:z.number().int().min(0).max(2147483647),
  cell:z.number().int().min(0).max(2147483647),
}).strict();
const nativePositions=z.array(nativePosition).min(1).max(64);
const boundedEditText=z.string().max(128*1024).regex(/^[^\0]*$/u);
const typedReplacement=z.object({format:z.enum(['text','math']),text:boundedEditText}).strict();
const snapshotId=z.string().uuid();
const replacementInput=z.object({
  sessionId:nativeSessionId,
  path:z.string().min(1).max(4096).regex(/^[^\0]*$/u),
  sourceRevision:revision,
  selection:z.object({
    kind:z.literal('document'),hasSelection:z.literal(true),text:boundedEditText,
    start:nativePositions,end:nativePositions,
  }).strict(),
  replacement:typedReplacement,
}).strict();
const documentSelection=z.object({
  kind:z.literal('document'),hasSelection:z.boolean(),text:z.string(),
  start:nativePositions,end:nativePositions,
});
const widgetSelection=z.object({
  kind:z.literal('widget'),widget:z.string(),hasSelection:z.boolean(),text:z.string(),
  start:z.number().int(),end:z.number().int(),revision:z.number().int().optional(),
});
const nativeSnapshot=z.object({
  ready:z.literal(true),path:z.string().min(1),source:z.string().min(1),modified:z.boolean(),
  externalModified:z.boolean().optional(),hasSelection:z.boolean(),selection:z.string(),
  selectionStart:nativePositions,selectionEnd:nativePositions,cursor:nativePositions.optional(),
  sourceRevision:revision.optional(),diskRevision:revision.optional(),
  inputPending:z.boolean().optional(),
  inputMethod:z.object({enabled:z.boolean(),composing:z.boolean()}).optional(),
  clipboardSelection:z.union([documentSelection,widgetSelection]).optional(),
  capabilities:z.object({editSelection:z.boolean().optional(),compositionGuard:z.boolean().optional()}).optional(),
});
const editRejections=new Set(['not_editable','document_mismatch','revision_conflict','selection_conflict','invalid_replacement','input_pending','snapshot_expired','snapshot_used']);
const compactSelection=z.object({
  ready:z.literal(true),path:z.string().min(1),modified:z.boolean(),sourceRevision:revision,
  clipboardSelection:documentSelection,
  snapshotId:snapshotId.optional(),snapshotTtlSeconds:z.number().int().positive().optional(),
  selectionFormat:z.enum(['text','math']).optional(),
}).refine(value=>!value.snapshotId || (value.clipboardSelection.hasSelection && value.selectionFormat && value.snapshotTtlSeconds),
  'A native edit target must identify a selected passage, replacement format and lifetime');
const snapshotReceipt=z.object({
  applied:z.literal(true),path:z.string().min(1),modified:z.boolean(),
  sourceRevision:revision,previousSourceRevision:revision,snapshotId,replayed:z.boolean(),
});
const supportsModelEditing=state=>state.capabilities?.editSelection===true && state.capabilities?.compositionGuard===true;
function nativeFailure(value,fallback='The native LyX operation failed'){
  const error=new Error(String(value?.message??fallback).slice(0,2000));
  if(typeof value?.code==='string' && /^[a-z_]{1,64}$/.test(value.code))error.code=value.code;
  if(value?.applied===true)error.applied=true;
  return error;
}
function requireNativeResult(value){
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('Native LyX did not return a valid result.');
  if(value.error || value.isError)throw nativeFailure(value);
  return value;
}
function modelSnapshot(value,sessionId){
  requireNativeResult(value);
  const parsed=nativeSnapshot.safeParse(value);
  if(!parsed.success)throw new Error('Native LyX did not return a complete active document snapshot; read it again.');
  const snapshot=parsed.data;
  const hash=createHash('sha256').update(snapshot.source,'utf8').digest('hex');
  if(snapshot.sourceRevision && snapshot.sourceRevision.toLowerCase()!==hash)
    throw new Error('The native LyX snapshot does not match its source revision; read it again.');
  return {...snapshot,sessionId,sourceRevision:hash,editingSupported:supportsModelEditing(snapshot)};
}
function modelResult(data){return{content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};}
function modelError(error,sessionId,{write=false,attempted=false,applied=false}={}){
  const data={error:true,sessionId,message:String(error?.message??'The native LyX operation failed').slice(0,2000)};
  if(typeof error?.code==='string' && /^[a-z_]{1,64}$/.test(error.code))data.code=error.code;
  if(write){
    if(applied || error?.applied===true){
      Object.assign(data,{applied:true,outcome:'applied',readBeforeRetry:true});
      data.message=`The edit was applied, but its complete result could not be confirmed. Use read_native_lyx before retrying; do not repeat the replacement. ${data.message}`;
    }else if(!attempted || editRejections.has(data.code)){
      Object.assign(data,{applied:false,outcome:'not_applied'});
    }else{
      Object.assign(data,{outcome:'unknown',readBeforeRetry:true});
      data.message=`The edit outcome is unconfirmed. Use read_native_lyx before retrying; do not repeat the replacement. ${data.message}`;
    }
  }
  return{...modelResult(data),isError:true};
}
function result(data){return{content:[{type:'text',text:`LyX preview: ${data.name}, ${data.blocks.length} paragraphs with source locations.`}],structuredContent:data};}
function nativeResult(data){
  const descriptor={path:data.path,sessionId:data.sessionId};
  return{content:[{type:'text',text:`Native LyX session ready: ${data.path}`}],structuredContent:descriptor,_meta:{'lyx/native':descriptor}};
}
function nativeUiError(error){
  const message=String(error?.message??'The native LyX operation failed').slice(0,2000);
  const result={error:true,message};
  if(typeof error?.code==='string'&&/^[a-z_]{1,64}$/.test(error.code))result.code=error.code;
  if(error?.applied===true)result.applied=true;
  return{isError:true,content:[{type:'text',text:message}],_meta:{'lyx/rpc':result}};
}

export function createServer({openNative=openNativeDocument,reopenNative=reopenNativeDocument,rpc=callNativeRpc}={}){
  const server=new McpServer({name:'lyx-preview',version:'0.3.0'});
  new OpenAIExtensions(server);
  registerAppResource(server,'LyX document preview',uri,{},async()=>({contents:[{uri,mimeType:RESOURCE_MIME_TYPE,text:await readFile(viewerURL,'utf8'),_meta:{ui:{prefersBorder:false},'openai/ui':{preferredDisplayMode:'inline',availableDisplayModes:['inline','fullscreen']}}}]}));
  for (const resourceUri of nativeResourceUris)
    registerAppResource(server,`LyX native editor ${resourceUri.split('/').at(-1)}`,resourceUri,{},async()=>({contents:[{uri:resourceUri,mimeType:RESOURCE_MIME_TYPE,text:await readFile(nativeURL,'utf8'),_meta:{ui:{prefersBorder:false,permissions:{clipboardWrite:{}}},'openai/ui':{preferredDisplayMode:'inline',availableDisplayModes:['inline','fullscreen']}}}]}));
  registerAppTool(server,'view_lyx_file',{
    title:'Edit a LyX document',description:'Open the native LyX editor in the side panel to edit text and formulas, and add selected content to the current chat.',
    inputSchema:z.object({file:z.object({name:z.string(),resourceUri:z.string()}).optional()}),annotations,
    _meta:{ui:{resourceUri:nativeUri,visibility:['app']},'openai/ui':{entrypoints:[{type:'file',extensions:['.lyx']}]}}
  },async()=>({content:[]}));
  registerAppTool(server,'open_lyx',{
    title:'Open the native LyX editor',description:'Open a local .lyx file in the native LyX editor to edit text and formulas and discuss selected content.',
    inputSchema:z.object({path:z.string().describe('Absolute path to a local .lyx file')}),annotations,
    _meta:{ui:{resourceUri:nativeUri,visibility:['model','app']}}
  },async({path})=>nativeResult(await openNative(path)));
  server.registerTool('start_native_lyx',{
    title:'Connect to native LyX',description:'Connect to the native LyX editor for the current file.',inputSchema:z.object({}),annotations,
    _meta:{ui:{visibility:['app']}}
  },async(_,context)=>{
    const path=getResourcePath(context.mcpReq?._meta);
    if(!path)throw new Error('The host did not provide a local path for the current .lyx file; use open_lyx to open it.');
    return nativeResult(await openNative(path));
  });
  server.registerTool('reopen_native_lyx',{
    title:'Reopen an exited LyX editor',
    description:'After the user chooses Reopen editor, open a replacement only when the owning service confirms the previous native process exited. Native recovery prompts remain interactive.',
    inputSchema:z.object({sessionId:nativeSessionId}).strict(),annotations,
    _meta:{ui:{visibility:['app']}}
  },async({sessionId},context)=>{
    try{return nativeResult(await reopenNative(sessionId,{signal:context.mcpReq?.signal}));}
    catch(error){return nativeUiError(error);}
  });
  server.registerTool('native_lyx_rpc',{
    title:'Native LyX editor operation',description:'Relay native editor frames, input, and selections through the current plugin connection.',
    inputSchema:z.object({sessionId:z.string().min(1).max(128),method:z.enum(nativeRpcMethods),params:z.record(z.string(),z.unknown()).default({})}).strict(),
    annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
    _meta:{ui:{visibility:['app']}}
  },async(args,context)=>{
    try{
      const replyWithState=args.method==='input' && args.params.replyWithState===true;
      const options={signal:context.mcpReq?.signal};
      const params={...args.params};
      if(replyWithState)delete params.replyWithState;
      let result=await rpc({...args,params},options);
      if(replyWithState && !result.error){
        // Native input acknowledges before Qt delivers the posted event. Keep
        // the existing state barrier, but complete both operations inside one
        // host round trip. The marker lets old servers remain compatible.
        result={...await rpc({sessionId:args.sessionId,method:'state',params:{}},options),stateAfterInput:true};
      }
      if(args.method==='selection' && args.params.captureEdit===true && !result.error){
        // A rebuilt panel and native engine can still use an old MCP service.
        // Only this service knows which editing tools it has registered.
        result={...result,modelCapabilities:{selectionSnapshots:true}};
      }
      return{content:[],_meta:{'lyx/rpc':result}};
    }
    catch(error){return nativeUiError(error);}
  });
  server.registerTool('read_native_lyx',{
    title:'Read the active native LyX document',
    description:'Read the active document in a native session, including its complete unsaved source, source revision, current selection, and positions. Use this snapshot\'s path, sourceRevision, and clipboardSelection for replacements. editingSupported requires native selection replacement and input-method composition protection. inputMethod.composing indicates unfinished input-method composition.',
    inputSchema:z.object({sessionId:nativeSessionId}).strict(),
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    _meta:{ui:{visibility:['model']}}
  },async({sessionId},context)=>{
    try{
      const snapshot=await rpc({sessionId,method:'selection',params:{}},{signal:context.mcpReq?.signal});
      return modelResult(modelSnapshot(snapshot,sessionId));
    }catch(error){return modelError(error,sessionId);}
  });
  server.registerTool('read_native_lyx_selection',{
    title:'Capture a compact native LyX selection',
    description:'Capture the selected text or formula and a revision-checked edit target without returning the whole document. If attached LyX context already contains a snapshotId, use replace_native_lyx_snapshot directly; no read is needed. A snapshot survives cursor movement, expires after 30 minutes or 32 newer captures, and rejects changes to the document. An old engine may return editingSupported:false; use read_native_lyx for its legacy editing workflow.',
    inputSchema:z.object({sessionId:nativeSessionId}).strict(),
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
    _meta:{ui:{visibility:['model']}}
  },async({sessionId},context)=>{
    try{
      const value=requireNativeResult(await rpc({sessionId,method:'selection',params:{captureEdit:true}},{signal:context.mcpReq?.signal}));
      const parsed=compactSelection.safeParse(value);
      if(!parsed.success)throw new Error('Native LyX did not return a valid selection. Use read_native_lyx to inspect this older session.');
      const {ready,clipboardSelection,...target}=parsed.data;
      return modelResult({sessionId,...target,selection:clipboardSelection,editingSupported:!!target.snapshotId});
    }catch(error){return modelError(error,sessionId);}
  });
  server.registerTool('replace_native_lyx_snapshot',{
    title:'Edit a shared native LyX selection',
    description:'Apply text or math to the snapshotId in attached LyX selection context or read_native_lyx_selection. Call directly without rereading the document or restoring its highlight. The native engine verifies the exact saved revision and range, preserves unsaved work, and creates one undo step without saving. Moving the cursor is allowed; document changes require a fresh selection. Retrying the identical snapshotId and replacement returns the original receipt without editing twice. replayed:true reports that past edit, not the current document state.',
    inputSchema:z.object({sessionId:nativeSessionId,snapshotId,replacement:typedReplacement}).strict(),
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false},
    _meta:{ui:{visibility:['model']}}
  },async({sessionId,snapshotId,...params},context)=>{
    let applied=false;
    try{
      const changed=await rpc({sessionId,method:'clipboard',params:{action:'replace-snapshot',snapshotId,...params}},{signal:context.mcpReq?.signal});
      applied=changed?.applied===true;
      requireNativeResult(changed);
      const parsed=snapshotReceipt.safeParse(changed);
      if(!parsed.success || parsed.data.snapshotId!==snapshotId)
        throw new Error('Native LyX did not return a valid receipt for this selection edit.');
      return modelResult({sessionId,...parsed.data});
    }catch(error){
      const result=modelError(error,sessionId,{write:true,attempted:true,applied});
      const data=result.structuredContent;
      if(data.outcome==='unknown'){
        delete data.readBeforeRetry;
        data.retrySameSnapshot=true;
        data.message=`Retry only the identical snapshotId and replacement to recover its receipt without applying twice. ${String(error?.message??'The native result was not confirmed').slice(0,2000)}`;
      }
      return {...modelResult(data),isError:true};
    }
  });
  server.registerTool('replace_native_lyx_selection',{
    title:'Replace the current native LyX selection',
    description:'Replace the current document selection in a native session with text or a formula. First read the document and pass back its exact path, sourceRevision, and document selection. The native engine atomically checks the revision and selection and rejects stale requests. Changes enter LyX undo history and are not saved automatically. If the outcome is uncertain, read again before retrying.',
    inputSchema:replacementInput,
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false},
    _meta:{ui:{visibility:['model']}}
  },async({sessionId,...params},context)=>{
    let attempted=false,applied=false;
    try{
      const options={signal:context.mcpReq?.signal};
      const state=requireNativeResult(await rpc({sessionId,method:'state',params:{}},options));
      if(state.ready!==true)throw new Error('The native LyX document is not ready; read it again first.');
      if(!supportsModelEditing(state))
        throw new Error('This native LyX session does not support guarded model replacement. Reading and manual editing remain available; use an updated native engine before editing through model tools.');
      attempted=true;
      const changed=await rpc({sessionId,method:'clipboard',params:{action:'replace-selection',...params,sourceRevision:params.sourceRevision.toLowerCase()}},options);
      applied=changed?.applied===true;
      requireNativeResult(changed);
      if(!applied)throw new Error('Native LyX did not explicitly confirm that the selection was replaced.');
      const snapshot=modelSnapshot(changed,sessionId);
      return modelResult({...snapshot,applied:true,previousSourceRevision:params.sourceRevision.toLowerCase()});
    }catch(error){return modelError(error,sessionId,{write:true,attempted,applied});}
  });
  registerAppTool(server,'open_lyx_preview',{
    title:'Open a read-only LyX preview',description:'Open a read-only HTML preview to investigate rendering issues. Use open_lyx for native editing.',
    inputSchema:z.object({path:z.string().describe('Absolute path to a local .lyx file')}),annotations,
    _meta:{ui:{resourceUri:uri,visibility:['model','app']}}
  },async({path})=>result(await renderFile(path)));
  server.registerTool('render_lyx',{
    title:'Render LyX',description:'Render LyX source already open in the viewer.',
    inputSchema:z.object({source:z.string().max(4*1024*1024)}),annotations,
    _meta:{ui:{visibility:['app']}}
  },async({source},context)=>{
    const path=getResourcePath(context.mcpReq?._meta);
    return result(await renderLyx(source,path));
  });
  return server;
}
export function serveLyxStdio(factory=createServer){
  // Base64 for an allowed 8 MiB image exceeds MCP's default 10 MiB buffer.
  // Allow its JSON-RPC envelope here; the relay still applies the smaller,
  // operation-specific HTTP limits before forwarding to the native engine.
  return serveStdio(factory,{transport:new StdioServerTransport(process.stdin,process.stdout,
    {maxBufferSize:imageNativeRequestBytes+64*1024})});
}
if(process.argv[1] && new URL(`file://${process.argv[1]}`).href===import.meta.url) serveLyxStdio();
