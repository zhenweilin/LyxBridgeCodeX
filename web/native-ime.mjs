// Composition and keyboard ordering:
// https://www.w3.org/TR/uievents/#events-composition-key-events
// https://www.w3.org/TR/input-events-2/#input-event-order-during-composition
// beforeinput may be absent or noncancelable; input is the fallback:
// https://developer.mozilla.org/en-US/docs/Web/API/Element/beforeinput_event
const compositionTypes=new Set(['insertCompositionText','deleteCompositionText']);
const textTypes=new Set(['insertText','insertReplacementText','insertFromComposition']);
const scalarKey=key=>typeof key==='string' && Array.from(key).length===1;
const inputData=event=>typeof event.data==='string'?event.data
  :typeof event.target?.value==='string'?event.target.value:'';
const prevent=event=>{
  if(event.cancelable===false || typeof event.preventDefault!=='function')return false;
  event.preventDefault();
  return true;
};

// emit queues native input synchronously; its queue owns transport errors.
// clear clears the browser textarea only, never the native document.
export function createNativeIme({emit,clear=()=>{},onCompositionChange=()=>{}}){
  if([emit,clear,onCompositionChange].some(callback=>typeof callback!=='function'))
    throw new TypeError('IME callbacks must be functions');
  let composing=false,cancelled=false,preedit,echo,receipt,textKey,textKeyId;
  const nativeKeys=new Set();

  function setComposing(value){
    if(composing===value)return;
    composing=value;
    onCompositionChange(value);
  }
  function key(event){
    const id=event.code || event.key;
    if(event.type==='keyup'){
      if(textKeyId===id)textKey=undefined;
      // A release belongs to native only if its press was forwarded. This also
      // permits a held modifier's release after composition has already begun.
      return nativeKeys.delete(id)?'native':'ignore';
    }
    if(event.type!=='keydown')return 'ignore';
    // A new key is a new intention, even when it produces the same text as the
    // preceding composition. Never use text equality as a lasting dedup rule.
    echo=undefined;receipt=undefined;textKey=undefined;cancelled=false;
    if(composing || event.isComposing || event.keyCode===229
      || ['Process','Dead','Unidentified'].includes(event.key))return 'browser';
    if(event.getModifierState?.('AltGraph'))return 'browser';
    if((event.metaKey || event.ctrlKey) && ['c','x','v'].includes(event.key?.toLowerCase()))return 'browser';
    // Option+printable text and dead keys must reach the macOS input source.
    // Ctrl/Meta shortcuts and nontext keys still use native Qt key events.
    if(scalarKey(event.key) && !event.metaKey && !event.ctrlKey){
      // Wait for confirmed browser text before sending printable keys. This
      // lets the first key start an IME, while preserving LyX's key-sequence
      // lookup for ordinary typing (e.g. Control-P, then Space or a letter).
      // Option/dead-key output and non-BMP text retain the IME commit path.
      if(!event.altKey && event.key.length===1 && event.key.toUpperCase().length===1){
        textKey={text:event.key,key:event.key.toUpperCase().codePointAt(0),
          shift:!!event.shiftKey,repeat:!!event.repeat};
        textKeyId=id;
      }
      return 'browser';
    }
    nativeKeys.add(id);
    return 'native';
  }
  function compositionstart(){
    if(composing)emit({type:'composition',text:''});
    cancelled=false;echo=undefined;receipt=undefined;preedit=undefined;textKey=undefined;
    setComposing(true);
  }
  function preview(event,text){
    const value=typeof text==='string'?text:'';
    const payload={type:'composition',text:value,cursor:value.length};
    const target=event.target,start=target?.selectionStart,end=target?.selectionEnd;
    // compositionupdate can precede the DOM update. Only a textarea consisting
    // exactly of this preedit proves that its UTF-16 selection belongs to it.
    if(target?.value===value && Number.isInteger(start) && Number.isInteger(end)
      && start>=0 && end>=start && end<=value.length){
      payload.cursor=end;
      payload.selection={start,length:end-start};
    }
    const identity=JSON.stringify(payload);
    if(identity!==preedit){preedit=identity;emit(payload);}
  }
  function compositionupdate(event){
    if(cancelled)return false;
    if(!composing)compositionstart();
    preview(event,event.data);
    return true;
  }
  function compositionend(event){
    const text=typeof event.data==='string'?event.data:'';
    if(!composing){
      // A canceled session can still report its final candidate. Record only
      // this explicitly reported echo; never commit it or guess a candidate.
      if(cancelled && text)echo={text};
      return false;
    }
    setComposing(false);preedit=undefined;receipt=undefined;
    if(text){
      echo={text};
      emit({type:'commit',text});
    }else{
      // An empty end cancels the preedit; never insert the last candidate.
      cancelled=true;echo=undefined;
      emit({type:'composition',text:''});
    }
    clear();
    return true;
  }
  function isEcho(event){
    if(!echo)return false;
    const matches=compositionTypes.has(event.inputType)
      || textTypes.has(event.inputType) && inputData(event)===echo.text;
    echo=undefined;
    return matches;
  }
  function emitText(event,text,keyboard=textKey){
    textKey=undefined;
    if(!text)return;
    if(event.inputType==='insertText' && keyboard?.text===text){
      // Supply key identity with the confirmed text. The native engine decides
      // whether a pending key sequence needs it; ordinary text and filename
      // completion must continue through the input-method path.
      emit({type:'commit',...keyboard});
    }else emit({type:'commit',text});
  }
  function beforeinput(event){
    receipt=undefined;
    const staleComposition=cancelled && (event.isComposing || compositionTypes.has(event.inputType));
    if(event.defaultPrevented || staleComposition || !composing && isEcho(event)){
      textKey=undefined;
      prevent(event);
      receipt={type:event.inputType,text:inputData(event),ignore:true};
      if(!composing)clear();
      return true;
    }
    // Emoji pickers, speech and accessibility tools need no keydown. A fresh
    // ordinary input is sufficient to resume after cancellation.
    if(cancelled)cancelled=false;
    if(composing || event.isComposing || compositionTypes.has(event.inputType)){
      if(!composing)compositionstart();
      preview(event,event.inputType==='deleteCompositionText'?'':event.data);
      return true; // Do not interfere with the browser's live composition DOM.
    }
    if(!textTypes.has(event.inputType))return false;
    const text=inputData(event);
    if(prevent(event)){
      receipt={type:event.inputType,text,ignore:true};
      emitText(event,text);
      clear();
    }else{
      receipt={type:event.inputType,text,keyboard:textKey,ignore:false};
      textKey=undefined;
    }
    return true;
  }
  function input(event){
    const previous=receipt;receipt=undefined;
    if(cancelled && (event.isComposing || compositionTypes.has(event.inputType))){clear();return true;}
    if(previous?.ignore && previous.type===event.inputType && previous.text===inputData(event)){
      // A canceled beforeinput normally has no input event. Also tolerate a
      // browser reporting the same DOM update anyway, without a second commit.
      clear();return true;
    }
    if(!composing && isEcho(event)){clear();return true;}
    if(cancelled)cancelled=false;
    if(composing || event.isComposing || compositionTypes.has(event.inputType)){
      if(!composing)compositionstart();
      preview(event,event.inputType==='deleteCompositionText'?'':event.data);
      return true;
    }
    if(!textTypes.has(event.inputType))return false;
    const text=inputData(event) || (previous?.type===event.inputType?previous.text:'');
    emitText(event,text,previous?.keyboard ?? textKey);
    clear();
    return true;
  }
  function cancel(){
    const wasComposing=composing;
    cancelled=true;echo=undefined;receipt=undefined;preedit=undefined;textKey=undefined;
    nativeKeys.clear();
    setComposing(false);
    if(wasComposing)emit({type:'composition',text:''});
    clear();
    return wasComposing;
  }
  return {get composing(){return composing;},key,compositionstart,compositionupdate,compositionend,beforeinput,input,cancel};
}
