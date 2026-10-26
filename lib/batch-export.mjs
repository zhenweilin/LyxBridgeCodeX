import {execFile} from 'node:child_process';
import {constants} from 'node:fs';
import {cp,copyFile,lstat,mkdtemp,open,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,extname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';

const run=promisify(execFile);
const latexFormats=new Set(['latex','pdflatex','xetex','luatex','dviluatex']);

export async function prepareBatchUserProfile({source,destination}) {
  if(!(await stat(source)).isDirectory())throw new Error('The LyX profile must be a directory');
  await cp(source,destination,{
    recursive:true,dereference:true,preserveTimestamps:true,
    // Copy linked configuration into the private profile too, so LyX cannot
    // rewrite desktop settings through a symlink. Skip live sockets and FIFOs.
    filter:async path=>{const entry=await stat(path);return entry.isDirectory()||entry.isFile();},
  });
  const preferences=join(destination,'preferences');
  const original=await readFile(preferences,'utf8').catch(error=>{
    if(error.code==='ENOENT')return '';throw error;
  });
  // LyX 2.4.1 applies non-default Qt styles even without a GUI application.
  // Fusion and QT_STYLE_OVERRIDE do not avoid that initialization crash.
  const safe=original.replace(/^\s*\\ui_style\s+[^\r\n]*/gm,'\\ui_style "default"');
  await writeFile(preferences,`${safe}\n\\load_session false\n\\ui_style "default"\n`);
}

/** Export a saved document to LaTeX without changing its desktop profile. */
export async function exportLyxLatex({binary,profile,input,output,format='pdflatex',timeout=120000}) {
  if(!binary||!profile||!input||!output)throw new Error('binary, profile, input, and output are required');
  if(!latexFormats.has(format))throw new Error(`Unsupported LaTeX export format: ${format}`);
  if(!Number.isSafeInteger(timeout)||timeout<=0)throw new Error('timeout must be a positive integer');
  input=resolve(input);output=resolve(output);profile=resolve(profile);
  if(extname(input).toLowerCase()!=='.lyx'||!(await stat(input)).isFile())
    throw new Error('Input must be a saved .lyx file');
  if(extname(output).toLowerCase()!=='.tex')throw new Error('Output must have a .tex extension');
  await lstat(output).then(()=>{throw new Error(`Output already exists: ${output}`);},error=>{
    if(error.code!=='ENOENT')throw error;
  });
  const temporary=await mkdtemp(join(tmpdir(),'lyx-batch-'));
  // Keep staging beside the destination so relative asset paths survive the
  // final copy. Never use an existing export as evidence of success.
  const staging=join(dirname(output),`.lyx-export-${randomUUID()}.tex`);
  let ownsStaging=false;
  try{
    const privateProfile=join(temporary,'profile');
    await prepareBatchUserProfile({source:profile,destination:privateProfile});
    const reservation=await open(staging,'wx',0o600);ownsStaging=true;await reservation.close();
    try{
      await run(binary,['-batch','-userdir',privateProfile,'--force-overwrite','main','-E',format,staging,input],
        {timeout,maxBuffer:4*1024*1024});
    }catch(error){
      const reason=error.killed?'timed out':`failed (${error.code??error.signal??'unknown'})`;
      throw new Error(`LyX export ${reason}${error.stderr?`: ${error.stderr.trim()}`:''}`,{cause:error});
    }
    const result=await lstat(staging);
    if(!result.isFile()||result.size===0)throw new Error('LyX exited successfully but produced no LaTeX output');
    // COPYFILE_EXCL also protects a destination created while LyX was running.
    await copyFile(staging,output,constants.COPYFILE_EXCL);
    return {output,format,bytes:result.size};
  }finally{
    try{if(ownsStaging)await rm(staging,{force:true});}
    finally{await rm(temporary,{recursive:true,force:true});}
  }
}
