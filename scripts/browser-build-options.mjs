// ext-apps 1.7.5 logs complete postMessage payloads at debug level, including
// every native PNG frame. Developer consoles/host log collectors can retain
// those objects. Remove debug calls at build time without replacing console or
// dropping warnings, errors, protocol validation or message delivery.
export const browserBuildOptions={
  bundle:true,write:false,format:'esm',target:'es2022',minify:true,
  pure:['console.debug'],
};
