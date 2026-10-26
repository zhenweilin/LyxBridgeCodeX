import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {exportLyxLatex,prepareBatchUserProfile} from '../lib/batch-export.mjs';

const run=promisify(execFile);

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'lyx-batch-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const profile=join(root,'desktop profile'),input=join(root,'saved document.lyx');
  const output=join(root,'export $ with spaces.tex'),binary=join(root,'fake lyx.mjs');
  await mkdir(profile);
  await writeFile(join(profile,'preferences'),'\\ui_style "macintosh"\n\\bind_file "mac"\n');
  await writeFile(input,'success');
  await writeFile(binary,`#!/usr/bin/env node
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const args=process.argv.slice(2),profile=args[args.indexOf('-userdir')+1];
const output=args[args.indexOf('-E')+2],input=args.at(-1);
await writeFile(input+'.profile',profile);
const mode=await readFile(input,'utf8');
if(mode==='fail'){await writeFile(output,'partial');console.error('synthetic export failure');process.exit(7);}
if(mode==='empty')process.exit(0);
if(mode==='timeout'){setInterval(()=>{},1000);}
else{
  if(mode==='race')await writeFile(${JSON.stringify(output)},'another export');
  const preferences=await readFile(join(profile,'preferences'),'utf8');
  await writeFile(output,JSON.stringify({args,preferences}));
}
`,{mode:0o755});
  return {root,profile,input,output,binary};
}

test('batch profile preserves custom configuration, dereferences links, and skips live pipes',async t=>{
  const f=await fixture(t),destination=join(f.root,'private');
  const linked=join(f.root,'shared-preferences');
  const original='\\ui_style "macintosh"\n\\bind_file "mac"\n\\ui_style "Fusion"\n';
  await writeFile(linked,original);await rm(join(f.profile,'preferences'));
  await symlink(linked,join(f.profile,'preferences'));
  await mkdir(join(f.profile,'layouts'));
  await writeFile(join(f.profile,'layouts','custom.module'),'synthetic module');
  if(process.platform!=='win32')await run('mkfifo',[join(f.profile,'lyxpipe.in')]);
  await prepareBatchUserProfile({source:f.profile,destination});
  assert.equal(await readFile(linked,'utf8'),original);
  assert.equal(await readFile(join(destination,'layouts','custom.module'),'utf8'),'synthetic module');
  const preferences=await readFile(join(destination,'preferences'),'utf8');
  assert.doesNotMatch(preferences,/macintosh|Fusion/);
  assert.match(preferences,/\\bind_file "mac"/);
  assert.match(preferences,/\\ui_style "default"\s*$/);
  await assert.rejects(stat(join(destination,'lyxpipe.in')),{code:'ENOENT'});
});

test('successful export uses a private default-style profile and cleans up temporary files',async t=>{
  const f=await fixture(t),before=await readFile(join(f.profile,'preferences'));
  const result=await exportLyxLatex(f),exported=JSON.parse(await readFile(f.output,'utf8'));
  assert.equal(result.output,f.output);assert.ok(result.bytes>0);
  assert.equal(exported.args.at(-1),f.input);
  assert.match(exported.preferences,/\\ui_style "default"\s*$/);
  assert.deepEqual(await readFile(join(f.profile,'preferences')),before);
  const privateProfile=await readFile(f.input+'.profile','utf8');
  await assert.rejects(stat(privateProfile),{code:'ENOENT'});
  assert.equal((await readdir(f.root)).some(name=>name.startsWith('.lyx-export-')),false);
});

for(const [mode,pattern] of [['fail',/failed \(7\).*synthetic export failure/],['empty',/no LaTeX output/],['timeout',/timed out/]]){
  test(`${mode} export cannot publish partial or empty output and removes its profile`,async t=>{
    const f=await fixture(t);await writeFile(f.input,mode);
    await assert.rejects(exportLyxLatex({...f,timeout:mode==='timeout'?1500:120000}),pattern);
    await assert.rejects(stat(f.output),{code:'ENOENT'});
    await assert.rejects(stat(await readFile(f.input+'.profile','utf8')),{code:'ENOENT'});
    assert.equal((await readdir(f.root)).some(name=>name.startsWith('.lyx-export-')),false);
  });
}

test('existing exports and destinations created during export are preserved',async t=>{
  const f=await fixture(t);await writeFile(f.output,'previous export');
  await assert.rejects(exportLyxLatex(f),/already exists/);
  assert.equal(await readFile(f.output,'utf8'),'previous export');
  await rm(f.output);await writeFile(f.input,'race');
  await assert.rejects(exportLyxLatex(f),{code:'EEXIST'});
  assert.equal(await readFile(f.output,'utf8'),'another export');
});

test('invalid formats, missing profiles and missing binaries fail without a final export',async t=>{
  const f=await fixture(t);
  await assert.rejects(exportLyxLatex({...f,format:'html'}),/Unsupported/);
  await assert.rejects(exportLyxLatex({...f,profile:join(f.root,'missing')}),{code:'ENOENT'});
  await assert.rejects(exportLyxLatex({...f,binary:join(f.root,'missing')}),/failed \(ENOENT\)/);
  await assert.rejects(stat(f.output),{code:'ENOENT'});
  assert.equal((await readdir(f.root)).some(name=>name.startsWith('.lyx-export-')),false);
});

test('CLI accepts quoted paths and returns nonzero status on export failure',async t=>{
  const f=await fixture(t);
  const args=['scripts/export-lyx.mjs','--binary',f.binary,'--profile',f.profile,'--output',f.output,f.input];
  const {stdout}=await run(process.execPath,args);
  assert.equal(JSON.parse(stdout).output,f.output);
  await rm(f.output);await writeFile(f.input,'fail');
  await assert.rejects(run(process.execPath,args),error=>error.code===1&&/synthetic export failure/.test(error.stderr));
});
