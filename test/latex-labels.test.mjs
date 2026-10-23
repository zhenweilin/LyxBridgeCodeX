import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

test('literal source-label parser ignores examples, comments, definitions and dynamic names',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lyx-label-parser-'));
  try{
    const binary=join(directory,'labels');
    execFileSync(process.env.CXX||'c++',['-std=c++17','-Wall','-Wextra','-Werror','-I',resolve('native'),
      'test/native-latex-labels.cpp','-o',binary],{stdio:'pipe'});
    execFileSync(binary,[],{stdio:'pipe'});
  }finally{await rm(directory,{recursive:true,force:true});}
});
