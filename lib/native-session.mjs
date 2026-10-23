import {spawn} from 'node:child_process';
import {createConnection} from 'node:net';
import {mkdtemp, readFile, realpath, access} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, join, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {lyxUpstream} from './native-engine.mjs';
import {nativeUserProfile,prepareNativeUserProfile} from './native-profile.mjs';
import {prepareNativeConfigCache} from './native-config-cache.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const delay = ms => new Promise(r => setTimeout(r, ms));

export class NativeSession {
  pending = new Map();
  serial = 0;
  startupPending = false;
  #startupTimeoutMs;
  #requestTimeoutMs;
  #configurationCache;
  #configurationPublication;
  get configurationStatus() {
    const cache=this.#configurationCache;
    return cache?{restored:cache.restored,authoritative:cache.authoritative,reason:cache.reason}:undefined;
  }
  // Diagnostics may wait for the optional cache work. Opening and interacting
  // with a ready editor never waits for it, including after a recovery prompt.
  waitForConfigurationCache() {
    return this.#configurationPublication??Promise.resolve(false);
  }
  constructor({startupTimeoutMs=40000,requestTimeoutMs=15000}={}) {
    for(const value of [startupTimeoutMs,requestTimeoutMs])
      if(!Number.isSafeInteger(value)||value<=0||value>2147483647)
        throw new RangeError('LyX timeouts must be positive integer milliseconds');
    this.#startupTimeoutMs=startupTimeoutMs;
    this.#requestTimeoutMs=requestTimeoutMs;
  }
  async start(path) {
    try {return await this.startEngine(path);}
    catch (error) {this.stop();throw error;}
  }
  async startEngine(path) {
    const deadline=performance.now()+this.#startupTimeoutMs;
    let stage='preparing the editor';
    const startupTimeout=()=>new Error(`LyX startup timed out while ${stage}; log: ${this.directory}/engine.log`);
    const remaining=()=>{
      if(this.startError)throw this.startError;
      if(this.exited)throw new Error(`LyX failed to start (${this.exited.code??this.exited.signal}); log: ${this.directory}/engine.log`);
      const time=Math.ceil(deadline-performance.now());
      if(time<=0)throw startupTimeout();
      return time;
    };
    this.path = await realpath(path);
    if (!this.path.toLowerCase().endsWith('.lyx')) throw new Error('Select a .lyx file');
    this.lastKnownPath=this.path;
    this.id = randomUUID();
    this.directory = await mkdtemp(join(tmpdir(), 'lyxc-'));
    this.socketPath = join(this.directory, 'engine.sock');
    const profile = join(this.directory, 'profile');
    const userProfile = await nativeUserProfile();
    await prepareNativeUserProfile({source:userProfile,destination:profile});
    const engine = JSON.parse(await readFile(resolve(root,'.native/engine.json'),'utf8').catch(()=>'{}'));
    const executable = process.env.LYX_CODEX_BINARY ?? engine.binary ?? resolve(root, `.native/build-engine-${lyxUpstream.version}/bin/LyX`);
    await access(executable);
    const library = process.env.LYX_CODEX_LIBRARY ?? engine.library ?? resolve(root, `.native/lyx-source-${lyxUpstream.version}/lib`);
    this.#configurationCache=await prepareNativeConfigCache({sourceProfile:userProfile,profile,
      engine:{version:engine.version??lyxUpstream.version,binary:executable,library}});
    remaining();
    const log = this.log = createWriteStream(join(this.directory, 'engine.log'));
    this.process = spawn(executable, ['--no-remote', '-userdir', profile, '-sysdir', library, this.path], {
      env: {...process.env, QT_QPA_PLATFORM: 'offscreen', QT_STYLE_OVERRIDE: 'Fusion', LYX_CODEX_SOCKET: this.socketPath},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.process.stdout.pipe(log, {end:false}); this.process.stderr.pipe(log, {end:false});
    this.process.once('close', () => log.end());
    this.process.once('exit', (code, signal) => {this.exited = {code, signal}; this.socket?.destroy();this.rejectAll(new Error(`LyX exited (${code ?? signal}); log: ${this.directory}/engine.log`));});
    this.process.once('error', error => {this.startError = error;});
    stage='waiting for the editor connection';
    for (;;) {
      remaining();
      try {await access(this.socketPath); break;}
      catch (error) {if(error.code!=='ENOENT')throw error;}
      await delay(Math.min(100,remaining()));
    }
    const connectTimeout=remaining();
    await new Promise((resolveConnect, reject) => {
      this.socket = createConnection(this.socketPath);
      const cleanup=()=>{clearTimeout(timer);this.socket.off('connect',connected);this.socket.off('error',failed);};
      const connected=()=>{cleanup();resolveConnect();};
      const failed=error=>{cleanup();reject(error);};
      const timer=setTimeout(()=>{cleanup();this.socket.destroy();reject(startupTimeout());},connectTimeout);
      this.socket.once('connect', connected);
      this.socket.once('error', failed);
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
          // Save As may finish after its RPC deadline. Observe that verified
          // native path even when the expired request can no longer resolve;
          // recovery must not reopen the original file or replay the command.
          const currentPath=response.result?.path;
          if(response.result?.ready===true && typeof currentPath==='string' && isAbsolute(currentPath)
            && currentPath.toLowerCase().endsWith('.lyx') && !currentPath.includes('\0'))
            this.lastKnownPath=resolve(currentPath);
          if (request) {
            clearTimeout(request.timer); this.pending.delete(response.id);
            if(this.startupPending && (response.result?.ready===true || response.result?.interactionRequired===false))
              this.startupPending=false;
            request.resolve(response.result);
          }
        } catch (error) {this.rejectAll(error);}
      }
    });
    this.socket.on('error', error => this.rejectAll(error));
    this.socket.on('close', () => this.rejectAll(new Error('The LyX editor connection has closed')));
    // The socket exists before first-run TeX configuration finishes. Let its
    // initial state request use the shared startup budget, without extending
    // ordinary RPCs or restarting the budget at each readiness check.
    stage='opening the document and configuring LyX';
    for (;;) {
      const state = await this.#request('state',{},remaining(),startupTimeout);
      remaining();
      if (state.ready) {
        this.#publishConfigurationWhenReady(state);
        return this;
      }
      // A visible recovery prompt needs browser input before a document can
      // become ready. Return its live session without choosing on the user's
      // behalf or leaving it behind a startup timeout.
      if(state.uiReady===true && state.interactionRequired===true){
        this.startupPending=true;return this;
      }
      await delay(Math.min(100,remaining()));
    }
  }
  rejectAll(error) {for (const request of this.pending.values()) {clearTimeout(request.timer); request.reject(error);} this.pending.clear();}
  call(method, params = {}) {
    return this.#request(method,params,this.#requestTimeoutMs,()=>new Error(`The LyX ${method} request timed out`)).then(result=>{
      // A recovery prompt may have returned before the first document loaded.
      // Publication is idempotent and only the first verified ready state can
      // supply configuration; later private preference edits are not shared.
      this.#publishConfigurationWhenReady(result);
      return result;
    });
  }
  #publishConfigurationWhenReady(state) {
    if(state?.ready!==true||this.#configurationPublication||!this.#configurationCache)return;
    const cache=this.#configurationCache;
    // Cache maintenance is not part of the native startup/RPC deadline. Its
    // failure must never stop a ready process or hide a successful user action.
    this.#configurationPublication=Promise.resolve()
      .then(()=>cache.publishAfterReady(state)).catch(()=>false);
  }
  #request(method, params, timeoutMs, timeoutError) {
    if (this.exited || !this.socket || this.socket.destroyed) return Promise.reject(new Error('The LyX editor is unavailable'));
    const id = ++this.serial;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {this.pending.delete(id); reject(timeoutError());}, timeoutMs);
      this.pending.set(id, {resolve: resolveResult, reject, timer});
      this.socket.write(JSON.stringify({id, method, params}) + '\n');
    });
  }
  // Explicit lifecycle operation. Call only for a disposable test session or after
  // the user has resolved any unsaved changes.
  stop() {this.socket?.destroy(); this.process?.kill('SIGTERM');}
}
