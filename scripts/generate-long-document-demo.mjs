import {mkdir,writeFile} from 'node:fs/promises';
const directory=new URL('../demo/long-document/',import.meta.url);await mkdir(directory,{recursive:true});
const layout=(name,text)=>`\\begin_layout ${name}\n${text}\n\\end_layout\n`;
const math=text=>layout('Standard',`\\begin_inset Formula \\[\n${text}\n\\]\n\\end_inset`);
const topics=['Gradient updates','Step sizes','Residuals','Feasible points','Projections','Quadratic models','Coordinate updates','Stopping rules','Line searches','Local models','Norms and distances','Averaging','Perturbations','Conditioning','Constraints','Sparse vectors','Dual variables','Error bounds','Descent estimates','Initialization','Restart rules','Parameter choices','Model comparisons','Consistency checks','Final verification'];
const blocks=[
'Each section is a self-contained synthetic example for testing the editor. Read the paragraph, move the pointer across several lines, and select a phrase in either direction. Every sentence was written for this demonstration; no personal manuscript, unpublished result, or private file is included.',
'The model uses a vector of real variables and a smooth quadratic objective. The displayed expressions are native editable formula insets. Clicking inside a formula should place the mathematical cursor at the requested symbol. Scrolling past the equation should preserve its spacing, subscripts, and surrounding text.',
'To test sustained scrolling, move through several sections without pausing, then reverse direction. Observe whether the content continues moving after the wheel has stopped. A delayed response can indicate queued input, while an increasingly irregular display may indicate work in frame capture, transport, or presentation.',
'To test a growing selection, begin near the top of the document and drag toward the lower edge of the viewport. Keep the button held as the editor scrolls into later sections. The highlighted range should follow the pointer, and releasing the button should end the gesture promptly.',
'Open the Review panel and repeat the same gesture. Reading annotations should not interrupt the active selection. After releasing the pointer, the review list and prepared clipboard may catch up. An explicit request to create a comment must still capture the complete selected passage at that moment.',
'This document intentionally mixes prose, headings, short lists, and mathematics. Its PDF uses explicit page breaks to provide exactly twenty-five numbered pages. The continuous LyX editing view does not display PDF page boundaries, so compare the numbered section headings when repeating an interaction or reporting a delayed response.'
];
let body='';
for(let page=1;page<=25;page++){
 if(page>1)body+=layout('Standard','\\begin_inset Newpage newpage\n\\end_inset');
 body+=layout('Section',`Interaction sample ${page}: ${topics[page-1]}`);
 for(let j=0;j<blocks.length;j++){
  body+=layout('Standard',blocks[j]);
  if(j===1)body+=math(`f_{${page}}(x)=\\frac{1}{2}\\sum_{i=1}^{n}(x_i-b_i)^2,\\qquad \\nabla f_{${page}}(x)=x-b.`);
  if(j===3)body+=math(`x_{k+1}=x_k-\\alpha_k\\nabla f_{${page}}(x_k),\\qquad r_k=\\left\\|x_{k+1}-x_k\\right\\|_2.`);
 }
 body+=layout('Enumerate',`Checkpoint ${page}. Select one sentence, then reverse the selection direction.`);
 body+=layout('Enumerate','Release the pointer, pause, and verify that scrolling and highlighting stop.');
}
const header=String.raw`#LyX 2.4 created this file. For more info see https://www.lyx.org/
\lyxformat 620
\begin_document
\begin_header
\textclass article
\begin_preamble
\usepackage[a4paper,margin=22mm]{geometry}
\usepackage{lmodern}
\end_preamble
\language english
\inputencoding utf8
\fontencoding T1
\paperfontsize 10
\use_package amsmath 1
\use_package amssymb 1
\secnumdepth -1
\tracking_changes false
\output_changes false
\end_header
\begin_body
`;
await writeFile(new URL('interaction-demo-25-pages.lyx',directory),header+body+'\\end_body\n\\end_document\n');
