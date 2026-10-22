import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {renderFile,renderLyx,parseLyx,digest} from '../lib/lyx.mjs';
import {selectionContext,contextText} from '../lib/selection.mjs';
const demo=resolve('test/fixtures/demo.lyx');

test('public demo fixture: ERT math uses a macro and preserves source mapping',async()=>{
 const before=await readFile(demo);const doc=await renderFile(demo);
 assert.equal(doc.blocks.length,5);assert.ok(doc.macroCount>0);assert.deepEqual(doc.warnings,[]);
 assert.match(doc.html,/mathvariant="bold">D/);assert.match(doc.html,/Example Matrix/);
 const block=doc.blocks.find(b=>b.layout==='Definition');
 assert.equal(block.startLine,before.toString().split(/\r?\n/).indexOf('\\begin_layout Definition')+1);
 assert.equal(block.source,before.toString().split(/\r?\n/).slice(block.startLine-1,block.endLine).join('\n'));
 assert.deepEqual(await readFile(demo),before);
});
test('selection contains the original LyX, location and exact source revision',async()=>{
 const doc=await renderFile(demo);const block=doc.blocks.find(b=>b.layout==='Definition');
 const context=selectionContext(doc,[block],'$\\Dbf$ Example Matrix');
 assert.equal(context.file,demo);assert.equal(context.revision,digest(await readFile(demo)));
 assert.match(contextText(context),/\\begin_inset ERT/);assert.ok(contextText(context).includes(`${block.startLine}–${block.endLine}`));
});
test('re-rendering a changed copy updates preview and revision, original stays intact',async()=>{
 const source=await readFile(demo,'utf8');const dir=await mkdtemp(join(tmpdir(),'lyx-preview-test-'));
 try {const file=join(dir,'changed.lyx');await writeFile(file,source);const before=await renderFile(file);
 const changed=source.replace(/(\\begin_layout Section\r?\n)[^\r\n]+/,'$1Updated Section Fixture');
 assert.notEqual(changed,source,'The demo has a section heading to update in the disposable copy');
 await writeFile(file,changed);const after=await renderFile(file);
 assert.notEqual(before.revision,after.revision);assert.match(after.html,/Updated Section Fixture/);
 assert.equal(await readFile(demo,'utf8'),source);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('document text is escaped, and malformed LyX is rejected',async()=>{
 const source='#LyX\n\\begin_document\n\\begin_body\n\\begin_layout Standard\n<script>alert(1)</script>\n\\end_layout\n\\end_body\n\\end_document';
 const doc=await renderLyx(source);assert.match(doc.html,/&lt;script&gt;/);assert.doesNotMatch(doc.html,/<script>/);
 assert.throws(()=>parseLyx(source.replace('\\end_layout','')),/not properly closed/);
});
