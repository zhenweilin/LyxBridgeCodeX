import {stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
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
