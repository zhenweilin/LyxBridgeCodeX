import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {NativeSession} from '../lib/native-session.mjs';

test('native LyX writes a one-minute recovery snapshot without overwriting the document',{timeout:80000},async()=>{
  await mkdir('.native',{recursive:true});
  const directory=await mkdtemp(resolve('.native/autosave-integration-'));
  const path=join(directory,'snapshot.lyx'),snapshotPath=join(directory,'#snapshot.lyx#');
  const original=await readFile('test/fixtures/demo.lyx','utf8');
  await writeFile(path,original);
  const profile=join(directory,'profile');await mkdir(profile);
  await writeFile(join(profile,'preferences'),'\\autosave 0\n');
  const previousProfile=process.env.LYX_USER_PROFILE;
  process.env.LYX_USER_PROFILE=profile;
  const session=new NativeSession();
  const started=performance.now();
  try{
    await session.start(path);
    const preferences=await readFile(join(session.directory,'profile/preferences'),'utf8');
    assert.match(preferences,/\\autosave 60\s*$/,'The plugin overrides a disabled inherited autosave preference');
    assert.equal(await readFile(join(profile,'preferences'),'utf8'),'\\autosave 0\n','The desktop LyX profile stays unchanged');
    await session.call('command',{command:'buffer-end'});
    const marker='Native one-minute recovery snapshot';
    await session.call('input',{type:'commit',text:marker});
    const edited=await session.call('selection');
    assert.equal(edited.modified,true);
    assert.ok(edited.source.includes(marker));
    await assert.rejects(readFile(snapshotPath),{code:'ENOENT'});
    let snapshot;
    while(performance.now()-started<75000){
      snapshot=await readFile(snapshotPath,'utf8').catch(error=>{
        if(error.code==='ENOENT')return undefined;throw error;
      });
      if(snapshot?.includes(marker))break;
      await new Promise(done=>setTimeout(done,250));
    }
    const elapsed=performance.now()-started;
    assert.ok(snapshot?.includes(marker),'The actual native timer must write the edited recovery snapshot');
    assert.ok(elapsed>=55000 && elapsed<75000,`Expected the one-minute native timer, observed ${elapsed}ms`);
    assert.equal(await readFile(path,'utf8'),original,'Recovery snapshots do not overwrite the formal document');
    const after=await session.call('selection');
    assert.equal(after.source,edited.source);
    assert.equal(after.modified,true,'Native snapshotting does not mark the document manually saved');
    await writeFile(join(directory,'evidence.json'),JSON.stringify({elapsedMs:Math.round(elapsed),snapshotPath,originalUnchanged:true,modified:after.modified},null,2)+'\n');
    console.log(`Native autosave evidence: ${directory}`);
  }finally{
    session.stop();
    if(previousProfile===undefined)delete process.env.LYX_USER_PROFILE;
    else process.env.LYX_USER_PROFILE=previousProfile;
  }
});
