// Shared guarded editing for MCP and the CLI. No MCP transport is loaded here.
import {z} from 'zod';
import {createHash} from 'node:crypto';
import {callNativeRpc} from './native-broker-client.mjs';

export const nativeSessionId=z.string().min(1).max(128);
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
export const replacementInput=z.object({
  sessionId:nativeSessionId,
  path:z.string().min(1).max(4096).regex(/^[^\0]*$/u),
  sourceRevision:revision,
  selection:z.object({
    kind:z.literal('document'),hasSelection:z.literal(true),text:boundedEditText,
    start:nativePositions,end:nativePositions,
  }).strict(),
  replacement:typedReplacement,
  trackChanges:z.boolean().default(true).describe('Record native revisions by default; disable only for an explicitly requested direct edit.'),
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
  capabilities:z.object({editSelection:z.boolean().optional(),compositionGuard:z.boolean().optional(),review:z.boolean().optional(),trackedReplacement:z.boolean().optional()}).optional(),
  review:z.object({tracking:z.boolean(),hasChanges:z.boolean().optional(),comments:z.array(z.object({
    id:z.string(),resolved:z.boolean(),quote:z.string(),text:z.string(),anchor:nativePositions,
  })).optional()}).optional(),
});
const editRejections=new Set(['not_editable','document_mismatch','revision_conflict','selection_conflict','invalid_replacement','input_pending','snapshot_expired','snapshot_used']);
const compactSelection=z.object({
  ready:z.literal(true),path:z.string().min(1),modified:z.boolean(),sourceRevision:revision,
  clipboardSelection:documentSelection,
  snapshotId:snapshotId.optional(),snapshotTtlSeconds:z.number().int().positive().optional(),
  selectionFormat:z.enum(['text','math']).optional(),
  plainTextSelection:z.boolean().optional(),
}).refine(value=>!value.snapshotId || (value.clipboardSelection.hasSelection && value.selectionFormat && value.snapshotTtlSeconds),
  'A native edit target must identify a selected passage, replacement format and lifetime');
const snapshotReceipt=z.object({
  applied:z.literal(true),path:z.string().min(1),modified:z.boolean(),
  sourceRevision:revision,previousSourceRevision:revision,snapshotId,replayed:z.boolean(),tracked:z.boolean().optional(),
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

export const editSchemas=Object.freeze({
  read_native_lyx:z.object({sessionId:nativeSessionId}).strict(),
  read_native_lyx_selection:z.object({sessionId:nativeSessionId}).strict(),
  replace_native_lyx_snapshot:z.object({sessionId:nativeSessionId,snapshotId,replacement:typedReplacement,trackChanges:z.boolean().default(true)}).strict(),
  replace_native_lyx_selection:replacementInput,
  review_native_lyx:z.object({sessionId:nativeSessionId,path:z.string().min(1).max(4096),sourceRevision:revision,
      operation:z.enum(['comment-add','comment-locate','comment-resolve','next','previous','accept','reject','track']),
      selection:documentSelection.strict().optional(),text:z.string().min(1).max(16000).regex(/^[^\0]*$/u).optional(),
      commentId:z.string().uuid().optional(),resolved:z.boolean().optional(),enabled:z.boolean().optional(),
    }).strict(),
});

export function createNativeEditor({rpc=callNativeRpc}={}) {
  const trackedSessions=new Set();
  function observe(sessionId,value) {
    if(value?.error || value?.isError || value?.capabilities?.trackedReplacement!==true)return;
    trackedSessions.delete(sessionId);
    trackedSessions.add(sessionId);
    if(trackedSessions.size>128)trackedSessions.delete(trackedSessions.values().next().value);
  }
  const handlers={
    read_native_lyx:async({sessionId},context)=>{
      try{
        const snapshot=await rpc({sessionId,method:'selection',params:{}},{signal:context.signal});
        const result=modelSnapshot(snapshot,sessionId);
        observe(sessionId,snapshot);
        return modelResult(result);
      }catch(error){return modelError(error,sessionId);}
    },
    read_native_lyx_selection:async({sessionId},context)=>{
      try{
        const value=requireNativeResult(await rpc({sessionId,method:'selection',params:{captureEdit:true,compact:true}},{signal:context.signal}));
        const parsed=compactSelection.safeParse(value);
        if(!parsed.success)throw new Error('Native LyX did not return a valid selection. Use read_native_lyx to inspect this older session.');
        observe(sessionId,value);
        const {ready,clipboardSelection,...target}=parsed.data;
        return modelResult({sessionId,...target,selection:clipboardSelection,editingSupported:!!target.snapshotId});
      }catch(error){return modelError(error,sessionId);}
    },
    replace_native_lyx_snapshot:async({sessionId,snapshotId,...params},context)=>{
      let applied=false,attempted=false;
      try{
        if(params.trackChanges && !trackedSessions.has(sessionId)){
          const state=requireNativeResult(await rpc({sessionId,method:'state',params:{}},{signal:context.signal}));
          observe(sessionId,state);
          if(state.capabilities?.trackedReplacement!==true)throw new Error('Save and reopen the document in the updated engine to use tracked AI edits. No untracked edit was substituted.');
        }
        attempted=true;
        const changed=await rpc({sessionId,method:'clipboard',params:{action:'replace-snapshot',snapshotId,...params}},{signal:context.signal});
        applied=changed?.applied===true;
        requireNativeResult(changed);
        const parsed=snapshotReceipt.safeParse(changed);
        if(!parsed.success || parsed.data.snapshotId!==snapshotId)
          throw new Error('Native LyX did not return a valid receipt for this selection edit.');
        return modelResult({sessionId,...parsed.data});
      }catch(error){
        const result=modelError(error,sessionId,{write:true,attempted,applied});
        const data=result.structuredContent;
        if(data.outcome==='unknown'){
          delete data.readBeforeRetry;
          data.retrySameSnapshot=true;
          data.message=`Retry only the identical snapshotId and replacement to recover its receipt without applying twice. ${String(error?.message??'The native result was not confirmed').slice(0,2000)}`;
        }
        return {...modelResult(data),isError:true};
      }
    },
    replace_native_lyx_selection:async({sessionId,...params},context)=>{
      let attempted=false,applied=false;
      try{
        const options={signal:context.signal};
        const state=requireNativeResult(await rpc({sessionId,method:'state',params:{}},options));
        if(state.ready!==true)throw new Error('The native LyX document is not ready; read it again first.');
        if(!supportsModelEditing(state))
          throw new Error('This native LyX session does not support guarded model replacement. Reading and manual editing remain available; use an updated native engine before editing through model tools.');
        if(params.trackChanges && state.capabilities?.trackedReplacement!==true)
          throw new Error('This session does not support tracked AI edits. Save and reopen the document in the updated engine; an untracked edit was not substituted.');
        attempted=true;
        const changed=await rpc({sessionId,method:'clipboard',params:{action:'replace-selection',...params,sourceRevision:params.sourceRevision.toLowerCase()}},options);
        applied=changed?.applied===true;
        requireNativeResult(changed);
        if(!applied)throw new Error('Native LyX did not explicitly confirm that the selection was replaced.');
        const snapshot=modelSnapshot(changed,sessionId);
        return modelResult({...snapshot,applied:true,tracked:changed.tracked===true,previousSourceRevision:params.sourceRevision.toLowerCase()});
      }catch(error){return modelError(error,sessionId,{write:true,attempted,applied});}
    },
    review_native_lyx:async({sessionId,...params},context)=>{
      let attempted=false,applied=false;
      try{
        const options={signal:context.signal};
        const state=requireNativeResult(await rpc({sessionId,method:'state',params:{}},options));
        if(state.ready!==true || state.capabilities?.review!==true || state.capabilities?.compositionGuard!==true)
          throw new Error('This session does not support native review. Save and reopen the document in the updated engine.');
        attempted=true;
        const changed=await rpc({sessionId,method:'clipboard',params:{action:'review',...params,sourceRevision:params.sourceRevision.toLowerCase()}},options);
        applied=changed?.applied===true;requireNativeResult(changed);
        if(!applied)throw new Error('Native LyX did not confirm the review operation.');
        return modelResult({...modelSnapshot(changed,sessionId),applied:true});
      }catch(error){return modelError(error,sessionId,{write:true,attempted,applied});}
    }
  };
  return {
    observe,
    async call(name,args,context={}) {
      const schema=Object.hasOwn(editSchemas,name)?editSchemas[name]:null;
      const parsed=schema?.safeParse(args);
      if(!parsed?.success)return modelError(new Error('Invalid native edit command or arguments'),args?.sessionId,
        {write:typeof name==='string' && (name.startsWith('replace_') || name==='review_native_lyx')});
      return handlers[name](parsed.data,context);
    },
  };
}
