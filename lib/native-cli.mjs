import {createNativeEditor} from './native-editor.mjs';
import {openNativeDocument} from './native-broker-client.mjs';

const commands=Object.freeze({read:'read_native_lyx',selection:'read_native_lyx_selection',
  replace:'replace_native_lyx_snapshot',review:'review_native_lyx'});

// Resolve every edit against the original selection, then apply from the end.
// Ambiguous, overlapping and missing matches fail before any native mutation.
export function replaceSelectedText(text,edits) {
  if(!Array.isArray(edits)||!edits.length||edits.length>128)throw new Error('Supply 1–128 exact text edits');
  const ranges=[];
  for(const edit of edits){
    if(!edit||typeof edit.find!=='string'||!edit.find||typeof edit.replace!=='string'
      ||Object.keys(edit).some(key=>!['find','replace'].includes(key)))throw new Error('Each edit requires only find and replace strings');
    const start=text.indexOf(edit.find);
    if(start<0||text.indexOf(edit.find,start+1)>=0)throw new Error('Each find string must occur exactly once in the original selection');
    ranges.push({start,end:start+edit.find.length,text:edit.replace});
  }
  ranges.sort((a,b)=>a.start-b.start);
  for(let i=1;i<ranges.length;i++)if(ranges[i].start<ranges[i-1].end)throw new Error('Text edits must not overlap');
  for(const range of ranges.reverse())text=text.slice(0,range.start)+range.text+text.slice(range.end);
  if(text.length>128*1024||text.includes('\0'))throw new Error('The resulting selection exceeds the native text limit or contains NUL');
  return text;
}

export function createCli({editor=createNativeEditor(),openNative=openNativeDocument}={}) {
  return async function execute(request) {
    const id=request?.id;
    const wrap=result=>id===undefined?result:{id,...result};
    try{
      if(!request||typeof request!=='object'||Array.isArray(request)
        ||Object.keys(request).some(key=>!['id','command','args'].includes(key))
        ||(id!==undefined&&!(typeof id==='string'||Number.isSafeInteger(id))))throw new Error('Invalid command request');
      const {command,args}=request;
      if(command==='open'){
        if(!args||typeof args.path!=='string'||Object.keys(args).length!==1)throw new Error('Open requires a document path');
        const {sessionId,path}=await openNative(args.path);
        return wrap({sessionId,path});
      }
      if(command==='apply'){
        if(!args||typeof args.sessionId!=='string'||Object.keys(args).some(key=>!['sessionId','edits','trackChanges'].includes(key))
          ||(args.trackChanges!==undefined&&typeof args.trackChanges!=='boolean'))throw new Error('Invalid apply arguments');
        const capture=await editor.call('read_native_lyx_selection',{sessionId:args.sessionId});
        if(capture.isError)return wrap(capture.structuredContent);
        const target=capture.structuredContent;
        if(!target.editingSupported||target.selectionFormat!=='text')throw new Error('Apply requires an editable text selection');
        if(target.plainTextSelection!==true)throw new Error('Apply requires a single paragraph with uniform formatting, no formulas or tracked changes, and a current native engine');
        const text=replaceSelectedText(target.selection.text,args.edits);
        const result=await editor.call('replace_native_lyx_snapshot',{sessionId:args.sessionId,snapshotId:target.snapshotId,
          replacement:{format:'text',text},trackChanges:args.trackChanges??true});
        // Keep the exact request on uncertain writes so recovery can use the
        // original snapshot, rather than recapturing and applying twice.
        if(result.structuredContent.retrySameSnapshot)result.structuredContent.retryRequest={command:'replace',args:{
          sessionId:args.sessionId,snapshotId:target.snapshotId,replacement:{format:'text',text},trackChanges:args.trackChanges??true}};
        return wrap(result.structuredContent);
      }
      if(!Object.hasOwn(commands,command))throw new Error('Unknown command; use open, read, selection, replace, review or apply');
      return wrap((await editor.call(commands[command],args)).structuredContent);
    }catch(error){return wrap({error:true,message:String(error?.message??'The command failed').slice(0,2000)});}
  };
}

// Streaming keeps module loading, HTTP connections and verified capabilities
// warm. Await every request; edits must never overtake one another.
export async function* executeLines(input,execute) {
  let pending=Buffer.alloc(0);
  for await(const chunk of input){
    pending=Buffer.concat([pending,Buffer.from(chunk)]);
    let newline;
    while((newline=pending.indexOf(10))>=0){
      if(newline>1024*1024)throw new Error('A request exceeds 1 MiB');
      const line=pending.subarray(0,newline).toString('utf8');pending=pending.subarray(newline+1);
      if(!line.trim())continue;
      let request;
      try{request=JSON.parse(line);}catch{yield {error:true,message:'Invalid JSON request'};continue;}
      yield await execute(request);
    }
    if(pending.length>1024*1024)throw new Error('A request exceeds 1 MiB');
  }
  if(pending.toString('utf8').trim()){
    let request;
    try{request=JSON.parse(pending.toString('utf8'));}catch{yield {error:true,message:'Invalid JSON request'};return;}
    yield await execute(request);
  }
}
