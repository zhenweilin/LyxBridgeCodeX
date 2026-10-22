import {cp,mkdir,mkdtemp,readFile,readdir,lstat,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {lyxUpstream} from '../lib/native-engine.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
if(!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(pkg.version))throw new Error('Invalid release version');
const name=`LyxBridgeCodeX-${pkg.version}-overlay`;
const output=join(root,'release');
const temporary=await mkdtemp(join(tmpdir(),'lyxbridgecodex-package-'));
const stage=join(temporary,name);
const entries=['.agents','.github','.gitignore','LICENSE','LICENSES.md','README.md',
  'RELEASE_NOTES.md','package.json','package-lock.json','demo','docs','lib','native',
  'plugins','scripts','server','test','web'];
const forbidden=new Set(['.git','.native','node_modules','dist','release','.mcp.json','.DS_Store']);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function run(command,args){return new Promise((done,reject)=>{
  const child=spawn(command,args,{cwd:temporary,env:{...process.env,COPYFILE_DISABLE:'1'},stdio:'inherit'});
  child.once('error',reject);child.once('exit',code=>code===0?done():reject(new Error(`${command} exited ${code}`)));
});}
try{
  await mkdir(stage);
  for(const entry of entries)await cp(join(root,entry),join(stage,entry),{recursive:true,
    filter:source=>!relative(root,source).split(/[\\/]/).some(part=>forbidden.has(part)||part.startsWith('.env'))});
  const files=[];
  async function inspect(directory){
    for(const entry of (await readdir(directory)).sort()){
      const path=join(directory,entry),stat=await lstat(path);
      if(stat.isSymbolicLink())throw new Error(`Symlink is not allowed in a source release: ${relative(stage,path)}`);
      if(stat.isDirectory())await inspect(path);
      else{
        const bytes=await readFile(path);
        if(bytes.length>5*1024*1024)throw new Error(`Unexpected large source file: ${relative(stage,path)}`);
        files.push({path:relative(stage,path).replaceAll('\\','/'),bytes:bytes.length,sha256:hash(bytes)});
      }
    }
  }
  await inspect(stage);
  const versions=[JSON.parse(await readFile(join(stage,'package-lock.json'),'utf8')).version,
    JSON.parse(await readFile(join(stage,'plugins/lyx-preview/.codex-plugin/plugin.json'),'utf8')).version];
  if(versions.some(version=>version!==pkg.version))throw new Error('Release versions disagree');
  const manifest={name:pkg.name,version:pkg.version,kind:'source-overlay',
    upstream:{tag:lyxUpstream.version,commit:lyxUpstream.commit},
    testedCodex:{desktop:'26.1016.51333',build:'21161',cli:'0.163.0-alpha.11'},files};
  await writeFile(join(stage,'PACKAGE_MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n');
  await mkdir(output,{recursive:true});
  const archives=[`${name}.tar.gz`,`${name}.zip`];
  // Remove only our exact generated output names; zip otherwise retains old entries.
  for(const archive of archives)await rm(join(output,archive),{force:true});
  await run('tar',['-czf',join(output,archives[0]),'-C',temporary,name]);
  await run('zip',['-q','-r',join(output,archives[1]),name]);
  const checksums=[];
  for(const archive of archives){
    const bytes=await readFile(join(output,archive));
    checksums.push(`${hash(bytes)}  ${archive}`);
    console.log(`${archive}: ${bytes.length} bytes`);
  }
  await writeFile(join(output,'SHA256SUMS'),checksums.join('\n')+'\n');
  console.log(`Packaged ${files.length} source files; no upstream tree, dependencies, or binaries.`);
}finally{await rm(temporary,{recursive:true,force:true});}
