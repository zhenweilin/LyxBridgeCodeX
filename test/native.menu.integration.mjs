import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile, readFile, mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {NativeSession} from '../lib/native-session.mjs';

test('real native menu Copy/Cut wait for browser confirmation and Paste never uses stale private data', {timeout:60000}, async () => {
  const original = await readFile('demo/demo.lyx');
  const directory = await mkdtemp(resolve('.native/menu-clipboard-integration-'));
  const path = join(directory,'demo.lyx');
  await copyFile('demo/demo.lyx',path);
  const session = new NativeSession();
  const frame = () => session.call('frame',{width:1000,height:800});
  const command = command => session.call('command',{command});
  const source = async () => (await session.call('selection')).source;
  const key = async (key,text='',modifiers={}) => {
    await session.call('input',{type:'keydown',key,text,...modifiers});
    await session.call('input',{type:'keyup',key,text,...modifiers});
  };
  const label = value => value.replaceAll('&','').split('\t')[0];
  const click = async (surface,action) => {
    const pointer = {surface:surface.id,x:Math.round(action.x+action.width/2),y:Math.round(action.y+action.height/2),button:0};
    await session.call('input',{type:'pointerdown',...pointer,buttons:1});
    await session.call('input',{type:'pointerup',...pointer,buttons:0});
  };
  const menu = async action => {
    const root = (await frame()).surfaces.find(surface=>surface.main);
    const edit = root.menuActions.find(item=>label(item.text)==='Edit');
    assert.ok(edit,'Native Edit menu is present');
    await click(root,edit);
    const popup = (await frame()).surfaces.find(surface=>!surface.main && surface.menuActions?.some(item=>label(item.text)===action));
    assert.ok(popup,`Native ${action} menu item is present`);
    assert.equal(popup.isMenu,true,'Native QMenu subclasses carry an explicit menu marker');
    const item = popup.menuActions.find(item=>label(item.text)===action);
    assert.equal(item.enabled,true,`${action} is enabled`);
    if (action === 'Copy' || action === 'Cut')
      assert.equal(item.clipboardAction,action.toLowerCase(),'Menu semantics come from the native command, not translated labels');
    await click(popup,item);
    const state = await session.call('state');
    const pending = state.menuClipboard;
    assert.equal(pending?.action,action.toLowerCase(),`Menu result: ${JSON.stringify(state)}`);
    return pending;
  };
  const select = async () => {await command('buffer-end');await command('line-begin');await command('word-forward-select');};
  try {
    await session.start(path);
    await frame();
    // Use explicit prose; the public sample begins with a non-text macro inset.
    await command('buffer-end');await key(0x1000004);await command('layout Standard');
    await session.call('input',{type:'commit',text:'Menu clipboard fixture'});
    await select();
    const before = await source();
    const copied = await menu('Copy');
    assert.ok(copied.clipboard.text);
    assert.equal(await source(),before);
    await session.call('clipboard',{action:'menu-commit',requestId:copied.id});
    assert.equal((await session.call('state')).menuClipboard,undefined);

    const cancelled = await menu('Cut');
    assert.equal(await source(),before,'A menu cut must await browser clipboard confirmation');
    await session.call('clipboard',{action:'menu-cancel',requestId:cancelled.id});
    assert.equal(await source(),before,'Cancelling a pending cut preserves the document');
    assert.equal((await session.call('clipboard',{action:'menu-commit',requestId:cancelled.id})).error,true);

    const stale = await menu('Cut');
    await command('buffer-end');
    assert.equal((await session.call('clipboard',{action:'menu-commit',requestId:stale.id})).error,true);
    assert.equal(await source(),before,'A changed selection cannot be cut by a stale confirmation');

    await select();
    const cut = await menu('Cut');
    const committed = await session.call('clipboard',{action:'menu-commit',requestId:cut.id});
    assert.ok(!committed.error,committed.message);
    const afterCut = await source();
    assert.notEqual(afterCut,before);
    await session.call('clipboard',{action:'menu-commit',requestId:cut.id});
    assert.equal(await source(),afterCut,'A duplicated confirmation must never cut twice');
    await command('undo');
    assert.equal(await source(),before);

    const paste = await menu('Paste');
    assert.equal(await source(),before,'Native menu Paste must not use an old private clipboard');
    await session.call('clipboard',{action:'menu-cancel',requestId:paste.id});
    assert.equal(await source(),before);

    // LyX regenerates HTML paragraph IDs on copy. A browser gesture already
    // wrote its prefetched MIME, so an unchanged menu action must reuse it all.
    await command('buffer-end');await key(0x1000004);await command('layout Standard');
    await session.call('input',{type:'commit',text:'Menu snapshot formula '});
    await key(77,'m',{meta:true});await key(88,'x');await key(94,'^',{shift:true});await key(50,'2');
    await command('buffer-end');await command('line-begin-select');
    const prefetched = (await session.call('clipboard',{action:'copy'})).clipboard;
    assert.match(Buffer.from(prefetched.formats['application/x-lyx'],'base64').toString(),/\\begin_inset Formula \$x\^\{2\}\$/);
    assert.match(Buffer.from(prefetched.formats['text/html'],'base64').toString(),/magicparlabel-/);
    for (const action of ['Copy','Cut']) {
      const unchanged = await menu(action);
      assert.deepEqual(unchanged.clipboard.formats,prefetched.formats,'Unchanged menus reuse every original MIME byte, including HTML IDs');
      assert.equal(unchanged.clipboard.text,prefetched.text);
      await session.call('clipboard',{action:'menu-cancel',requestId:unchanged.id});
    }
    const unformatted = await source();
    const selectionBeforeFormat = (await session.call('state')).clipboardSelection;
    await command('font-bold');
    assert.notEqual(await source(),unformatted,'Formatting changes the serialized document');
    assert.deepEqual((await session.call('state')).clipboardSelection,selectionBeforeFormat,'Formatting preserves selection text and coordinates');
    const formatted = await menu('Copy');
    assert.notEqual(formatted.clipboard.formats['application/x-lyx'],prefetched.formats['application/x-lyx'],
      'The full document hash must reject cached MIME after a format-only edit');
    assert.match(Buffer.from(formatted.clipboard.formats['application/x-lyx'],'base64').toString(),/\\series bold/);
    assert.equal(formatted.clipboard.text,prefetched.text);
    await session.call('clipboard',{action:'menu-cancel',requestId:formatted.id});

    for (const action of ['Copy','Cut']) {
      const pendingFormatEdit = await menu(action);
      const selectionAtMenu = (await session.call('state')).clipboardSelection;
      const sourceAtMenu = await source();
      await command('font-emph');
      const sourceAfterFormat = await source();
      assert.notEqual(sourceAfterFormat,sourceAtMenu);
      assert.deepEqual((await session.call('state')).clipboardSelection,selectionAtMenu,
        'A pending-menu formatting edit keeps the same text and selection coordinates');
      const rejected = await session.call('clipboard',{action:'menu-commit',requestId:pendingFormatEdit.id});
      assert.equal(rejected.error,true,`${action} must reject a format-only change after its snapshot`);
      assert.match(rejected.message,/document changed/);
      assert.equal(await source(),sourceAfterFormat,'A stale menu confirmation must never cut newer formatting');
      assert.equal((await session.call('state')).menuClipboard,undefined);
      assert.equal((await session.call('clipboard',{action:'menu-commit',requestId:pendingFormatEdit.id})).error,true,
        'A rejected stale request cannot be retried');
    }
    const cancelAfterFormat = await menu('Cut');
    await command('font-emph');
    const sourceAtCancel = await source();
    assert.ok(!(await session.call('clipboard',{action:'menu-cancel',requestId:cancelAfterFormat.id})).error,
      'Cancel remains available even after the document changed');
    assert.equal(await source(),sourceAtCancel);
    assert.deepEqual(await readFile(path),original);
    assert.deepEqual(await readFile('demo/demo.lyx'),original);
    console.log(`Native menu clipboard evidence: ${directory}`);
  } finally {session.stop();}
});
