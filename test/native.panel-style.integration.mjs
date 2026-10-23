import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';

test('native panel scrollbar preserves page clicks, dragging, keyboard, wheel and hover geometry', async () => {
  const engine = JSON.parse(await readFile('.native/engine.json', 'utf8'));
  const qt = process.env.LYX_QT_PREFIX ?? engine.qt;
  assert.ok(qt, 'The native engine must record the Qt development prefix');
  const directory = await mkdtemp(join(tmpdir(), 'lyxc-panel-style-'));
  const quoted = path => `"${path.replaceAll('\\', '/').replaceAll('"', '\\"')}"`;
  try {
    await writeFile(join(directory, 'panel-style.pro'), [
      'QT += widgets testlib',
      'CONFIG += console c++11',
      'CONFIG -= app_bundle',
      'TARGET = panel-style-check',
      `INCLUDEPATH += ${quoted(resolve('native'))}`,
      `SOURCES += ${quoted(resolve('test/native-panel-style.cpp'))}`,
      '',
    ].join('\n'));
    const options = {cwd: directory, encoding: 'utf8', timeout: 60000, stdio: 'pipe'};
    execFileSync(join(qt, 'bin/qmake'), ['panel-style.pro'], options);
    execFileSync('make', ['-j2'], options);
    const output = execFileSync(join(directory, 'panel-style-check'), [], {
      ...options, timeout: 15000,
      env: {...process.env, QT_QPA_PLATFORM: 'offscreen', QT_STYLE_OVERRIDE: 'Fusion'},
    });
    assert.match(output, /Native scrollbar checks passed \(8 configurations\)/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
