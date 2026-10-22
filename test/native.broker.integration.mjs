import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile, readFile, mkdtemp, mkdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {startBroker, brokerFile} from '../server/native-broker.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
async function registryRevision() {
  try {return createHash('sha256').update(await readFile(brokerFile)).digest('hex');}
  catch(error) {if(error.code === 'ENOENT')return null;throw error;}
}

test('real LyX broker: reopen the requested buffer after native File Open and Save As without losing edits', {timeout:120000}, async () => {
  const originalPath = resolve(root, 'demo/demo.lyx');
  const original = await readFile(originalPath);
  const registryBefore = await registryRevision();
  await mkdir(resolve(root, '.native'), {recursive:true});
  const directory = await mkdtemp(resolve(root, '.native/broker-integration-'));
  const a = join(directory, 'document A.lyx');
  const b = join(directory, 'document B.lyx');
  const c = join(directory, 'document C.lyx');
  const d = join(directory, 'document D.lyx');
  await Promise.all([copyFile(originalPath, a), copyFile(originalPath, b), copyFile(originalPath, d)]);
  // This listener has an ephemeral port and cannot replace the live editor's
  // discovery registry or reuse any of its running native sessions.
  const broker = await startBroker({port:0, registryPath:null});
  const command = async (session, value) => {
    const result = await session.call('command', {command:value});
    assert.ok(!result.error, `${value}: ${result.message}`);
    return result;
  };
  const eventually = async (session, predicate, message) => {
    for(let attempt=0;attempt<100;attempt++) {
      const snapshot = await session.call('selection');
      if(predicate(snapshot))return snapshot;
      await delay(50);
    }
    assert.fail(message);
  };
  const appendNativeText = async (session, text) => {
    await command(session, 'buffer-end');
    await session.call('input', {type:'keydown', key:0x1000004});
    await session.call('input', {type:'keyup', key:0x1000004});
    await command(session, 'layout Standard');
    await session.call('input', {type:'commit', text});
    return eventually(session, snapshot => snapshot.source.includes(text) && snapshot.modified,
      'The test must create a real unsaved native edit');
  };
  try {
    const initial = await broker.open(a);
    assert.equal(initial.path, a);
    assert.notEqual(new URL(initial.url).port, '0', 'The descriptor identifies the actual ephemeral listener');
    assert.notEqual(new URL(initial.url).port, '43128', 'The test does not bind the live editor port');
    const session = broker.sessions.get(initial.sessionId);
    assert.ok(session);
    await session.call('frame', {width:1000,height:800});
    const openThroughHttp = async path => {
      const response = await fetch(initial.url + '/open', {
        method:'POST',
        headers:{'Content-Type':'application/json', Authorization:`Bearer ${initial.token}`},
        body:JSON.stringify({path}),
      });
      const result = await response.json();
      assert.equal(response.status, 200, result.error || 'The broker accepts the requested file');
      return result;
    };

    const aMarker = 'Unsaved edits belong to document A';
    const editedA = await appendNativeText(session, aMarker);
    assert.deepEqual(await readFile(a), original, 'The edit in A remains unsaved');
    await command(session, `file-open ${b}`);
    const openedB = await eventually(session, snapshot => snapshot.path === b,
      'Native File Open must switch the active document to B');
    assert.ok(!openedB.source.includes(aMarker));

    const restoredA = await openThroughHttp(a);
    assert.equal(restoredA.sessionId, initial.sessionId, 'The broker reuses the process containing the existing A buffer');
    assert.equal(restoredA.path, a);
    const activeA = await session.call('selection');
    assert.equal(activeA.path, a, 'The returned descriptor agrees with the actual native active buffer');
    assert.equal(activeA.source, editedA.source, 'Switching back preserves every unsaved edit in A');
    assert.equal(activeA.modified, true);
    assert.equal(broker.sessions.size, 1);

    await command(session, `buffer-write-as ${c}`);
    const savedC = await eventually(session,
      snapshot => snapshot.path === c && !snapshot.modified && snapshot.source.includes(aMarker),
      'Native Save As must rename the active buffer to C and save its content');
    assert.ok((await readFile(c, 'utf8')).includes(aMarker));
    assert.deepEqual(await readFile(a), original, 'Save As leaves the original A file intact');
    const cMarker = 'Unsaved edits in renamed document C must survive reopening A';
    const editedC = await appendNativeText(session, cMarker);
    assert.ok(!savedC.source.includes(cMarker));
    assert.ok(!(await readFile(c, 'utf8')).includes(cMarker), 'The second edit in C remains unsaved');

    // Concurrent callers for the same missing buffer share its startup promise.
    const [freshA, sameFreshA] = await Promise.all([openThroughHttp(a), openThroughHttp(a)]);
    assert.equal(freshA.sessionId, sameFreshA.sessionId);
    assert.notEqual(freshA.sessionId, initial.sessionId, 'A renamed buffer must not masquerade as the original file');
    assert.equal(freshA.path, a);
    assert.equal(broker.sessions.size, 2, 'The original process remains alive with its unsaved C buffer');
    const freshSession = broker.sessions.get(freshA.sessionId);
    const freshSnapshot = await freshSession.call('selection');
    assert.equal(freshSnapshot.path, a);
    assert.ok(!freshSnapshot.source.includes(aMarker));
    assert.ok(!freshSnapshot.source.includes(cMarker));
    assert.equal(freshSnapshot.modified, false);
    assert.equal((await session.call('selection')).source, editedC.source);

    // Fault injection: a separate, unrelated session has lost its bridge
    // connection. Put it first in the probe order so a healthy match cannot
    // accidentally hide a broker failure. This object owns no native process.
    const healthySessions = [...broker.sessions];
    const failedProbes = [];
    broker.sessions.clear();
    broker.sessions.set('unrelated-disconnected-fixture', {
      async call(method) {
        failedProbes.push(method);
        throw new Error('Injected unrelated bridge disconnection');
      },
      stop() {},
    });
    for(const [id, healthySession] of healthySessions)broker.sessions.set(id, healthySession);

    const reusedC = await openThroughHttp(c);
    assert.equal(reusedC.sessionId, initial.sessionId, 'The broker discovers and reuses the renamed native buffer');
    assert.equal(reusedC.path, c);
    const activeC = await session.call('selection');
    assert.equal(activeC.path, c);
    assert.equal(activeC.source, editedC.source);
    assert.equal(activeC.modified, true);
    assert.equal(broker.sessions.size, 3, 'Only the two healthy engines and the injected failed probe exist');
    const openedD = await openThroughHttp(d);
    assert.equal(openedD.path, d);
    assert.notEqual(openedD.sessionId, initial.sessionId);
    assert.notEqual(openedD.sessionId, freshA.sessionId);
    const activeD = await broker.sessions.get(openedD.sessionId).call('selection');
    assert.equal(activeD.path, d, 'An unrelated failed bridge does not prevent opening a new document');
    assert.equal(activeD.modified, false);
    assert.ok(!activeD.source.includes(aMarker));
    assert.ok(!activeD.source.includes(cMarker));
    assert.deepEqual(failedProbes, ['state','state'], 'Both reuse and new-document opening encountered the injected failure');
    assert.equal((await session.call('selection')).source, editedC.source, 'The healthy unsaved C buffer is preserved');
    assert.deepEqual(await readFile(originalPath), original, 'The supplied demo remains untouched');
    assert.equal(await registryRevision(), registryBefore, 'The live editor registry was not replaced');
    console.log(`Broker buffer-identity evidence: ${directory}`);
  } finally {
    // Only this broker's disposable fixture processes are stopped.
    for(const session of broker.sessions.values())session.stop();
    const closed = new Promise(resolveClose => broker.server.close(resolveClose));
    broker.server.closeAllConnections();
    await closed;
  }
});
