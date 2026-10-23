// Attach only selection context. Do not write to the composer or send a message.
// Read the native session for full source when needed.
export async function addNativeSelectionToChat(selection,extensions,{crypto:cryptoApi=globalThis.crypto,sessionId}={}){
  if(!selection?.hasSelection || selection.clipboardSelection?.kind==='widget')
    throw new Error('Select content in the LyX document first');
  if(!extensions?.modelContext)
    throw new Error('This host does not provide a selection context interface');
  const compact=selection.modelCapabilities?.selectionSnapshots===true
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(selection.snapshotId??'')
    && ['text','math'].includes(selection.selectionFormat) && !!sessionId;
  let hash;
  if(!compact){
    hash=selection.sourceRevision;
    if(!/^[a-f0-9]{64}$/i.test(hash??'')){
      if(typeof selection.source!=='string')throw new Error('LyX did not return a document revision; try attaching the selection again');
      hash=Array.from(new Uint8Array(await cryptoApi.subtle.digest('SHA-256',new TextEncoder().encode(selection.source))))
        .map(byte=>byte.toString(16).padStart(2,'0')).join('');
    }
  }
  // Both content and structuredContent reach the model. Keep the passage only
  // in content and its edit target only in structuredContent. Snapshot revisions
  // and ranges remain in the native process, where every write validates them.
  const context=compact?{type:'lyx-selection',file:selection.path,sessionId,snapshotId:selection.snapshotId,
    format:selection.selectionFormat}:{type:'lyx-selection',file:selection.path,sessionId,
    bufferRevision:hash,range:{start:selection.selectionStart,end:selection.selectionEnd},
    editingSupported:selection.capabilities?.editSelection===true && selection.capabilities?.compositionGuard===true};
  const filename=selection.path.split(/[\\/]/).at(-1);
  const text=`LyX selection · ${filename}\n\n${selection.selection}`;
  const accepted=await extensions.modelContext.update({content:[{type:'text',text}],structuredContent:context});
  if(!accepted?.updateId)throw new Error('The host has not confirmed the selection context');
  const current=extensions.modelContext.getCurrent?.();
  return {updateId:accepted.updateId,contextVerified:current?.updateId===accepted.updateId,contextAttached:true,snapshotAttached:compact};
}
