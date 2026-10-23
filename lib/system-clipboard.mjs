import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const helper=fileURLToPath(new URL('../dist/lyx-system-clipboard',import.meta.url));
const maxBytes=512*1024;
export const systemLyxClipboardAvailable=process.platform==='darwin' && existsSync(helper);

function decode(value){
  if(typeof value!=='string'||value.length>Math.ceil(maxBytes/3)*4)throw new Error('Invalid external clipboard text');
  const bytes=Buffer.from(value,'base64');
  if(bytes.toString('base64')!==value||bytes.length>maxBytes)throw new Error('Invalid external clipboard text');
  return bytes;
}
function readHelper(text,{signal}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(helper,[],{stdio:['pipe','pipe','ignore'],signal,timeout:5000});
    let output='',failed=false;
    const fail=()=>{if(!failed){failed=true;reject(new Error('Could not read native LyX clipboard data. Copy the selection again and retry.'));}};
    child.on('error',fail);child.stdin.on('error',fail);
    child.stdout.on('data',data=>{output+=data;if(output.length>1024*1024){fail();child.kill();}});
    child.once('close',code=>{
      if(failed)return;
      if(code!==0){fail();return;}
      try{resolve(JSON.parse(output));}catch{fail();}
    });
    child.stdin.end(JSON.stringify({text}));
  });
}

export async function recoverExternalLyxFormats(formats,{required=false,signal,read=readHelper}={}){
  if(!formats||typeof formats!=='object'||Array.isArray(formats))throw new Error('Invalid clipboard formats');
  if(formats['application/x-lyx'])return formats;
  if(!formats['text/plain'])throw new Error('The external paste has no text to verify');
  const text=decode(formats['text/plain']).toString('utf8');
  if(!text)throw new Error('The external paste has no text to verify');
  const result=await read(text,{signal});
  if(result?.status==='matched'){
    const native=decode(result.lyx);
    if(!native.length)throw new Error('The native LyX clipboard data is empty');
    // The original native bytes already contain the selected prose and math.
    // Dropping HTML also avoids the native fallback importer losing formulas.
    return {'application/x-lyx':result.lyx};
  }
  if(result?.status==='invalid')throw new Error('The native LyX clipboard data is invalid or exceeds 512 KiB. Copy a smaller selection.');
  if(!['unavailable','mismatch'].includes(result?.status))throw new Error('Invalid native clipboard response');
  if(required)throw new Error('The native LyX clipboard no longer matches this paste. Copy the selection in desktop LyX again and retry.');
  return formats;
}
