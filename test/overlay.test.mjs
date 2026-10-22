import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {execFileSync,spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

test('the overlay refuses an unsupported upstream commit before writing any files',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lyx-overlay-unsupported-'));
  try{
    execFileSync('git',['init','-q',directory]);
    await writeFile(join(directory,'original.txt'),'Keep this upstream file unchanged.\n');
    execFileSync('git',['-C',directory,'add','original.txt']);
    execFileSync('git',['-C',directory,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid',
      '-c','commit.gpgsign=false','commit','-qm','Unsupported fixture revision']);
    const result=spawnSync(process.execPath,[resolve('scripts/patch-native.mjs'),directory],{encoding:'utf8'});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/Only the pinned LyX 2\.4\.1 commit is supported/);
    assert.equal(await readFile(join(directory,'original.txt'),'utf8'),'Keep this upstream file unchanged.\n');
    assert.deepEqual((await readdir(directory)).sort(),['.git','original.txt']);
    assert.equal(execFileSync('git',['-C',directory,'status','--porcelain'],{encoding:'utf8'}),'');
  }finally{await rm(directory,{recursive:true,force:true});}
});
