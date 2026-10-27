// Comments live in native Note insets. A batch attachment is one context update,
// never a composer write or a message send.
export async function addNativeCommentsToChat(snapshot,ids,extensions,{sessionId}={}){
  if(!extensions?.modelContext)throw new Error('Open this document in Codex to attach comments to chat.');
  const comments=ids.map(id=>{
    const matches=(snapshot.review?.comments??[]).filter(c=>c.id===id);
    if(matches.length!==1)throw new Error('A selected comment is missing or duplicated. Refresh comments first.');
    return matches[0];
  });
  if(!comments.length)throw new Error('Check at least one comment to attach.');
  const context={type:'lyx-comments',file:snapshot.path,sessionId,sourceRevision:snapshot.sourceRevision,
    unsaved:snapshot.modified,comments};
  const text=`LyX review comments\nFile: ${snapshot.path}\nNative session: ${sessionId}\nEditor revision: ${snapshot.sourceRevision}\nUnsaved changes: ${snapshot.modified}\n\n${comments.map((c,i)=>`${i+1}. Comment ${c.id} (${c.resolved?'resolved':'open'})\nQuoted content: ${c.quote}\nUser comment: ${c.text}\nNative note anchor: ${JSON.stringify(c.anchor)}`).join('\n\n')}\n\nRead the current native document before editing. These anchors locate native notes beside the quoted content; they are not replacement selections. Use review_native_lyx comment-locate to navigate, then select and read the intended passage. Preserve native revisions for proposed changes.`;
  const result=await extensions.modelContext.update({content:[{type:'text',text}],structuredContent:context});
  if(!result?.updateId)throw new Error('The host has not confirmed the comments attachment.');
  return {updateId:result.updateId,count:comments.length};
}

export function createNativeReview({read,run,attach,available,changed,focus,notice}){
  const $=id=>document.getElementById(id),panel=$('review-panel');
  let snapshot,draft,busy=false,lastList='',documentKey,epoch=0,refreshing,operationSerial=0;
  const checked=new Map();
  const buttons=['previous','next','accept','reject','new','refresh','submit','attach'];
  const selection=s=>s?.clipboardSelection;
  const set=(node,property,value)=>{if(node[property]!==value)node[property]=value;};
  function controls(state){
    const supported=state?.ready && state.capabilities?.review;
    set($('review-support'),'textContent',!state?.ready?'Open a document to review it.':!supported
      ?'Save and reopen this document to use review in the updated engine.'
      :'AI edits use revisions by default. Formula revisions show the complete old and new formulas.');
    const disabled=!!(busy || !supported || state?.inputMethod?.composing);
    set($('review-track'),'checked',state?.review?.tracking===true);
    set($('review-track'),'disabled',disabled);
    for(const name of buttons){
      const unavailable=name==='new'? !state?.hasSelection || selection(state)?.kind!=='document'
        :name==='submit'? !draft :name==='attach'? !available() || ![...checked.values()].some(Boolean):false;
      set($(`review-${name}`),'disabled',disabled || unavailable);
    }
  }
  function render(next){
    snapshot=next;controls(next);
    if(!Array.isArray(next.review?.comments))return;
    const list=next.review.comments,key=JSON.stringify(list);
    if(lastList===key)return;
    lastList=key;
    const ids=new Set(list.map(c=>c.id));for(const id of checked.keys())if(!ids.has(id))checked.delete(id);
    $('review-comments').replaceChildren();
    $('review-count').textContent=`${list.filter(c=>!c.resolved).length} open`;
    for(const c of list){
      if(!checked.has(c.id))checked.set(c.id,!c.resolved);
      const card=document.createElement('article');card.className=`review-comment${c.resolved?' resolved':''}`;
      const label=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.checked=checked.get(c.id);
      box.addEventListener('change',()=>{checked.set(c.id,box.checked);controls(snapshot);});
      label.append(box,document.createTextNode(c.resolved?' Resolved':' Open'));
      const quote=document.createElement('blockquote');quote.textContent=c.quote;
      const body=document.createElement('p');body.textContent=c.text;
      const actions=document.createElement('div');actions.className='review-actions';
      const locate=document.createElement('button');locate.textContent='Go to text';
      locate.onclick=()=>perform(()=>run('comment-locate',{commentId:c.id}),{focusAfter:true});
      const resolve=document.createElement('button');resolve.textContent=c.resolved?'Reopen':'Resolve';
      resolve.onclick=()=>perform(async current=>{const result=await run('comment-resolve',{commentId:c.id,resolved:!c.resolved});if(current()){checked.set(c.id,c.resolved);lastList='';}return result;});
      actions.append(locate,resolve);card.append(label,quote,body,actions);$('review-comments').append(card);
    }
    controls(next);
  }
  async function perform(work,{focusAfter=false}={}){
    if(busy)return;const version=epoch;operationSerial++;busy=true;$('review-error').textContent='';controls(snapshot);
    try{const result=await work(()=>version===epoch);if(version!==epoch)return;if(result?.ready)render(result);if(focusAfter)focus();changed();return result;}
    catch(error){if(version===epoch)$('review-error').textContent=error.message;}
    finally{if(version===epoch){busy=false;controls(snapshot);}}
  }
  function cancel(){draft=undefined;$('review-text').value='';$('review-draft').hidden=true;controls(snapshot);}
  $('review-toggle').onclick=()=>{panel.hidden=!panel.hidden;$('review-toggle').setAttribute('aria-expanded',String(!panel.hidden));changed();if(!panel.hidden)refresh();};
  for(const operation of ['next','previous','accept','reject'])$(`review-${operation}`).onclick=()=>perform(()=>run(operation,{},snapshot),{focusAfter:true});
  $('review-track').onchange=()=>{const enabled=$('review-track').checked;perform(()=>run('track',{enabled}));};
  $('review-refresh').onclick=()=>refresh();
  $('review-new').onclick=()=>perform(async current=>{
    if(draft && $('review-text').value.trim())throw new Error('Add or cancel the current comment before annotating another place.');
    const next=await read();
    if(!current())return;
    if(!next.hasSelection || selection(next)?.kind!=='document')throw new Error('Select text or a formula first.');
    draft=next;$('review-quote').textContent=next.selection;$('review-draft').hidden=false;$('review-text').focus();return next;
  });
  $('review-submit').onclick=()=>perform(async current=>{
    const text=$('review-text').value;
    if(!text.trim())throw new Error('Enter a comment first.');
    const next=await run('comment-add',{text},draft);if(current())cancel();return next;
  },{focusAfter:true});
  $('review-cancel').onclick=()=>{cancel();focus();};
  $('review-attach').onclick=()=>perform(async current=>{
    const ids=[...checked].filter(([,yes])=>yes).map(([id])=>id);
    const result=await attach(ids);if(!current())return;notice(`${result.count} comments attached to this chat. Your draft is unchanged.`);
    $('review-attach').dataset.contextUpdateId=result.updateId;return read();
  });
  function refresh(){
    if(panel.hidden || busy)return;
    if(refreshing)return refreshing;
    // Polling is observational: it must not flash every control's disabled
    // style, clear an action error, or schedule a burst of active-rate frames.
    const version=epoch,serial=operationSerial;
    const task=(async()=>{
      try{
        const next=await read({passive:true});
        if(version===epoch && serial===operationSerial && next?.ready)render(next);
      }catch(error){
        if(version===epoch && serial===operationSerial)set($('review-error'),'textContent',error.message);
      }
    })();
    refreshing=task;
    void task.finally(()=>{if(refreshing===task)refreshing=undefined;});
    return task;
  }
  return {
    refresh,
    update(next,key){
      if(key!==documentKey){documentKey=key;epoch++;busy=false;refreshing=undefined;snapshot=next;lastList='';checked.clear();cancel();$('review-comments').replaceChildren();$('review-count').textContent='';$('review-error').textContent='';delete $('review-attach').dataset.contextUpdateId;}
      // Lightweight frames must not drop the previously read comment list.
      snapshot={...snapshot,...next,review:{...snapshot?.review,...next?.review}};controls(snapshot);
      if(next?.review?.comments)render(snapshot);
    },
  };
}
