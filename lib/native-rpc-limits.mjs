export const ordinaryNativeRequestBytes=1024*1024;
export const imageNativeRequestBytes=12*1024*1024;

// The native layer separately validates the compressed size, decoded image,
// text MIME, and document guards. Only image paste needs a larger transport.
export function nativeRequestBytes(method,params){
  return method==='clipboard' && params?.action==='paste'
    && ['image/png','image/jpeg'].includes(params.image?.mimeType)
    && typeof params.image?.data==='string'
    ? imageNativeRequestBytes : ordinaryNativeRequestBytes;
}
