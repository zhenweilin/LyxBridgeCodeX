import {writeBrowserClipboard} from './native-clipboard.mjs';

// This must run synchronously in a real browser gesture, before crossing the
// Qt bridge. Never acknowledge Cut unless the browser copy event succeeded.
export function copyNativeClipboardWithGesture(clipboard, {
  document: doc = globalThis.document,
  crypto: cryptoApi = globalThis.crypto,
} = {}) {
  if (!clipboard?.formats || typeof clipboard.text !== 'string')
    throw new Error('Native clipboard content is not ready; choose Copy or Cut again');
  const copyId = cryptoApi.randomUUID();
  const input = doc.createElement('textarea');
  input.value = clipboard.text;
  input.setAttribute('aria-hidden', 'true');
  Object.assign(input.style, {position:'fixed',left:'-10000px',top:'0',opacity:'0'});
  const previousFocus = doc.activeElement;
  let copied = false, failure;
  const copy = event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      if (!event.clipboardData) throw new Error('The browser did not provide a clipboard write interface');
      writeBrowserClipboard(event.clipboardData, {text:clipboard.text,copyId,clipboard});
      copied = true;
    } catch (error) {failure = error;}
  };
  doc.body.append(input);
  doc.addEventListener('copy', copy, true);
  try {
    input.focus({preventScroll:true});
    input.select();
    const accepted = doc.execCommand?.('copy');
    if (failure) throw failure;
    if (!accepted || !copied) throw new Error('The browser did not allow writing to the system clipboard');
    return {copyId};
  } finally {
    doc.removeEventListener('copy', copy, true);
    input.remove();
    previousFocus?.focus?.({preventScroll:true});
  }
}

export async function completeNativeMenuClipboard(request, {rpc,writeClipboard=copyNativeClipboardWithGesture}) {
  // writeClipboard is synchronous on purpose: the browser gesture must still
  // be active, and a failed write must not cause the native cut to commit.
  writeClipboard(request.clipboard);
  try {return await rpc('clipboard', {action:'menu-commit',requestId:request.id});}
  catch (error) {error.clipboardWritten = true;throw error;}
}

const clipboardFormats = new Set(['application/x-lyx','text/plain','text/html','text/x-tex','application/x-latex']);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
function selectionIdentity(state) {
  const selection = state?.clipboardSelection;
  if (!state?.ready || typeof state.path !== 'string' || !state.path
      || selection?.kind !== 'document' || selection.hasSelection !== true) return;
  return JSON.stringify(canonical({path:state.path,clipboardSelection:selection}));
}
function clipboardSnapshot(state, clipboard) {
  try {
    const identity = selectionIdentity(state);
    if (!identity || selectionIdentity(clipboard?.origin) !== identity
        || typeof clipboard.text !== 'string' || !clipboard.formats
        || typeof clipboard.formats !== 'object' || Array.isArray(clipboard.formats)) return;
    const entries = Object.entries(clipboard.formats);
    if (!entries.length || entries.length > clipboardFormats.size) return;
    let bytes = 0;
    for (const [type,value] of entries) {
      if (!clipboardFormats.has(type) || typeof value !== 'string'
          || value.length > Math.ceil(512*1024/3)*4) return;
      const decoded = atob(value);
      bytes += decoded.length;
      if (bytes > 512*1024 || btoa(decoded) !== value) return;
    }
    // Retain only the origin fields used for validation, not a mutable state
    // object or recursively nested older menu requests.
    const snapshot = {text:clipboard.text,formats:clipboard.formats,
      origin:{ready:true,path:state.path,clipboardSelection:state.clipboardSelection}};
    const signature = JSON.stringify(canonical(snapshot));
    return {identity,signature,clipboard:JSON.parse(signature)};
  } catch {return;}
}
function menuItemAt(params, surface) {
  if (!surface || surface.id !== params.surface || surface.main !== false || surface.isMenu !== true
      || !Array.isArray(surface.menuActions) || !Number.isFinite(params.x) || !Number.isFinite(params.y)) return;
  const items = surface.menuActions.filter(item=>item.enabled === true && item.separator === false
    && ['copy','cut'].includes(item.clipboardAction)
    && [item.x,item.y,item.width,item.height].every(Number.isFinite) && item.width > 0 && item.height > 0
    && params.x >= item.x && params.x < item.x+item.width && params.y >= item.y && params.y < item.y+item.height);
  if (items.length !== 1) return;
  const item = items[0];
  return {action:item.clipboardAction,key:JSON.stringify([surface.id,item.clipboardAction,item.x,item.y,item.width,item.height])};
}

// Keep the synchronous gesture separate from its later native acknowledgement.
// Only the state fetched after the corresponding Qt pointerup may consume the
// opaque receipt; ordinary frame polling must never authorize a cut.
export function createNativeMenuClipboardGesture({writeClipboard=copyNativeClipboardWithGesture,onFailure=()=>{}}={}) {
  let prepared, pressed, generation = 0;
  const receipts = new WeakMap();
  function prepare(state, clipboard) {
    prepared = clipboardSnapshot(state,clipboard);
    return Boolean(prepared);
  }
  function invalidateGesture() {prepared=pressed=undefined;generation++;}
  function handlePointer(params, {surface,state,clipboard}={}) {
    if (params.type === 'pointercancel') {invalidateGesture();return;}
    if (!['pointerdown','pointerup'].includes(params.type)) return;
    const item = menuItemAt(params,surface);
    if (params.type === 'pointerdown') {
      pressed = undefined;generation++;
      const snapshot = clipboard === undefined ? prepared : clipboardSnapshot(state,clipboard);
      if (params.button !== 0 || !item || !snapshot || snapshot.identity !== selectionIdentity(state)) return;
      pressed = {snapshot,item,pointerId:params.pointerId,generation,previousId:state?.menuClipboard?.id};
      return;
    }
    const candidate = pressed;pressed=undefined;
    if (!candidate || params.button !== 0 || candidate.pointerId !== params.pointerId
        || !item || item.key !== candidate.item.key || candidate.generation !== generation
        || candidate.snapshot.identity !== selectionIdentity(state)) return;
    try {
      const result = writeClipboard(candidate.snapshot.clipboard);
      if (result?.then) throw new Error('The clipboard must be written synchronously during the menu click');
    } catch (error) {onFailure(error);return;}
    const receipt = Object.freeze({});
    receipts.set(receipt,{...candidate,previousIds:[candidate.previousId,state?.menuClipboard?.id]});
    return receipt;
  }
  function takeMatchingRequest(state, receipt) {
    const candidate = receipt && receipts.get(receipt);
    if (receipt) receipts.delete(receipt);
    if (!candidate || candidate.generation !== generation) return;
    const request = state?.menuClipboard;
    if (typeof request?.id !== 'string' || !request.id || candidate.previousIds.includes(request.id)
        || request.action !== candidate.item.action || selectionIdentity(state) !== candidate.snapshot.identity) return;
    const snapshot = clipboardSnapshot(state,request.clipboard);
    if (!snapshot || snapshot.signature !== candidate.snapshot.signature) return;
    return {id:request.id,action:request.action,clipboard:snapshot.clipboard};
  }
  return {prepare,handlePointer,invalidateGesture,takeMatchingRequest};
}

export function createNativeMenuClipboard({rpc,notice,document:doc=globalThis.document,
  writeClipboard=clipboard=>copyNativeClipboardWithGesture(clipboard,{document:doc})}) {
  const banner = doc.createElement('aside');
  banner.hidden = true;
  banner.setAttribute('role','status');
  banner.setAttribute('aria-live','polite');
  Object.assign(banner.style, {flex:'none',padding:'10px 12px',background:'#fff7df',borderTop:'1px solid #d6b567'});
  const label = doc.createElement('span');
  const complete = doc.createElement('button');
  const cancel = doc.createElement('button');
  complete.type = cancel.type = 'button';
  Object.assign(complete.style, {marginLeft:'12px'});
  Object.assign(cancel.style, {marginLeft:'8px'});
  cancel.textContent = 'Cancel';
  banner.append(label, complete, cancel);
  doc.body.insertBefore(banner, doc.querySelector('footer'));
  let pending, busy = false, active = true;
  const completed = new Set();
  const gesture = createNativeMenuClipboardGesture({writeClipboard,onFailure:error=>notice(`${error.message}. Use the confirmation button to try again.`)});
  function remember(id) {
    completed.add(id);
    while(completed.size > 32) completed.delete(completed.values().next().value);
  }
  function render() {
    if(!active)return;
    banner.hidden = !pending;
    if (!pending) return;
    const cut = pending.action === 'cut';
    const paste = pending.action === 'paste';
    label.textContent = paste ? 'Press ⌘V to paste (Windows/Linux: Ctrl+V)'
      : cut ? 'The selection will be cut only after it is copied to the system clipboard.' : 'Click the button to copy the LyX selection to the system clipboard.';
    complete.hidden = paste;
    complete.textContent = cut ? 'Confirm Cut' : 'Copy to system clipboard';
    complete.disabled = cancel.disabled = busy;
  }
  async function update(state, {receipt}={}) {
    const next = state?.menuClipboard;
    if(active)pending = next?.id && ['copy','cut','paste'].includes(next.action) && !completed.has(next.id) ? next : undefined;
    render();
    const request = gesture.takeMatchingRequest(state,receipt);
    if (!request || busy || completed.has(request.id)) return false;
    return finish(request,true);
  }
  async function finish(request, alreadyWritten=false) {
    busy = true; render();
    try {
      if (alreadyWritten) {
        try {await rpc('clipboard',{action:'menu-commit',requestId:request.id});}
        catch (error) {error.clipboardWritten=true;throw error;}
      } else await completeNativeMenuClipboard(request,{rpc,writeClipboard});
      remember(request.id);
      if (pending?.id === request.id) pending = undefined;
      notice(request.action === 'cut' ? 'Selection copied to the system clipboard and cut.' : 'Selection copied to the system clipboard.');
      if (active && !alreadyWritten) doc.getElementById('input')?.focus({preventScroll:true});
      return true;
    } catch (error) {
      const detail = error.clipboardWritten
        ? 'Content was written to the system clipboard; the native operation is not yet confirmed. Check the document.'
        : `${request.action === 'cut' ? 'Cut was not submitted. ' : ''}Cancel and use ${request.action === 'cut' ? '⌘X' : '⌘C'} (Windows/Linux: Ctrl+${request.action === 'cut' ? 'X' : 'C'}).`;
      notice(`${error.message}. ${detail}`);
      return false;
    } finally {busy = false;render();}
  }
  complete.addEventListener('click', async () => {
    const request = pending;
    if (!active || !request || request.action === 'paste' || busy) return;
    gesture.invalidateGesture();
    await finish(request);
  });
  cancel.addEventListener('click', async () => {
    const request = pending;
    if (!active || !request || busy) return;
    gesture.invalidateGesture();
    busy = true; render();
    try {
      await rpc('clipboard',{action:'menu-cancel',requestId:request.id});
      remember(request.id);
      if (pending?.id === request.id) pending = undefined;
      if(active)doc.getElementById('input')?.focus({preventScroll:true});
    } catch(error) {notice(error.message);}
    finally {busy = false;render();}
  });
  return {update,prepare:(...args)=>active && gesture.prepare(...args),invalidateGesture:gesture.invalidateGesture,
    handlePointer:(...args)=>!active || busy ? undefined : gesture.handlePointer(...args),
    // A clipboard write already authorized by a menu click may still await its
    // queued native acknowledgement. Keep that receipt bound to this controller's
    // original RPC, while removing its controls and all future gestures.
    destroy:()=>{active=false;pending=undefined;banner.remove();}};
}
