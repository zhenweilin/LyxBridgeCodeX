import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,cp,rm,utimes,symlink,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareNativeConfigCache,nativeConfigFiles} from '../lib/native-config-cache.mjs';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'lyx-config-cache-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const sourceProfile=join(root,'source'),library=join(root,'library'),binary=join(root,'LyX');
  const bin=join(root,'bin'),home=join(root,'home'),tex=join(root,'tex');
  await Promise.all([sourceProfile,join(library,'layouts'),join(library,'scripts'),bin,home,tex].map(path=>mkdir(path,{recursive:true})));
  await Promise.all([
    writeFile(binary,'native engine'),writeFile(join(library,'configure.py'),'lyxrc_fileformat = 39\n'),
    writeFile(join(library,'chkconfig.ltx'),'package checks'),writeFile(join(library,'scripts','TeXFiles.py'),'index tools'),
    writeFile(join(library,'layouts','article.layout'),'article layout'),writeFile(join(sourceProfile,'preferences'),'\\screen_font_roman "Times"\n'),
    writeFile(join(bin,'latex'),'latex binary'),writeFile(join(tex,'ls-R'),'TeX file database'),
  ]);
  const engine={version:'2.5.3',binary,library},env={PATH:bin,HOME:home,TEXMFROOT:tex};
  let clock=1000;
  const options={sourceProfile,engine,env,now:()=>clock};
  async function profile(){
    const path=await mkdtemp(join(root,'profile-'));
    await cp(sourceProfile,path,{recursive:true,preserveTimestamps:true});
    const prefs=await readFile(join(path,'preferences'),'utf8').catch(()=> '');
    await writeFile(join(path,'preferences'),prefs+'\\autosave 60\n');
    return path;
  }
  async function prepare(path=undefined){const value=path??await profile();return {profile:value,cache:await prepareNativeConfigCache({...options,profile:value})};}
  async function generate(path,tag='A',{format=39,omit}={}){
    for(const name of nativeConfigFiles)if(name!==omit)await writeFile(join(path,name),
      name==='lyxrc.defaults'?`# Generated\nFormat ${format}\n# ${tag}\n`:`# ${name}: ${tag}\n`);
    await writeFile(join(path,'configure.log'),`INFO: +Running LyX configure with Python 3.12\n# ${tag}\nDEBUG: Removing file wrap_chkconfig.log\n`);
    await mkdir(join(path,'layouts'),{recursive:true});
  }
  async function seed(){const result=await prepare();await generate(result.profile);assert.equal(await result.cache.publishAfterReady({ready:true}),true);return result;}
  return {root,sourceProfile,library,binary,bin,tex,options,profile,prepare,generate,seed,advance:ms=>{clock+=ms;}};
}

test('only six metadata files are restored, with independent preferences and no document data',async t=>{
  const f=await fixture(t),first=await f.seed();
  await Promise.all(['session','bibFiles.lst','notes.lyx'].map(name=>writeFile(join(first.profile,name),'private data')));
  const second=await f.prepare();
  assert.equal(second.cache.restored,true);
  assert.equal((await readFile(join(second.profile,'preferences'),'utf8')).includes('\\autosave 60'),true);
  for(const name of ['session','bibFiles.lst','notes.lyx','configure.log'])await assert.rejects(access(join(second.profile,name)),{code:'ENOENT'});
  for(const name of nativeConfigFiles)assert.equal(await readFile(join(second.profile,name),'utf8'),await readFile(join(first.profile,name),'utf8'));
  assert.equal(await second.cache.publishAfterReady({ready:true}),false,'Restored contexts never republish live settings');
});

test('startup dialogs preserve one later ready publication opportunity, then publishing is idempotent',async t=>{
  const f=await fixture(t),first=await f.prepare();
  assert.equal(await first.cache.publishAfterReady({ready:false}),false);
  await f.generate(first.profile);
  assert.equal(await first.cache.publishAfterReady({ready:true}),true);
  assert.equal(await first.cache.publishAfterReady({ready:true}),false);
  assert.equal((await f.prepare()).cache.restored,true);
});

test('complete current source metadata bypasses cache only when copied bytes match',async t=>{
  const f=await fixture(t);await f.generate(f.sourceProfile);
  const future=new Date(Date.now()+1000);
  for(const name of nativeConfigFiles)await utimes(join(f.sourceProfile,name),future,future);
  const first=await f.prepare();assert.equal(first.cache.authoritative,true);assert.equal(first.cache.restored,false);
  const raced=await f.profile();await writeFile(join(raced,'packages.lst'),'mixed generation');
  const second=await f.prepare(raced);assert.equal(second.cache.authoritative,false);
  assert.match(second.cache.reason,/does not match/);
  for(const name of nativeConfigFiles)await assert.rejects(access(join(raced,name)),{code:'ENOENT'});
});

for(const incomplete of ['partial','missing-log','keep-temps','error'])test(`source configuration without completion proof cannot bypass native configuration: ${incomplete}`,async t=>{
  const f=await fixture(t);await f.generate(f.sourceProfile);
  if(incomplete==='partial'){
    // The new header and five previous outputs can coexist while a slow tool
    // check pauses. Stable bytes and matching Format39 do not prove completion.
    await writeFile(join(f.sourceProfile,'lyxrc.defaults'),'# configure.py\nFormat 39\n');
    await writeFile(join(f.sourceProfile,'configure.log'),'INFO: +Running LyX configure with Python 3.12\nINFO: checking LaTeX...\n');
  }else if(incomplete==='missing-log')await rm(join(f.sourceProfile,'configure.log'));
  else if(incomplete==='keep-temps')await writeFile(join(f.sourceProfile,'configure.log'),'INFO: +Running LyX configure with Python 3.12\nINFO: +Inspection done.\n');
  else await writeFile(join(f.sourceProfile,'configure.log'),'INFO: +Running LyX configure with Python 3.12\nERROR: configuration failed\nDEBUG: Removing file wrap_chkconfig.log\n');
  const future=new Date(Date.now()+1000);
  for(const name of nativeConfigFiles)await utimes(join(f.sourceProfile,name),future,future);
  const result=await f.prepare();assert.equal(result.cache.authoritative,false);assert.equal(result.cache.restored,false);
  for(const name of nativeConfigFiles)await assert.rejects(access(join(result.profile,name)),{code:'ENOENT'});
  assert.match(await readFile(join(f.sourceProfile,'lyxrc.defaults'),'utf8'),/Format 39/,'The source profile remains untouched');
});

test('old Format38 metadata with fresh copy timestamps cannot bypass native reconfiguration',async t=>{
  const f=await fixture(t);await f.generate(f.sourceProfile,'old',{format:38});
  const result=await f.prepare();assert.equal(result.cache.authoritative,false);assert.equal(result.cache.restored,false);
  for(const name of nativeConfigFiles)await assert.rejects(access(join(result.profile,name)),{code:'ENOENT'});
  assert.match(await readFile(join(f.sourceProfile,'lyxrc.defaults'),'utf8'),/Format 38/,'The desktop source is untouched');
});

for(const fault of ['missing','wrong-format','private-path','symlink'])test(`invalid configuration is not published: ${fault}`,async t=>{
  const f=await fixture(t),first=await f.prepare();
  await f.generate(first.profile,'bad',fault==='missing'?{omit:'packages.lst'}:fault==='wrong-format'?{format:38}:{});
  if(fault==='private-path')await writeFile(join(first.profile,'lyxmodules.lst'),`private ${first.profile}/layouts`);
  if(fault==='symlink'){await rm(join(first.profile,'packages.lst'));await symlink(join(first.profile,'textclass.lst'),join(first.profile,'packages.lst'));}
  assert.equal(await first.cache.publishAfterReady({ready:true}),false);
  assert.match(first.cache.reason,/configuration not published: reading completed configuration:/);
  assert.equal((await f.prepare()).cache.restored,false);
});

test('LyX persistent advisory-lock marker does not invalidate a completed ready configuration',async t=>{
  const f=await fixture(t),first=await f.prepare();await f.generate(first.profile);
  // fileUnlock() closes the descriptor without unlinking this zero-byte file.
  await writeFile(join(first.profile,'.lyx_configure_lock'),'');
  assert.equal(await first.cache.publishAfterReady({ready:false}),false);
  assert.equal(await first.cache.publishAfterReady({ready:true}),true);
  assert.equal(first.cache.reason,'verified configuration published');
  assert.equal((await f.prepare()).cache.restored,true);
});

for(const mutation of ['binary','configure','layout','module','preferences','source-metadata','PATH','tex-database','prefix-tool'])test(`configuration identity invalidates after ${mutation} changes`,async t=>{
  const f=await fixture(t);
  if(mutation==='prefix-tool'){
    const unrelated=join(f.root,'unrelated-bin');await mkdir(unrelated);f.options.env.PATH=unrelated;
    await writeFile(join(f.sourceProfile,'preferences'),`\\path_prefix "${f.bin}"\n`);
  }
  await f.seed();
  if(mutation==='binary')await writeFile(f.binary,'changed native engine');
  if(mutation==='configure')await writeFile(join(f.library,'configure.py'),'lyxrc_fileformat = 39\n# changed checks');
  if(mutation==='layout')await writeFile(join(f.library,'layouts','article.layout'),'changed article layout');
  if(mutation==='module'){await mkdir(join(f.sourceProfile,'layouts'));await writeFile(join(f.sourceProfile,'layouts','custom.module'),'custom module');}
  if(mutation==='preferences')await writeFile(join(f.sourceProfile,'preferences'),'\\screen_font_roman "Other"\n');
  if(mutation==='source-metadata')await writeFile(join(f.sourceProfile,'packages.lst'),'desktop reconfigure');
  if(mutation==='PATH')f.options.env.PATH=join(f.root,'new-bin');
  if(mutation==='tex-database')await writeFile(join(f.tex,'ls-R'),'changed installed package database');
  if(mutation==='prefix-tool')await writeFile(join(f.bin,'latex'),'changed prefix-only latex binary');
  assert.equal((await f.prepare()).cache.restored,false);
});

test('manual reconfigure in any cached consumer invalidates the shared generation without promotion',async t=>{
  const f=await fixture(t);await f.seed();
  const consumer=await f.prepare();assert.equal(consumer.cache.restored,true);
  await writeFile(join(consumer.profile,'configure.log'),'manual reconfigure');
  await f.generate(consumer.profile,'manual');
  assert.equal(await consumer.cache.publishAfterReady({ready:true}),false);
  assert.equal((await f.prepare()).cache.restored,false);
});

test('starting manual reconfigure invalidates reuse before generated metadata changes',async t=>{
  const f=await fixture(t),producer=await f.seed();
  const before=await Promise.all(nativeConfigFiles.map(name=>readFile(join(producer.profile,name),'utf8')));
  // configure.py opens its log with filemode='w' before updating any outputs.
  await writeFile(join(producer.profile,'configure.log'),'');
  const after=await Promise.all(nativeConfigFiles.map(name=>readFile(join(producer.profile,name),'utf8')));
  assert.deepEqual(after,before,'The invalidation must not depend on new generated output');
  assert.equal((await f.prepare()).cache.restored,false);
  assert.equal(await producer.cache.publishAfterReady({ready:true}),false,'A later ready state cannot promote reconfiguration');
});

test('private preference edits before first readiness prevent publishing a misleading generic cache',async t=>{
  const f=await fixture(t),first=await f.prepare();await f.generate(first.profile);
  await writeFile(join(first.profile,'preferences'),'different private settings');
  assert.equal(await first.cache.publishAfterReady({ready:true}),false);
  assert.match(first.cache.reason,/private preferences changed/);
  assert.equal((await f.prepare()).cache.restored,false);
});

test('copied layout or preference inputs that raced the source never enter the cache',async t=>{
  const f=await fixture(t);await mkdir(join(f.sourceProfile,'layouts'));await writeFile(join(f.sourceProfile,'layouts','a.module'),'old');
  const profile=await f.profile();await writeFile(join(f.sourceProfile,'layouts','a.module'),'new');
  const first=await f.prepare(profile);assert.match(first.cache.reason,/Copied configuration inputs/);
  const secondProfile=await f.profile();await writeFile(join(f.sourceProfile,'preferences'),'new preferences');
  const second=await f.prepare(secondProfile);assert.match(second.cache.reason,/Copied preferences/);
});

test('copied inputs modified before ready cannot publish under their original identity',async t=>{
  const f=await fixture(t),first=await f.prepare();await f.generate(first.profile);
  await writeFile(join(first.profile,'layouts','added.module'),'new private module');
  assert.equal(await first.cache.publishAfterReady({ready:true}),false);
  assert.match(first.cache.reason,/private configuration inputs changed/);
});

test('concurrent publishers expose one complete generation and retain both live participants',async t=>{
  const f=await fixture(t),a=await f.prepare(),b=await f.prepare();
  await f.generate(a.profile,'A');await f.generate(b.profile,'B');
  assert.deepEqual(await Promise.all([a.cache.publishAfterReady({ready:true}),b.cache.publishAfterReady({ready:true})]),[true,true]);
  const reader=await f.prepare();assert.equal(reader.cache.restored,true);
  const contents=await Promise.all(nativeConfigFiles.map(name=>readFile(join(reader.profile,name),'utf8')));
  assert.ok(contents.every(text=>text.includes('A'))||contents.every(text=>text.includes('B')),'A cache record cannot combine two generated sets');
  await writeFile(join(a.profile,'configure.log'),'manual change in first publisher');
  assert.equal((await f.prepare()).cache.restored,false,'Even the non-winning publisher remains tracked');
});

test('expired or missing-producer caches fall back to normal configuration',async t=>{
  const f=await fixture(t);await f.seed();f.advance(5*60*1000);
  assert.equal((await f.prepare()).cache.restored,false);
  const second=await f.seed();await rm(second.profile,{recursive:true});
  assert.equal((await f.prepare()).cache.restored,false);
});

test('unknown path prefixes and identity failures gracefully disable caching',async t=>{
  const f=await fixture(t);await writeFile(join(f.sourceProfile,'preferences'),'\\path_prefix "$HOME/bin"\n');
  const first=await f.prepare();assert.match(first.cache.reason,/Unsupported native path prefix/);
  assert.equal(await first.cache.publishAfterReady({ready:true}),false);
  await rm(f.binary);const second=await f.prepare();assert.match(second.cache.reason,/Native engine is unavailable/);
});

test('relative PATH entries bypass reuse instead of resolving against the wrong working directory',async t=>{
  const f=await fixture(t);f.options.env.PATH=f.bin+':.';
  const result=await f.prepare();assert.match(result.cache.reason,/Relative or empty PATH/);
});

test('an aliased source path is never cleared as a private profile',async t=>{
  const f=await fixture(t);await f.generate(f.sourceProfile);
  const alias=join(f.root,'alias');await symlink(f.sourceProfile,alias);
  const result=await prepareNativeConfigCache({...f.options,profile:alias});
  assert.match(result.reason,/separate/);
  assert.match(await readFile(join(f.sourceProfile,'lyxrc.defaults'),'utf8'),/Format 39/);
});
