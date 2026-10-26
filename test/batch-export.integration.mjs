import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exportLyxLatex,prepareBatchUserProfile} from '../lib/batch-export.mjs';

const binary=process.env.LYX_BATCH_BINARY,source=process.env.LYX_BATCH_PROFILE;

test('installed LyX exports a synthetic document with Macintosh and Fusion source preferences',
  {skip:!binary||!source,timeout:300000},async t=>{
    const directory=await mkdtemp(join(tmpdir(),'lyx-batch-integration-'));
    t.after(()=>rm(directory,{recursive:true,force:true}));
    const profile=join(directory,'source profile'),input=join(directory,'sample.lyx');
    // The real desktop profile is only read; forced styles live in a test copy.
    await prepareBatchUserProfile({source,destination:profile});
    await copyFile(new URL('./fixtures/demo.lyx',import.meta.url),input);
    const preferences=join(profile,'preferences'),base=await readFile(preferences,'utf8');
    for(const style of ['macintosh','Fusion']){
      const forced=`${base}\n\\ui_style "${style}"\n`;
      await writeFile(preferences,forced);
      const output=join(directory,`${style}.tex`);
      const result=await exportLyxLatex({binary,profile,input,output});
      assert.ok(result.bytes>0);
      assert.match(await readFile(output,'utf8'),/\\begin\{document\}/);
      assert.equal(await readFile(preferences,'utf8'),forced);
    }
  });
