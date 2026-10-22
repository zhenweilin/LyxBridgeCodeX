import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile, readFile, mkdtemp, mkdir, unlink} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {NativeSession} from '../lib/native-session.mjs';

const formulaPattern = /\\begin_inset Formula \$x\^\{2\}\$/g;
const formulas = source => [...source.matchAll(formulaPattern)].length;
const base64 = text => Buffer.from(text).toString('base64');

test('native clipboard preserves formula MIME across engines, paragraphs, cut and undo', {timeout:120000}, async () => {
  const original = await readFile('demo/demo.lyx');
  await mkdir('.native', {recursive:true});
  const directory = await mkdtemp(resolve('.native/clipboard-integration-'));
  const path = join(directory, 'source.lyx');
  const target = join(directory, 'target.lyx');
  await copyFile('demo/demo.lyx', path);
  await copyFile('demo/demo.lyx', target);
  let session = new NativeSession();
  const command = async value => {
    const result = await session.call('command', {command:value});
    assert.ok(!result.error, `${value}: ${result.message}`);
    return result;
  };
  const key = async (key, text = '', modifiers = {}) => {
    await session.call('input', {type:'keydown',key,text,...modifiers});
    await session.call('input', {type:'keyup',key,text,...modifiers});
  };
  const paragraph = async () => {
    await command('buffer-end');
    await key(0x1000004);
    await command('layout Standard');
  };
  try {
    await session.start(path);
    await session.call('frame', {width:1000,height:800});
    await paragraph();
    await session.call('input', {type:'commit',text:'Clipboard formula '});
    await key(77,'m',{meta:true});
    await key(88,'x');
    await key(94,'^',{shift:true});
    await key(50,'2');
    await command('buffer-end');
    await command('line-begin-select');
    const copied = await session.call('clipboard', {action:'copy'});
    assert.ok(!copied.error, copied.message);
    assert.match(copied.clipboard.text, /Clipboard formula.*x\^\{2\}/);
    assert.equal(copied.clipboard.origin.selection, copied.clipboard.text);
    assert.match(Buffer.from(copied.clipboard.formats['application/x-lyx'],'base64').toString(), formulaPattern);
    assert.ok(copied.clipboard.formats['text/plain']);
    const originalSelection = copied.clipboard.origin.clipboardSelection;
    const originalSource = (await session.call('selection')).source;
    for (const action of ['copy','cut']) {
      const stale = await session.call('clipboard',{action,expectedSelection:{...originalSelection,text:'Stale text'}});
      assert.equal(stale.error,true);
      const wrongPath = await session.call('clipboard',{action,expectedPath:target,expectedSelection:originalSelection});
      assert.equal(wrongPath.error,true);
      assert.equal((await session.call('selection')).source,originalSource,'Rejected copy/cut must not change native content');
      assert.deepEqual((await session.call('clipboard',{action:'read'})).clipboard.formats,copied.clipboard.formats,'Rejected copy/cut must not replace the private clipboard');
    }
    // Cutting is performed by LyX itself, and belongs to its native undo stack.
    const cut = await session.call('clipboard', {action:'cut',expectedPath:path,expectedSelection:originalSelection});
    assert.ok(!cut.error, cut.message);
    assert.equal(formulas((await session.call('selection')).source),0);
    await command('undo');
    assert.equal(formulas((await session.call('selection')).source),1);
    session.stop();

    // A second process has no cut-stack entry for this selection. This proves
    // paste reads LyX MIME rather than accidentally reusing the first cut stack.
    session = new NativeSession();
    await session.start(target);
    await session.call('frame', {width:1000,height:800});
    await paragraph();
    const pasted = await session.call('clipboard', {action:'paste',formats:copied.clipboard.formats});
    assert.ok(!pasted.error, pasted.message);
    let snapshot = await session.call('selection');
    assert.equal(formulas(snapshot.source),1);
    assert.match(snapshot.source,/Clipboard formula/);
    await command('undo');
    snapshot = await session.call('selection');
    assert.equal(formulas(snapshot.source),0);
    assert.doesNotMatch(snapshot.source,/Clipboard formula/);

    await session.call('clipboard', {action:'paste',formats:{'text/plain':base64('First paste paragraph\n\nSecond paste paragraph')}});
    snapshot = await session.call('selection');
    assert.match(snapshot.source,/\\begin_layout Standard\nFirst paste paragraph\n\\end_layout\s+\\begin_layout Standard\nSecond paste paragraph\n\\end_layout/);
    await command('undo');
    assert.doesNotMatch((await session.call('selection')).source,/First paste paragraph|Second paste paragraph/);

    // Force both RPC lines into one socket batch. Deferred native paste must
    // install its own captured MIME immediately before dispatch, not reuse B.
    session.socket.cork();
    const batch = ['Batch-A ','Batch-B '].map(text=>session.call('clipboard',{
      action:'paste',formats:{'text/plain':base64(text)},
    }));
    session.socket.uncork();
    await Promise.all(batch);
    assert.match((await session.call('selection')).source,/Batch-A Batch-B /);
    await command('undo');
    assert.match((await session.call('selection')).source,/Batch-A /);
    assert.doesNotMatch((await session.call('selection')).source,/Batch-B/);
    await command('undo');
    assert.doesNotMatch((await session.call('selection')).source,/Batch-[AB]/);

    // Reject unsupported or invalid transport data before changing Qt clipboard.
    const before = (await session.call('clipboard',{action:'read'})).clipboard.formats;
    assert.equal((await session.call('clipboard',{action:'paste',formats:{'text/uri-list':base64('file:///tmp/unrelated')}})).error,true);
    assert.equal((await session.call('clipboard',{action:'paste',formats:{'text/plain':'broken base64'}})).error,true);
    assert.deepEqual((await session.call('clipboard',{action:'read'})).clipboard.formats,before);
    assert.deepEqual(await readFile('demo/demo.lyx'),original);
    assert.deepEqual(await readFile(path),original);
    assert.deepEqual(await readFile(target),original);
    const beforeDeletion = (await session.call('selection')).source;
    await unlink(target);
    assert.equal((await session.call('state')).ready,true,'Deleting the backing file must not assert or block the engine');
    assert.equal((await session.call('selection')).source,beforeDeletion,'Deleting disk content must preserve the live native buffer');
    console.log(`Native clipboard evidence: ${directory}`);
  } finally {session.stop();}
});

test('native search-field clipboard is separate from the document selection', {timeout:60000}, async () => {
  const original = await readFile('demo/demo.lyx');
  const directory = await mkdtemp(resolve('.native/clipboard-widget-integration-'));
  const path = join(directory,'demo.lyx');
  await copyFile('demo/demo.lyx',path);
  const session = new NativeSession();
  const key = async (key,text='',modifiers={}) => {
    await session.call('input',{type:'keydown',key,text,...modifiers});
    await session.call('input',{type:'keyup',key,text,...modifiers});
  };
  try {
    await session.start(path);
    await session.call('frame',{width:1000,height:800});
    await session.call('command',{command:'buffer-begin'});
    await session.call('command',{command:'word-forward-select'});
    const document = await session.call('selection');
    assert.equal(document.clipboardSelection.kind,'document');
    assert.equal(document.clipboardSelection.hasSelection,true);
    await session.call('dispatch',{command:'dialog-show findreplace'});
    await key(65,'a',{meta:true});
    await session.call('input',{type:'commit',text:'Dialog clipboard 中文'});
    await key(65,'a',{meta:true});
    const selected = await session.call('state');
    assert.equal(selected.clipboardSelection.kind,'widget');
    assert.equal(selected.clipboardSelection.hasSelection,true);
    assert.equal(selected.clipboardSelection.text,'Dialog clipboard 中文');
    assert.notEqual(selected.clipboardSelection.text,selected.selection);
    const copied = await session.call('clipboard',{action:'copy'});
    assert.equal(copied.clipboard.text,'Dialog clipboard 中文');
    assert.equal(copied.clipboard.origin.clipboardSelection.kind,'widget');
    await session.call('clipboard',{action:'cut'});
    assert.equal((await session.call('state')).clipboardSelection.hasSelection,false);
    await session.call('clipboard',{action:'paste',formats:copied.clipboard.formats});
    await key(65,'a',{meta:true});
    assert.equal((await session.call('state')).clipboardSelection.text,'Dialog clipboard 中文');
    assert.equal((await session.call('selection')).source,document.source,'Dialog editing must not alter the native document');
    await key(0x1000000);
    assert.equal((await session.call('state')).clipboardSelection.kind,'document');
    assert.deepEqual(await readFile(path),original);
    assert.deepEqual(await readFile('demo/demo.lyx'),original);
    console.log(`Native widget clipboard evidence: ${directory}`);
  } finally {session.stop();}
});
