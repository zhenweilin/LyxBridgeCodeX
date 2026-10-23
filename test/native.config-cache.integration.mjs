import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {NativeSession} from '../lib/native-session.mjs';
import {nativeConfigFiles} from '../lib/native-config-cache.mjs';

test('fresh native documents reuse verified TeX configuration without sharing preferences or document data',{timeout:60000},async()=>{
  const directory=await mkdtemp(resolve('.native/config-cache-integration-'));
  const profile=join(directory,'empty-desktop-profile');await mkdir(profile);
  const original=await readFile('test/fixtures/demo.lyx','utf8');
  const previous=process.env.LYX_USER_PROFILE;process.env.LYX_USER_PROFILE=profile;
  const sessions=[],records=[];
  try{
    for(const name of ['cold','warm']){
      const path=join(directory,`${name}.lyx`);await writeFile(path,original);
      const session=new NativeSession();sessions.push(session);
      const started=performance.now();await session.start(path);
      const elapsedMs=Math.round(performance.now()-started);
      await session.waitForConfigurationCache();
      const snapshot=await session.call('selection');
      assert.equal(snapshot.ready,true);assert.equal(snapshot.modified,false);
      assert.equal(await readFile(path,'utf8'),original);
      const privateProfile=join(session.directory,'profile');
      const files=Object.fromEntries(await Promise.all(nativeConfigFiles.map(async file=>[file,await readFile(join(privateProfile,file),'utf8')])));
      const configured=(await readdir(privateProfile)).includes('configure.log');
      records.push({name,elapsedMs,configured,privateProfile,status:session.configurationStatus,source:snapshot.source,files});
      console.log(`${name} configuration: ${JSON.stringify(session.configurationStatus)}`);
    }
    assert.equal(records[0].configured,true,'The first empty-profile engine runs native configuration');
    assert.equal(records[1].configured,false,'The second engine starts without repeating configure.py');
    assert.deepEqual(records[1].files,records[0].files,'Reuse transfers one complete configuration generation');
    assert.equal(records[1].source,records[0].source,'The native document model is unchanged');
    assert.deepEqual(await readdir(profile),[],'The source desktop profile remains untouched');
    assert.notEqual(records[0].privateProfile,records[1].privateProfile);
    const firstPreferences=join(records[0].privateProfile,'preferences');
    const secondPreferences=join(records[1].privateProfile,'preferences');
    const secondBefore=await readFile(secondPreferences,'utf8');
    await writeFile(firstPreferences,(await readFile(firstPreferences,'utf8'))+'\n# Independent private profile\n');
    assert.equal(await readFile(secondPreferences,'utf8'),secondBefore,'Preferences are independent files');
    await writeFile(join(directory,'timings.json'),JSON.stringify(records.map(({name,elapsedMs,configured,privateProfile})=>({name,elapsedMs,configured,privateProfile})),null,2)+'\n');
    console.log(`Native configuration reuse evidence: ${directory}`);
    console.log(`Cold ${records[0].elapsedMs} ms; warm ${records[1].elapsedMs} ms`);
  }finally{
    for(const session of sessions)session.stop();
    if(previous===undefined)delete process.env.LYX_USER_PROFILE;else process.env.LYX_USER_PROFILE=previous;
  }
});
