import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeUserProfile} from '../lib/native-profile.mjs';

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
