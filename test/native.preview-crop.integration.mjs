import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';

test('legacy preview crop handles spaced paths and preserves images on subprocess failure',async()=>{
  const engine=JSON.parse(await readFile('.native/engine.json','utf8'));
  const library=process.env.LYX_CODEX_LIBRARY??engine.library;
  const directory=await mkdtemp(resolve('.native/preview crop-'));
  const script=join(directory,'check.py');
  await writeFile(script,String.raw`
import importlib.util, pathlib, subprocess, sys
library, directory = map(pathlib.Path, sys.argv[1:])
sys.path.insert(0, str(library / 'scripts'))
spec = importlib.util.spec_from_file_location('legacy', library / 'scripts/legacy_lyxpreview2ppm.py')
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)
cropper = directory / 'crop tool'
cropper.write_text('#!' + sys.executable + '\n' + '''import sys
data = sys.stdin.buffer.read()
if data == b'fail' and sys.argv[1] == '-right':
    sys.exit(3)
sys.stdout.buffer.write(data.lstrip(b' ') if sys.argv[1] == '-left' else data.rstrip(b' '))
''')
cropper.chmod(0o755)
image = directory / 'sample 1.ppm'
image.write_bytes(b'  pixels  ')
legacy.crop_files(str(cropper), str(directory / 'sample '))
assert image.read_bytes() == b'pixels', 'both temporary streams must be rewound'
image.write_bytes(b'  fail')
try:
    legacy.crop_files(str(cropper), str(directory / 'sample '))
except subprocess.CalledProcessError:
    pass
else:
    raise AssertionError('failed crop was accepted')
assert image.read_bytes() == b'  fail', 'failure must preserve the original'
print('Preview crop checks passed')
`);
  const output=execFileSync('python3',[script,library,directory],{encoding:'utf8',timeout:10000});
  assert.match(output,/Preview crop checks passed/);
});
