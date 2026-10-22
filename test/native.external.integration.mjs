import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile, readFile, writeFile, mkdtemp, mkdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {NativeSession} from '../lib/native-session.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const appendParagraph = (source, text) => {
  assert.equal(source.split('\\end_body').length, 2, 'The fixture has one document body');
  return source.replace('\\end_body', `\\begin_layout Standard\n${text}\n\\end_layout\n\n\\end_body`);
};

test('real LyX: external disk edits retain local content and require explicit native reload/overwrite decisions', {timeout:120000}, async () => {
  const originalPath = resolve(root, 'demo/demo.lyx');
  const original = await readFile(originalPath);
  await mkdir(resolve(root, '.native'), {recursive:true});
  const directory = await mkdtemp(resolve(root, '.native/external-integration-'));
  const path = join(directory, 'demo.lyx');
  await copyFile(originalPath, path);
  const session = new NativeSession();
  const frame = () => session.call('frame', {width:1000, height:800, serial:-1});
  const snapshot = () => session.call('selection');
  const command = async value => {
    const result = await session.call('command', {command:value});
    assert.ok(!result.error, `${value}: ${result.message}`);
    return result;
  };
  const key = async key => {
    await session.call('input', {type:'keydown', key});
    await session.call('input', {type:'keyup', key});
  };
  const eventually = async (read, predicate, message) => {
    let latest;
    for (let attempt=0; attempt<100; attempt++) {
      latest = await read();
      if (predicate(latest)) return latest;
      await delay(50);
    }
    const visible = latest?.frame ?? latest;
    const remainingDialog = visible?.surfaces?.find(surface => !surface.main);
    if (remainingDialog)
      await writeFile(join(directory, 'failure-dialog.png'), Buffer.from(remainingDialog.png, 'base64'));
    if (visible?.surfaces)
      await writeFile(join(directory, 'failure-surfaces.json'), JSON.stringify(visible.surfaces.map(({png,...surface}) => surface), null, 2));
    assert.fail(`${message}; evidence: ${directory}`);
  };
  const expectDialog = async (nativeCommand, filename) => {
    assert.equal((await frame()).surfaces.length, 1, 'No earlier native dialog is open');
    await session.call('dispatch', {command:nativeCommand});
    const dialogFrame = await eventually(frame, value => value.surfaces.length > 1,
      `${nativeCommand} must present a native decision dialog`);
    const dialog = dialogFrame.surfaces.find(surface => !surface.main);
    await writeFile(join(directory, filename), Buffer.from(dialog.png, 'base64'));
    await writeFile(join(directory, filename.replace(/\.png$/, '.json')), JSON.stringify({...dialog,png:undefined}, null, 2));
    return dialog;
  };
  const cancelDialog = async () => {
    // GuiAlert::doPrompt explicitly assigns the native Cancel button to Escape.
    await key(0x1000000);
    await eventually(frame, value => value.surfaces.length === 1,
      'Escape must cancel the native dialog without blocking the bridge');
  };
  try {
    await session.start(path);
    await frame();
    const initial = await snapshot();
    assert.equal(initial.modified, false);
    assert.equal(initial.externalModified, false,
      'Build the native bridge with externalModified state before running this test');
    assert.equal(initial.diskRevision, hash(original));

    // The native file watcher deliberately marks even a previously clean buffer
    // dirty. That flag must not be mistaken for evidence of local text changes.
    const firstDiskText = 'External edit while native buffer was clean';
    const firstDisk = appendParagraph(original.toString('utf8'), firstDiskText);
    await writeFile(path, firstDisk);
    const externalOnly = await eventually(snapshot,
      value => value.externalModified && value.diskRevision === hash(firstDisk),
      'LyX must report the external disk change');
    assert.equal(externalOnly.source, initial.source, 'Disk edits do not silently replace the native buffer');
    assert.equal(await readFile(path, 'utf8'), firstDisk);

    // GuiView enables buffer-reload after LyX's asynchronous watcher marks the
    // buffer dirty. The checksum fallback can report externalModified earlier.
    const notified = await eventually(snapshot, value => value.modified && value.externalModified,
      'The native watcher must make explicit Reload available for the external edit');
    assert.equal(notified.source, initial.source);

    // Run the native command while keeping its result visible. A dispatch ACK
    // alone can conceal a disabled LFUN; the live dialog can still receive its
    // Escape event through the same socket while this request is outstanding.
    let reloadResult;
    const reloadRequest = session.call('command', {command:'buffer-reload'})
      .then(value => {reloadResult=value;}, error => {reloadResult={error:true,message:error.message};});
    const cleanReload = await eventually(async () => ({frame:await frame(), snapshot:await snapshot()}),
      value => value.frame.surfaces.length > 1 || reloadResult !== undefined,
      'The explicit native reload must either adopt the file or ask for confirmation');
    assert.ok(!reloadResult?.error, `Native reload rejected the externally changed file: ${reloadResult?.message}`);
    if (cleanReload.frame.surfaces.length > 1) {
      const dialog = cleanReload.frame.surfaces.find(surface => !surface.main);
      await writeFile(join(directory, 'reload-external-dialog.png'), Buffer.from(dialog.png, 'base64'));
      await cancelDialog();
      await reloadRequest;
      assert.equal((await snapshot()).source, initial.source, 'Cancelling reload retains the native content');
      assert.equal(await readFile(path, 'utf8'), firstDisk);

      // This unconditional LFUN is used only on this disposable fixture after
      // proving there have been no local content edits. It is not a production
      // synchronization strategy: Buffer::reload clears native undo history.
      await command('buffer-reload dump');
    }
    await reloadRequest;
    const reloaded = await eventually(snapshot,
      value => value.source.includes(firstDiskText) && !value.modified && !value.externalModified,
      'An explicit native reload must adopt the updated file');
    assert.equal(reloaded.diskRevision, hash(firstDisk));
    assert.equal(await readFile(path, 'utf8'), firstDisk, 'Reload does not rewrite the disk file');

    const localText = 'Unsaved native typing must survive the external edit';
    await command('buffer-end');
    await key(0x1000004);
    await command('layout Standard');
    await session.call('input', {type:'commit', text:localText});
    const local = await eventually(snapshot, value => value.source.includes(localText),
      'The fixture must have a real unsaved native edit');
    assert.equal(local.modified, true);
    assert.equal(local.externalModified, false);
    assert.equal(await readFile(path, 'utf8'), firstDisk, 'Typing has not saved the fixture');

    const secondDiskText = 'Concurrent disk edit must survive cancelled native save';
    const secondDisk = appendParagraph(firstDisk, secondDiskText);
    await writeFile(path, secondDisk);
    const conflicted = await eventually(snapshot,
      value => value.externalModified && value.diskRevision === hash(secondDisk),
      'LyX must detect the external change while local edits are unsaved');
    assert.equal(conflicted.source, local.source, 'The unsaved native edit is not replaced');
    assert.ok(!conflicted.source.includes(secondDiskText));

    // Buffer::save checks its original checksum and shows Overwrite/Cancel.
    // Both versions must remain intact while the modal dialog is open and after
    // Cancel; a successful RPC dispatch alone is not evidence of safe saving.
    const overwriteDialog = await expectDialog('buffer-write', 'save-conflict-dialog.png');
    assert.ok(overwriteDialog.message?.length > 0, 'The native overwrite prompt exposes its actual message text');
    assert.equal(await readFile(path, 'utf8'), secondDisk, 'Save has not silently overwritten the external edit');
    assert.equal((await snapshot()).source, local.source);
    await key(0x1000000);
    // Native GuiView::saveBuffer follows a cancelled overwrite with its own
    // Rename/Retry/Cancel prompt. Verify that second decision instead of treating
    // a remaining dialog as evidence that the first Escape failed.
    const retryFrame = await eventually(frame,
      value => value.surfaces.some(surface => !surface.main && surface.message && surface.message !== overwriteDialog.message),
      'Cancelling overwrite must reach the native Rename/Retry/Cancel prompt');
    const retryDialog = retryFrame.surfaces.find(surface => !surface.main);
    await writeFile(join(directory, 'save-cancel-followup.png'), Buffer.from(retryDialog.png, 'base64'));
    await writeFile(join(directory, 'save-cancel-followup.json'), JSON.stringify({...retryDialog,png:undefined}, null, 2));
    assert.notEqual(retryDialog.message, overwriteDialog.message,
      'The actual native prompt body changed; pointer reuse, blank sheet titles and focus repaint cannot satisfy this check');
    assert.equal(await readFile(path, 'utf8'), secondDisk);
    assert.equal((await snapshot()).source, local.source);
    await cancelDialog();
    const cancelledSave = await snapshot();
    assert.equal(cancelledSave.source, local.source);
    assert.equal(cancelledSave.modified, true);
    assert.equal(cancelledSave.externalModified, true);
    assert.equal(await readFile(path, 'utf8'), secondDisk);

    await expectDialog('buffer-reload', 'reload-dirty-dialog.png');
    await cancelDialog();
    assert.equal((await snapshot()).source, local.source, 'Cancelling reload preserves the unsaved native edit');
    assert.equal(await readFile(path, 'utf8'), secondDisk);
    assert.deepEqual(await readFile(originalPath), original, 'The supplied demo remains untouched');
    console.log(`External-edit evidence: ${directory}`);
  } finally {
    // This process belongs exclusively to the temporary fixture created above.
    session.stop();
  }
});
