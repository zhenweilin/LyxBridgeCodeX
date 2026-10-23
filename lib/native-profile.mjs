import {stat,lstat,mkdir,cp,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {lyxUpstream} from './native-engine.mjs';

export async function nativeUserProfile({home=homedir(),override=process.env.LYX_USER_PROFILE}={}) {
  if(override)return resolve(override);
  const preferred=join(home,`Library/Application Support/LyX-${lyxUpstream.series}`);
  // Import existing settings into the private engine profile when the user
  // has not installed desktop LyX 2.5 yet. Never alter either desktop profile.
  for(const path of [preferred,join(home,'Library/Application Support/LyX-2.4')]){
    try{if((await stat(path)).isDirectory())return path;}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return preferred;
}

export async function prepareNativeUserProfile({source,destination}) {
  await mkdir(destination,{recursive:true});
  try{
    await cp(source,destination,{recursive:true,preserveTimestamps:true,filter:async path=>{
      // Desktop LyX can keep live sockets and FIFO pipes beside its settings.
      const entry=await lstat(path);
      return entry.isDirectory()||entry.isFile()||entry.isSymbolicLink();
    }});
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const preferences=join(destination,'preferences');
  let text=await readFile(preferences,'utf8').catch(error=>{
    if(error.code==='ENOENT')return '';throw error;
  });
  // Keep fonts and key bindings. Autosave writes recovery snapshots, not the
  // formal document. Cocoa styling requires a real window, so use Fusion.
  text+='\n\\load_session false\n\\gui_language "english"\n\\ui_style "Fusion"\n\\draw_strategy backingstore\n\\show_banner false\n\\autosave 60\n';
  // A copied preferences symlink may still point into the desktop profile.
  // Replace that private directory entry instead of following it when writing.
  const temporary=join(destination,`.codex-preferences-${randomUUID()}`);
  try{
    await writeFile(temporary,text,{mode:0o600,flag:'wx'});
    await rename(temporary,preferences);
  }finally{await rm(temporary,{force:true});}
}
