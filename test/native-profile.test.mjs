import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,readFile,symlink,lstat,stat,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeUserProfile,prepareNativeUserProfile} from '../lib/native-profile.mjs';

test('native profile prefers LyX 2.5, imports 2.4 settings when needed, and honors explicit profiles',async()=>{
  const home=await mkdtemp(join(tmpdir(),'lyx-profile-selection-'));
  const old=join(home,'Library/Application Support/LyX-2.4');
  const current=join(home,'Library/Application Support/LyX-2.5');
  try{
    assert.equal(await nativeUserProfile({home,override:''}),current);
    await mkdir(old,{recursive:true});
    assert.equal(await nativeUserProfile({home,override:''}),old);
    await mkdir(current);
    assert.equal(await nativeUserProfile({home,override:''}),current);
    assert.equal(await nativeUserProfile({home,override:old}),old);
  }finally{await rm(home,{recursive:true,force:true});}
});

test('private profile settings do not write through desktop preference symlinks or refresh generated metadata',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lyx-private-profile-'));
  const source=join(directory,'desktop'),destination=join(directory,'private');
  const settings=join(directory,'shared-preferences'),defaults=join(source,'lyxrc.defaults');
  const original='\\bind_file "mac"\n\\autosave 0\n';
  try{
    await mkdir(source);await writeFile(settings,original);
    await symlink(settings,join(source,'preferences'));
    await writeFile(defaults,'Format 38\n');
    const old=new Date('2020-01-01T00:00:00Z');await utimes(defaults,old,old);
    await prepareNativeUserProfile({source,destination});
    assert.equal(await readFile(settings,'utf8'),original,'Desktop settings are unchanged');
    assert.equal((await lstat(join(source,'preferences'))).isSymbolicLink(),true);
    assert.equal((await lstat(join(destination,'preferences'))).isSymbolicLink(),false);
    const copied=await readFile(join(destination,'preferences'),'utf8');
    assert.ok(copied.startsWith(original),'Existing key bindings are retained');
    assert.match(copied,/\\autosave 60\s*$/);
    assert.equal((await stat(join(destination,'lyxrc.defaults'))).mtimeMs,(await stat(defaults)).mtimeMs,
      'Old generated metadata must not appear newer than configure.py after copying');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('a missing desktop profile still creates isolated native preferences',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lyx-missing-profile-'));
  try{
    const destination=join(directory,'private');
    await prepareNativeUserProfile({source:join(directory,'missing'),destination});
    assert.match(await readFile(join(destination,'preferences'),'utf8'),/\\load_session false/);
    await assert.rejects(stat(join(directory,'missing')),{code:'ENOENT'});
  }finally{await rm(directory,{recursive:true,force:true});}
});
