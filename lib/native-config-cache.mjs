import {lstat,stat,realpath,readdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {resolve,join,dirname,delimiter} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

export const nativeConfigFiles=Object.freeze(['lyxrc.defaults','lyxmodules.lst','textclass.lst',
  'packages.lst','lyxciteengines.lst','xtemplates.lst']);
const entries=new Map();
const ttlMs=5*60*1000,maxEntries=16,maxParticipants=32,maxFileBytes=2*1024*1024;
const tools=['latex','pdflatex','xelatex','lualatex','kpsewhich','python3','python','gs','convert','magick','inkscape','pandoc','tex2lyx'];
const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const missing=error=>{if(error.code==='ENOENT'||error.code==='ENOTDIR')return null;throw error;};

// This is deliberately a broker-lifetime cache, not an installation artifact.
// Inputs are bounded to 4096 paths / 16 MiB and 64 PATH or TeX roots. Unknown or
// oversized environments fall back to LyX configuration. PATH directory/tool
// metadata and TeX Live databases detect ordinary installs and upgrades; they
// cannot detect every external program's private data. A five-minute TTL bounds
// that residual staleness. Environment values are hashed, never persisted.
async function stamp(path) {
  const info=await lstat(path).catch(missing);
  if(!info)return null;
  // Parent directories such as /Library/TeX/texbin may themselves be symlinks.
  const target=await realpath(path);
  const value=info.isSymbolicLink()?await stat(target):info;
  return {path,target,type:value.isDirectory()?'directory':value.isFile()?'file':'other',
    size:value.size,mtime:value.mtimeMs,ctime:value.ctimeMs,ino:value.ino,link:info.isSymbolicLink()};
}
async function boundedText(path) {
  const info=await stamp(path);
  if(!info||info.type!=='file'||info.size>maxFileBytes)throw new Error('Configuration file is missing or too large');
  return readFile(path,'utf8');
}
async function inputTree(path,budget,{content=true}={}) {
  if(++budget.paths>4096)throw new Error('Configuration input tree exceeds cache limits');
  const info=await stamp(path);
  if(!info)return [path,null];
  budget.latest=Math.max(budget.latest,info.mtime);
  if(info.type==='directory'){
    if(budget.visited.has(info.target))return [info,'already visited'];
    budget.visited.add(info.target);
    const names=(await readdir(path)).sort(),children=[];
    for(const name of names)children.push(await inputTree(join(path,name),budget,{content}));
    return [info,children];
  }
  if(info.type!=='file')throw new Error('Unsupported configuration input');
  if(!content)return info;
  budget.bytes+=info.size;
  if(budget.bytes>16*1024*1024)throw new Error('Configuration inputs exceed cache limits');
  return [info,hash(await readFile(path))];
}
async function environmentInputs(env,prefixes) {
  const pathEntries=(env.PATH??'').split(delimiter);
  if(pathEntries.some(path=>!path.startsWith('/')))throw new Error('Relative or empty PATH entries cannot be cached safely');
  const paths=[...new Set([...prefixes,...pathEntries])];
  if(paths.length>64)throw new Error('PATH exceeds cache limits');
  const dirs=await Promise.all(paths.map(path=>stamp(resolve(path))));
  const found=[];
  for(const name of tools){
    const candidates=[];
    for(const directory of paths){const item=await stamp(resolve(directory,name));if(item?.type==='file')candidates.push(item);}
    found.push([name,candidates]);
  }
  const roots=new Set();
  for(const item of found.find(([name])=>name==='kpsewhich')?.[1]??[])
    if(/\/bin\/[^/]+\/kpsewhich$/.test(item.target))roots.add(dirname(dirname(dirname(item.target))));
  if(env.HOME){roots.add(join(env.HOME,'texmf'));roots.add(join(env.HOME,'Library','texmf'));}
  for(const [name,value] of Object.entries(env)){
    if(!/^(TEXMF\w*|TEXINPUTS|BIBINPUTS|BSTINPUTS)$/.test(name)||typeof value!=='string')continue;
    for(const part of value.split(delimiter)){
      const path=part.replace(/^!!/,'').replace(/\/+$/,'');
      if(path.startsWith('/')&&!/[{}$]/.test(path))roots.add(path);
    }
  }
  if(roots.size>64)throw new Error('TeX roots exceed cache limits');
  const tex=[],budget={paths:0,bytes:0,visited:new Set(),latest:0};
  for(const root of [...roots].sort()){
    const sentinels=await Promise.all(['ls-R','texmf.cnf','tlpkg/texlive.tlpdb','texmf-dist/ls-R','texmf-local/ls-R'].map(name=>stamp(join(root,name))));
    // Unindexed user trees need a bounded recursive metadata walk to notice
    // nested additions/removals. Never walk an entire TeX Live distribution.
    tex.push([root,sentinels,sentinels.some(Boolean)?await stamp(root):await inputTree(root,budget,{content:false})]);
  }
  return {environment:hash(Object.entries(env).filter(([,value])=>value!==undefined).sort(([a],[b])=>a.localeCompare(b))),dirs,found,tex};
}
const profileNames=['layouts','citeengines','xtemplates','lyxrc.dist','chkconfig.ltx'];
async function extraProfileNames(profile) {
  return (await readdir(profile).catch(error=>missing(error)??[])).sort()
    .filter(name=>/\.(tex|sty|cls|cfg|cnf|def|fd|ltx)$/i.test(name)&&name!=='chkconfig.ltx');
}
async function profileSignature(profile) {
  const budget={paths:0,bytes:0,visited:new Set(),latest:0},inputs=[];
  for(const name of [...profileNames,...await extraProfileNames(profile)]){
    const path=join(profile,name),tree=await inputTree(path,budget);
    // configure.py creates empty directories on first run; this does not
    // change the user's layout/module inputs.
    inputs.push(tree[1]===null&&['layouts','citeengines','xtemplates'].includes(name)
      ? [{path,type:'directory'},[]] : tree);
  }
  return hash(JSON.stringify(inputs,(key,value)=>{
    if(['target','size','mtime','ctime','ino','link'].includes(key))return undefined;
    return typeof value==='string'&&value.startsWith(profile+'/')?value.slice(profile.length+1):value;
  }));
}
async function identity({sourceProfile,engine,env}) {
  const library=await realpath(engine.library),binary=await stamp(engine.binary);
  if(!binary||binary.type!=='file')throw new Error('Native engine is unavailable');
  const configure=await boundedText(join(library,'configure.py'));
  const format=Number(/^\s*lyxrc_fileformat\s*=\s*(\d+)/m.exec(configure)?.[1]);
  if(!format)throw new Error('Unknown native configuration format');
  const budget={paths:0,bytes:0,visited:new Set(),latest:0},inputs=[],prefixes=[];
  for(const base of [library,sourceProfile]){
    const names=[...profileNames];
    if(base===library)names.push('configure.py','scripts/TeXFiles.py');
    else names.push('preferences');
    for(const name of names)inputs.push(await inputTree(join(base,name),budget));
    if(base===sourceProfile)for(const name of await extraProfileNames(base))inputs.push(await inputTree(join(base,name),budget));
    for(const name of base===sourceProfile?['lyxrc.dist','preferences']:['lyxrc.dist']){
      const path=join(base,name);if(!await stamp(path))continue;
      const text=await boundedText(path);
      for(const line of text.split('\n'))if(/^\s*\\path_prefix\b/.test(line)){
        const match=/^\s*\\path_prefix\s+"([^"\r\n]*)"\s*$/.exec(line);
        if(!match)throw new Error('Unsupported native path prefix');
        for(const prefix of match[1].split(delimiter).filter(Boolean)){
          if(!prefix.startsWith('/')||/[${}~]/.test(prefix))throw new Error('Unsupported native path prefix');
          prefixes.push(prefix);
        }
      }
    }
  }
  const environment=await environmentInputs(env,prefixes);
  const sourceMetadata=await Promise.all(nativeConfigFiles.map(name=>stamp(join(sourceProfile,name))));
  return {format,latestInput:budget.latest,key:hash({version:engine.version,binary,library,inputs,environment,sourceMetadata})};
}
async function configuration(profile,format,{completedSource=false}={}) {
  const paths=[...nativeConfigFiles,'preferences','configure.log','.lyx_configure_lock'].map(name=>join(profile,name));
  const before=await Promise.all(paths.map(stamp));
  // LyX releases the advisory lock but keeps this file after configuration.
  // Its existence cannot indicate whether configure.py is running. Keep its
  // metadata in the stable snapshot; producers additionally require ready:true.
  const files={};
  for(let i=0;i<nativeConfigFiles.length;i++){
    if(!before[i]||before[i].link||before[i].type!=='file')throw new Error('Incomplete configuration');
    files[nativeConfigFiles[i]]=await boundedText(paths[i]);
  }
  if(!new RegExp(`^Format[ \\t]+${format}[ \\t]*$`,'m').test(files['lyxrc.defaults']))throw new Error('Configuration format mismatch');
  const privatePaths=new Set([profile,await realpath(profile)]);
  for(const path of [...privatePaths])if(path.startsWith('/private/var/'))privatePaths.add(path.slice('/private'.length));
  for(const text of Object.values(files))for(const path of privatePaths)
    if(text.includes(path))throw new Error('Configuration contains a private profile path');
  const preferences=before[6]?hash(await boundedText(paths[6])):null;
  if(completedSource){
    // Unlike our producers, a desktop source has no ready-state proof. The
    // pinned configure.py truncates this log before any output, and its final
    // cleanup logs wrap_chkconfig.log only after all six outputs are complete.
    // Missing/unknown logs (including --keep-temps) conservatively reconfigure.
    const log=await boundedText(join(profile,'configure.log'));
    if(!/^INFO: \+Running LyX configure with Python /m.test(log)
      ||/^(?:ERROR|CRITICAL):/m.test(log)
      ||!/(?:^|\n)DEBUG: (?:Removing file wrap_chkconfig\.log|No need to remove file wrap_chkconfig\.log \(it does not exists\))\s*$/.test(log))
      throw new Error('Source configuration completion is unverified');
  }
  const after=await Promise.all(paths.map(stamp));
  if(hash(before)!==hash(after))throw new Error('Configuration changed while being read');
  return {files:Object.freeze(files),stamp:hash({metadata:after,files,preferences}),
    oldest:Math.min(...before.slice(0,6).map(item=>item.mtime))};
}
async function clearGenerated(profile) {
  await Promise.all(nativeConfigFiles.map(name=>unlink(join(profile,name)).catch(error=>{
    if(error.code!=='ENOENT')throw error;
  })));
}
async function valid(entry,now) {
  if(!entry||now-entry.created>=ttlMs||now<entry.created||entry.participants.size>maxParticipants)return false;
  try{
    for(const [profile,expected] of [...entry.participants])
      if((await configuration(profile,entry.format)).stamp!==expected)return false;
    return true;
  }catch{return false;}
}
async function restore(profile,files) {
  const staging=nativeConfigFiles.map(name=>join(profile,`.lyx-config-${randomUUID()}-${name}`));
  try{
    await Promise.all(nativeConfigFiles.map((name,index)=>writeFile(staging[index],files[name],{mode:0o600,flag:'wx'})));
    for(let i=0;i<nativeConfigFiles.length;i++)await rename(staging[i],join(profile,nativeConfigFiles[i]));
  }catch(error){await clearGenerated(profile);throw error;}
  finally{await Promise.all(staging.map(path=>unlink(path).catch(()=>{})));}
}

/** Call after copying the source profile, before spawning LyX. A miss leaves
 * no unverified generated metadata in the private profile. Call the returned
 * publishAfterReady with native state; ready:false permits a startup dialog to
 * remain open and does not consume the later publication opportunity. */
export async function prepareNativeConfigCache({sourceProfile,profile,engine,env=process.env,now=Date.now}={}) {
  let details,completed=false,canClear=false,privatePreferences,copiedInputs;
  const preferencesHash=async()=>{
    const file=join(profile,'preferences');return await stamp(file)?hash(await boundedText(file)):null;
  };
  const context={restored:false,authoritative:false,reason:'cache miss',async publishAfterReady(state){
    if(state?.ready!==true||completed||!details)return false;
    completed=true;
    const decline=reason=>{context.reason=`configuration not published: ${reason}`;return false;};
    let stage='checking configuration identity';
    try{
      const current=await identity({sourceProfile,engine,env});
      if(hash([current.key,privatePreferences])!==details.key)return decline('source, engine or environment inputs changed');
      if(await preferencesHash()!==privatePreferences)return decline('private preferences changed');
      if(await profileSignature(profile)!==copiedInputs)return decline('private configuration inputs changed');
      stage='reading completed configuration';
      const snapshot=await configuration(profile,details.format);
      stage='verifying the configuration generation';
      for(let attempt=0;attempt<4;attempt++){
        const previous=entries.get(details.key),usable=await valid(previous,now());
        if((await configuration(profile,details.format)).stamp!==snapshot.stamp)return decline('configuration changed during publication');
        if(entries.get(details.key)!==previous)continue;
        const entry=usable?previous:{created:now(),format:details.format,files:snapshot.files,participants:new Map()};
        // No await separates publication and participant registration, so
        // concurrent first opens retain the first valid complete generation.
        entry.participants.set(profile,snapshot.stamp);
        if(!usable){
          if(entries.size>=maxEntries)entries.delete(entries.keys().next().value);
          entries.set(details.key,entry);
        }
        context.reason='verified configuration published';return true;
      }
      return decline('concurrent publications did not settle');
    }catch(error){
      // Native filesystem errors can include arbitrary paths; expose only a
      // stage and system code, or one of this helper's fixed validation errors.
      return decline(`${stage}: ${error.code??error.message}`);
    }
  }};
  try{
    sourceProfile=resolve(sourceProfile);profile=await realpath(resolve(profile));
    sourceProfile=await realpath(sourceProfile).catch(error=>missing(error)??sourceProfile);
    if(sourceProfile===profile)throw new Error('A private profile must be separate from the source');
    canClear=true;
    privatePreferences=await preferencesHash();
    details=await identity({sourceProfile,engine,env});
    details.key=hash([details.key,privatePreferences]);
    copiedInputs=await profileSignature(sourceProfile);
    if(copiedInputs!==await profileSignature(profile))throw new Error('Copied configuration inputs do not match the source profile');
    const sourcePrefs=await stamp(join(sourceProfile,'preferences'))?await boundedText(join(sourceProfile,'preferences')):'';
    const copiedPrefs=await stamp(join(profile,'preferences'))?await boundedText(join(profile,'preferences')):'';
    if(!copiedPrefs.startsWith(sourcePrefs))throw new Error('Copied preferences do not match the source profile');
    const source=await configuration(sourceProfile,details.format,{completedSource:true}).catch(()=>null);
    if(source&&source.oldest>=details.latestInput){
      const copied=await configuration(profile,details.format).catch(()=>null);
      if(!copied||hash(copied.files)!==hash(source.files))throw new Error('Copied configuration does not match the source profile');
      context.authoritative=true;context.reason='current source configuration';completed=true;return context;
    }
    // In particular, copied LyX 2.4 Format38 files must not masquerade as
    // Format39 merely because fs.cp refreshed their timestamps.
    await clearGenerated(profile);
    const entry=entries.get(details.key);
    if(!await valid(entry,now())){
      entries.delete(details.key);return context;
    }
    await restore(profile,entry.files);
    const snapshot=await configuration(profile,details.format);
    entry.participants.set(profile,snapshot.stamp);
    context.restored=true;context.reason='verified configuration reused';completed=true;
  }catch(error){
    completed=true;context.reason=`configuration cache unavailable: ${error.message}`;
    // A partial restore must never become a seemingly complete configuration.
    // Cache failures otherwise remain nonfatal to normal native startup.
    if(canClear)await clearGenerated(profile).catch(()=>{});
  }
  return context;
}
