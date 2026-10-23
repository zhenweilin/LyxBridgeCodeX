#!/usr/bin/env node
import {readFile,stat} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {once} from 'node:events';
import {createCli,executeLines} from '../lib/native-cli.mjs';

const help=`Usage: lyxctl <command> [options]
  open <document.lyx>                      Open or reuse a native document
  selection --session ID                  Capture a compact edit target
  read --session ID                       Read the complete unsaved source
  replace --session ID --snapshot UUID --text-file FILE [--format text|math]
  apply --session ID --edits-file FILE     Exact edits within the current text selection
  request --request-file FILE             Execute one JSON command (including review)
  serve                                   Execute ordered JSONL requests from stdin

All results are JSON. Replacements track revisions by default; --direct opts out.
No command saves the document. Failed commands exit nonzero. Serve processes each
request independently and emits its own result; inspect error before continuing.
An apply file is [{"find":"unique original text","replace":"new text"},...].
A request is {"id":"optional","command":"selection","args":{"sessionId":"..."}}.
`;
async function boundedFile(path){
  if((await stat(path)).size>1024*1024)throw new Error('Input files must not exceed 1 MiB');
  const value=await readFile(path,'utf8');
  if(Buffer.byteLength(value)>1024*1024)throw new Error('Input files must not exceed 1 MiB');
  return value;
}
async function print(value){if(!process.stdout.write(JSON.stringify(value)+'\n'))await once(process.stdout,'drain');}
try{
  const {values,positionals}=parseArgs({allowPositionals:true,options:{
    session:{type:'string'},snapshot:{type:'string'},'text-file':{type:'string'},format:{type:'string'},
    'edits-file':{type:'string'},'request-file':{type:'string'},direct:{type:'boolean'},help:{type:'boolean'},
  }});
  const [command,...paths]=positionals;
  if(values.help||!command){process.stdout.write(help);}
  else{
    const allowed={open:[],selection:['session'],read:['session'],
      replace:['session','snapshot','text-file','format','direct'],apply:['session','edits-file','direct'],
      request:['request-file'],serve:[]};
    if(!Object.hasOwn(allowed,command)||Object.keys(values).some(key=>!allowed[command].includes(key))
      ||paths.length!==(command==='open'?1:0))throw new Error('Invalid command options; run lyxctl --help');
    const execute=createCli();
    if(command==='serve'){
      for await(const result of executeLines(process.stdin,execute)){await print(result);if(result.error)process.exitCode=1;}
    }else{
      let request={command,args:{sessionId:values.session}};
      if(command==='open')request.args={path:paths[0]};
      if(command==='replace')request.args={...request.args,snapshotId:values.snapshot,
        replacement:{format:values.format??'text',text:await boundedFile(values['text-file'])},trackChanges:!values.direct};
      if(command==='apply')request.args={...request.args,edits:JSON.parse(await boundedFile(values['edits-file'])),trackChanges:!values.direct};
      if(command==='request')request=JSON.parse(await boundedFile(values['request-file']));
      const result=await execute(request);await print(result);if(result.error)process.exitCode=1;
    }
  }
}catch(error){await print({error:true,message:String(error?.message??'The command failed').slice(0,2000)});process.exitCode=1;}
