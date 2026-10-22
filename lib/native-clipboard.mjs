// Snapshots are scoped to this running broker. IDs on the browser clipboard do
// not expose filesystem paths or grant access to arbitrary native commands.
export class NativeClipboardStore {
  copies=new Map();
  copy(id,operation){
    if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid clipboard ID');
    if(this.copies.has(id))return this.copies.get(id);
    const pending=Promise.resolve().then(operation).then(result=>{
      if(result.error||!result.clipboard)throw new Error(result.message||'Could not copy the selection');
      return result;
    });
    // Preserve failures for a subsequent paste, without an unhandled rejection
    // when the user copies but never pastes.
    pending.catch(()=>{});
    this.copies.set(id,pending);
    while(this.copies.size>32)this.copies.delete(this.copies.keys().next().value);
    return pending;
  }
  async resolve(id,fallback){
    if(this.copies.has(id))return (await this.copies.get(id)).clipboard.formats;
    if(fallback && Object.keys(fallback).length)return fallback;
    throw new Error('The native clipboard session has expired; copy the selection again');
  }
}
