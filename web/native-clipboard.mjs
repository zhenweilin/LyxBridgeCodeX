// Browser clipboard data is synchronous; native copy completes over a socket.
// A broker-held copy ID preserves the exact snapshot even for a rapid copy/paste.
export const nativeClipboardType='application/x-lyx-codex';
export const maxClipboardImageBytes=8*1024*1024;
const encoder=new TextEncoder(),decoder=new TextDecoder();
function encodeBytes(bytes){
  let value='';
  for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(value);
}
export function encodeClipboardText(value){
  return encodeBytes(encoder.encode(value));
}
export function decodeClipboardText(value){return decoder.decode(Uint8Array.from(atob(value),c=>c.charCodeAt(0)));}
export function writeBrowserClipboard(data,{text,copyId,clipboard}){
  data.setData('text/plain',text);
  // The custom payload remains useful after reconnect when a prepared native
  // snapshot is available. Other apps still receive the ordinary text/HTML.
  if(clipboard?.formats?.['text/html'])data.setData('text/html',decodeClipboardText(clipboard.formats['text/html']));
  if(clipboard?.formats?.['application/x-lyx'])data.setData('application/x-lyx',decodeClipboardText(clipboard.formats['application/x-lyx']));
  data.setData(nativeClipboardType,JSON.stringify({version:1,copyId,formats:clipboard?.formats}));
}
export function readBrowserClipboard(data){
  const custom=data.getData(nativeClipboardType);
  if(custom){
    try{
      const value=JSON.parse(custom);
      if(value.version===1 && typeof value.copyId==='string')return {copyId:value.copyId,formats:value.formats};
    }catch{}
  }
  const formats={};
  for(const type of ['application/x-lyx','text/html','text/plain','text/x-tex','application/x-latex']){
    const value=data.getData(type);
    if(value)formats[type]=encodeClipboardText(value);
  }
  return {formats};
}

// Web hosts may retain only desktop LyX's text/HTML. Neither representation
// reliably preserves equations, especially formulas using document macros.
export function externalLyxPasteParams(payload,capabilities){
  if(payload.copyId||payload.formats?.['application/x-lyx']||!payload.formats?.['text/plain'])return payload;
  const html=payload.formats['text/html']?decodeClipboardText(payload.formats['text/html']):'';
  const fromLyx=/\bid\s*=\s*["']magicparlabel-\d+["']/i.test(html)
    || /<meta\b[^>]*\bcontent\s*=\s*["']LyX\s[\d.]+["']/i.test(html);
  if(capabilities?.externalLyxPaste===true)return {...payload,recoverExternalLyx:fromLyx?'required':'prefer'};
  if(fromLyx)throw new Error('This plugin connection cannot preserve formulas copied from desktop LyX yet. Reload the plugin connection and reopen this panel.');
  return payload;
}

// Capture File objects while the browser's real paste event owns access to its
// data. Byte reading happens later inside the already reserved native queue slot.
export function captureBrowserPaste(data){
  const payload=readBrowserClipboard(data);
  // Keep the established native/text paste priority, including exact formula
  // snapshots. Do not turn a rich-text paste into an image-file operation.
  if(payload.copyId || Object.keys(payload.formats??{}).length)return {payload};
  const items=Array.from(data.items??[]).filter(item=>item.kind==='file');
  const files=items.length?items.map(item=>item.getAsFile()):Array.from(data.files??[]);
  if(!files.length)return {payload};
  if(files.length!==1)throw new Error('Paste one PNG or JPEG image at a time.');
  const file=files[0],mimeType=file?.type?.toLowerCase();
  if(!file || !['image/png','image/jpeg'].includes(mimeType))
    throw new Error('Only PNG and JPEG clipboard images are supported.');
  if(!Number.isSafeInteger(file.size) || file.size<=0)
    throw new Error('The clipboard image is empty or invalid.');
  if(file.size>maxClipboardImageBytes)
    throw new Error('The clipboard image exceeds 8 MiB.');
  return {payload,prepare:async()=>{
    const bytes=new Uint8Array(await file.arrayBuffer());
    if(bytes.byteLength!==file.size || bytes.byteLength>maxClipboardImageBytes)
      throw new Error('The clipboard image size changed or exceeds 8 MiB.');
    return {...payload,image:{mimeType,data:encodeBytes(bytes)}};
  }};
}

// Stage a paste inside its existing input-queue slot. Small requests also work
// through older brokers that must stay alive while they own unsaved documents.
export async function stageNativeImagePaste(params,rpc){
  const {image,expectedPath,expectedSelection,expectedSourceRevision}=params;
  const encoded=image.data;
  const size=encoded.length/4*3-(encoded.endsWith('==')?2:encoded.endsWith('=')?1:0);
  let uploadId;
  try{
    const upload=await rpc('clipboard',{action:'image-begin',mimeType:image.mimeType,size,
      expectedPath,expectedSelection,expectedSourceRevision});
    if(typeof upload.uploadId!=='string'||!upload.uploadId||upload.uploadId.length>128)
      throw new Error('The native editor did not start the image transfer.');
    uploadId=upload.uploadId;
    if(!Number.isSafeInteger(upload.maxChunkBytes)||upload.maxChunkBytes<3)
      throw new Error('The native editor returned an invalid image transfer size.');
    const characters=Math.floor(Math.min(upload.maxChunkBytes,196608)/3)*4;
    for(let index=0,offset=0;index<encoded.length;index+=characters){
      const data=encoded.slice(index,index+characters);
      await rpc('clipboard',{action:'image-chunk',uploadId,offset,data});
      offset+=data.length/4*3-(data.endsWith('==')?2:data.endsWith('=')?1:0);
    }
    // The queue sends this final command once. A lost reply must never trigger
    // an automatic retry of a potentially applied native paste.
    return {action:'image-commit',uploadId};
  }catch(error){
    if(uploadId)await rpc('clipboard',{action:'image-cancel',uploadId}).catch(()=>{});
    throw error;
  }
}
