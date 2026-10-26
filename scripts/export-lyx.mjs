#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {exportLyxLatex} from '../lib/batch-export.mjs';

const usage=`Export a saved LyX document to LaTeX using a temporary, safe profile.

Usage: node scripts/export-lyx.mjs --binary PATH --profile DIR --output FILE.tex [--format pdflatex] INPUT.lyx

  --binary   LyX executable compatible with the document and profile
  --profile  Existing LyX user directory (copied, never changed)
  --output   New .tex file; existing files are never overwritten
  --format   latex, pdflatex (default), xetex, luatex, or dviluatex
  --help     Show this help

Reads the saved file on disk, not unsaved editor content. Timeout: 120 seconds.
`;

try{
  const {values,positionals}=parseArgs({allowPositionals:true,options:{
    binary:{type:'string'},profile:{type:'string'},output:{type:'string'},
    format:{type:'string',default:'pdflatex'},help:{type:'boolean',short:'h'},
  }});
  if(values.help)process.stdout.write(usage);
  else{
    if(positionals.length!==1)throw new Error(usage);
    const result=await exportLyxLatex({...values,input:positionals[0]});
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}catch(error){
  process.stderr.write(`${error.message}\n`);process.exitCode=1;
}
