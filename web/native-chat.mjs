// Attach only selection context. Do not write to the composer or send a message.
// Read the native session for full source when needed.
export async function addNativeSelectionToChat(selection,extensions,{crypto:cryptoApi=globalThis.crypto,sessionId}={}){
  if(!selection?.hasSelection || selection.clipboardSelection?.kind==='widget')
    throw new Error('Select content in the LyX document first');
  if(!extensions?.modelContext)
    throw new Error('This host does not provide a selection context interface');
  const hash=Array.from(new Uint8Array(await cryptoApi.subtle.digest('SHA-256',new TextEncoder().encode(selection.source))))
    .map(byte=>byte.toString(16).padStart(2,'0')).join('');
  const context={type:'lyx-selection',file:selection.path,text:selection.selection,
    start:selection.selectionStart,end:selection.selectionEnd,diskRevision:selection.diskRevision,
    bufferRevision:hash,unsaved:selection.modified,
    sessionId,clipboardSelection:selection.clipboardSelection,
    editingSupported:selection.capabilities?.editSelection===true && selection.capabilities?.compositionGuard===true};
  const text=`LyX selection\nFile: ${context.file}\nNative session: ${sessionId??'Not provided'}\nSelected content:\n${context.text}\n\nNative cursor range (zero-based, including nested formulas and insets): ${JSON.stringify({start:context.start,end:context.end})}\nDisk revision: ${context.diskRevision}\nEditor revision: ${hash}\nUnsaved changes: ${context.unsaved}\nNative editing with revision checks supported: ${context.editingSupported}\nFull selection identity: ${JSON.stringify(context.clipboardSelection)}`;
  const accepted=await extensions.modelContext.update({content:[{type:'text',text}],structuredContent:context});
  if(!accepted?.updateId)throw new Error('The host has not confirmed the selection context');
  const current=extensions.modelContext.getCurrent?.();
  return {updateId:accepted.updateId,contextVerified:current?.updateId===accepted.updateId,contextAttached:true};
}
