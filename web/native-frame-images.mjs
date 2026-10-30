// Paint onto a persistent canvas without embedding large data URLs in the DOM.
// Each decoded bitmap is closed after drawing; removed canvases release their pixels.
export function createNativeFrameImages({decode=atob,BlobClass=Blob,bitmapFromBlob=createImageBitmap}={}) {
  const current=new Map();
  function remove(canvas) {
    current.delete(canvas);
    canvas.width=canvas.height=0;
  }
  return {
    async update(canvas,png) {
      const previous=current.get(canvas);
      if(previous?.png===png)return;
      const binary=decode(png),bytes=new Uint8Array(binary.length);
      for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
      const next={png};current.set(canvas,next);
      let bitmap;
      try{
        bitmap=await bitmapFromBlob(new BlobClass([bytes],{type:'image/png'}));
        // A document switch or removed dialog invalidates an in-flight decode.
        if(current.get(canvas)!==next)return;
        const context=canvas.getContext('2d');
        if(!context)throw new Error('The host cannot display the native editor canvas');
        if(canvas.width!==bitmap.width)canvas.width=bitmap.width;
        if(canvas.height!==bitmap.height)canvas.height=bitmap.height;
        context.clearRect(0,0,canvas.width,canvas.height);
        context.drawImage(bitmap,0,0);
        if(canvas.dataset && canvas.dataset.frameRenderer!=='bitmap')canvas.dataset.frameRenderer='bitmap';
      }catch(error){
        if(current.get(canvas)===next){
          if(previous)current.set(canvas,previous);else current.delete(canvas);
        }
        throw error;
      }finally{bitmap?.close();}
    },
    remove,
    clear() {for(const canvas of current.keys())remove(canvas);},
  };
}
