import {spawn} from 'node:child_process';
import {createConnection} from 'node:net';
import {mkdir, mkdtemp, cp, readFile, writeFile, realpath, access, lstat} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {tmpdir, homedir} from 'node:os';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const root = fileURLToPath(new URL('..', import.meta.url));
const delay = ms => new Promise(r => setTimeout(r, ms));

export class NativeSession {
  pending = new Map();
  serial = 0;
  async start(path) {
    try {return await this.startEngine(path);}
    catch (error) {this.stop();throw error;}
  }
  async startEngine(path) {
    this.path = await realpath(path);
    if (!this.path.toLowerCase().endsWith('.lyx')) throw new Error('Select a .lyx file');
    this.id = randomUUID();
    this.directory = await mkdtemp(join(tmpdir(), 'lyxc-'));
    this.socketPath = join(this.directory, 'engine.sock');
    const profile = join(this.directory, 'profile');
    const userProfile = process.env.LYX_USER_PROFILE ?? join(homedir(), 'Library/Application Support/LyX-2.4');
    await mkdir(profile, {recursive: true});
    try {await cp(userProfile, profile, {recursive: true, filter:async source=>{
      // A running desktop LyX puts FIFO pipes and sockets in this directory.
      // Copy settings, never its live IPC endpoints.
      const entry=await lstat(source);
      return entry.isDirectory() || entry.isFile() || entry.isSymbolicLink();
    }});}
    catch (error) {if(error.code!=='ENOENT')throw error;}
    const preferences = join(profile, 'preferences');
    let prefs = await readFile(preferences, 'utf8').catch(() => '');
    // Keep the user's fonts and key bindings in this private profile, while
    // using English UI and preventing restoration of unrelated documents.
    // Native macOS style needs a Cocoa surface; offscreen uses Fusion.
    prefs += '\n\\load_session false\n\\gui_language "english"\n\\ui_style "Fusion"\n\\draw_strategy backingstore\n';
    await writeFile(preferences, prefs);
    const engine = JSON.parse(await readFile(resolve(root,'.native/engine.json'),'utf8').catch(()=>'{}'));
    const executable = process.env.LYX_CODEX_BINARY ?? engine.binary ?? resolve(root, '.native/build-engine/bin/LyX');
    await access(executable);
    const library = process.env.LYX_CODEX_LIBRARY ?? engine.library ?? resolve(root, '.native/lyx-source/lib');
    const log = this.log = createWriteStream(join(this.directory, 'engine.log'));
    this.process = spawn(executable, ['--no-remote', '-userdir', profile, '-sysdir', library, this.path], {
      env: {...process.env, QT_QPA_PLATFORM: 'offscreen', QT_STYLE_OVERRIDE: 'Fusion', LYX_CODEX_SOCKET: this.socketPath},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.process.stdout.pipe(log, {end:false}); this.process.stderr.pipe(log, {end:false});
    this.process.once('close', () => log.end());
    this.process.once('exit', (code, signal) => {this.exited = {code, signal}; this.socket?.destroy();this.rejectAll(new Error(`LyX exited (${code ?? signal}); log: ${this.directory}/engine.log`));});
    this.process.once('error', error => {this.startError = error;});
    for (let i = 0; i < 150; i++) {
      if (this.startError) throw this.startError;
      if (this.exited) throw new Error(`LyX failed to start; log: ${this.directory}/engine.log`);
      try {await access(this.socketPath); break;} catch {await delay(100);}
    }
    await new Promise((resolveConnect, reject) => {
      this.socket = createConnection(this.socketPath);
      this.socket.once('connect', resolveConnect);
      this.socket.once('error', reject);
    });
    let buffer = '';
    this.socket.setEncoding('utf8');
    this.socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 64 * 1024 * 1024) {this.socket.destroy(new Error('LyX frame is too large')); return;}
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          const response = JSON.parse(line), request = this.pending.get(response.id);
          if (request) {clearTimeout(request.timer); this.pending.delete(response.id); request.resolve(response.result);}
        } catch (error) {this.rejectAll(error);}
      }
    });
    this.socket.on('error', error => this.rejectAll(error));
    this.socket.on('close', () => this.rejectAll(new Error('The LyX editor connection has closed')));
    for (let i = 0; i < 200; i++) {
      const state = await this.call('state');
      if (state.ready) return this;
      await delay(100);
    }
    throw new Error(`LyX has not opened the document; log: ${this.directory}/engine.log`);
  }
  rejectAll(error) {for (const request of this.pending.values()) {clearTimeout(request.timer); request.reject(error);} this.pending.clear();}
  call(method, params = {}) {
    if (this.exited || !this.socket || this.socket.destroyed) return Promise.reject(new Error('The LyX editor is unavailable'));
    const id = ++this.serial;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {this.pending.delete(id); reject(new Error(`The LyX ${method} request timed out`));}, 15000);
      this.pending.set(id, {resolve: resolveResult, reject, timer});
      this.socket.write(JSON.stringify({id, method, params}) + '\n');
    });
  }
  // Explicit lifecycle operation. Call only for a disposable test session or after
  // the user has resolved any unsaved changes.
  stop() {this.socket?.destroy(); this.process?.kill('SIGTERM');}
}
