import {build} from 'esbuild';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await mkdir(resolve(root,'dist'),{recursive:true});
const result=await build({entryPoints:[resolve(root,'web/app.mjs')],bundle:true,write:false,format:'esm',target:'es2022',minify:true});
let css=await readFile(resolve(root,'node_modules/katex/dist/katex.min.css'),'utf8');
// The desktop host supports WOFF2. Avoid embedding WOFF and TTF duplicates.
css=css.replace(/src:(url\(fonts\/[^)]+\.woff2\) format\("woff2"\))(?:,[^}]+)?/g,'src:$1');
const fonts=[...new Set([...css.matchAll(/url\((fonts\/[^)]+)\)/g)].map(m=>m[1]))];
for(const font of fonts){const data=await readFile(resolve(root,'node_modules/katex/dist',font));const ext=font.split('.').at(-1);css=css.replaceAll(`url(${font})`,`url(data:font/${ext};base64,${data.toString('base64')})`);}
css+='\n'+await readFile(resolve(root,'web/style.css'),'utf8');
const html=(await readFile(resolve(root,'web/index.html'),'utf8')).replace('/* APP_CSS */',()=>css).replace('/* APP_JS */',()=>result.outputFiles[0].text.replaceAll('</script','<\\/script'));
await writeFile(resolve(root,'dist/viewer.html'),html);
console.log(`Built dist/viewer.html (${Math.round(Buffer.byteLength(html)/1024)} KB)`);
const native = await build({entryPoints:[resolve(root,'web/native-app.mjs')],bundle:true,write:false,format:'esm',target:'es2022',minify:true});
const nativeHtml=(await readFile(resolve(root,'web/native.html'),'utf8')).replace('/* NATIVE_JS */',()=>native.outputFiles[0].text.replaceAll('</script','<\\/script'));
await writeFile(resolve(root,'dist/native.html'),nativeHtml);
console.log(`Built dist/native.html (${Math.round(Buffer.byteLength(nativeHtml)/1024)} KB)`);
