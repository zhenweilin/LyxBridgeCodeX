import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions, OpenAIFileEntrypointInputSchema } from '@openai/mcp-extensions/app';
import { selectionContext, contextText } from '../lib/selection.mjs';

const $ = id => document.getElementById(id);
const viewer = $('document');
let current, selection, app, extensions, resourceUri, nativePath, subscribedUri, busy = false, noticeTimer;
const isBrowser = window.parent === window;

function notice(message) { $('notice').textContent=message; clearTimeout(noticeTimer); noticeTimer=setTimeout(()=>{$('notice').textContent='';},6000); }
function setConnection() {
  const available = isBrowser ? typeof document.oai?.annotation?.request === 'function' : !!extensions?.modelContext;
  $('connection').textContent = isBrowser
    ? available ? 'Browser annotations available · Subject to host permissions' : 'Open in the Codex browser to add to this chat'
    : available ? 'Connected to this chat' : 'The host has not provided a chat context interface';
  $('add-context').disabled=!selection || !available;
}
function render(data) {
  if (!data?.html || !Array.isArray(data.blocks)) throw new Error('No valid LyX preview was received.');
  if (current?.revision===data.revision && JSON.stringify(current.dependencies)===JSON.stringify(data.dependencies)) return;
  current={...data,resourceUri};
  viewer.innerHTML=data.html;
  $('filename').textContent=data.name;
  document.title=`${data.name} · LyX Preview`;
  $('sync').textContent='Up to date';
  $('info').textContent=`File: ${data.path ?? resourceUri ?? data.name}\nRevision: ${data.revision}\nSource-mapped paragraphs: ${data.blocks.length}\nLoaded math macros: ${data.macroCount}\n\nUse this view to read and locate content. Codex edits the original LyX file.`;
  $('warnings').replaceChildren(...data.warnings.map(text=>{const p=document.createElement('p');p.textContent=text;return p;}));
  $('warnings').hidden=!data.warnings.length;
  selection=null; $('selection-status').textContent='No selection'; setConnection();
}
function selectedText(range) {
  const fragment=range.cloneContents();
  fragment.querySelectorAll('.math').forEach(el=>el.replaceWith(document.createTextNode(`$${el.dataset.tex}$`)));
  fragment.querySelectorAll('.katex-mathml').forEach(el=>el.remove());
  return fragment.textContent.trim();
}
function captureSelection() {
  if (!current) return;
  const native=window.getSelection();
  if (!native?.rangeCount || native.isCollapsed) { selection=null; setConnection(); $('selection-status').textContent='No selection'; return; }
  const range=native.getRangeAt(0);
  if (!viewer.contains(range.startContainer) || !viewer.contains(range.endContainer)) return;
  const blocks=[...viewer.querySelectorAll('[data-source-block]')].filter(el=>range.intersectsNode(el)).map(el=>current.blocks.find(b=>b.id===el.dataset.sourceBlock)).filter(Boolean);
  const text=selectedText(range);
  if (!text || !blocks.length) return;
  selection={range:range.cloneRange(),context:selectionContext(current,blocks,text)};
  $('selection-status').textContent=`${blocks.length} paragraphs selected · Source lines ${selection.context.startLine}–${selection.context.endLine}`;
  setConnection();
}
document.addEventListener('selectionchange',captureSelection);
$('add-context').addEventListener('pointerdown',event=>event.preventDefault());
$('add-context').addEventListener('click',async()=>{
  if (!selection) return;
  const {range,context}=selection;
  try {
    if (isBrowser) {
      // Text-range annotations ignore metadata. Include the real source location
      // in the editable comment instead; never pretend a clipboard copy is a chat attachment.
      const initialComment=`Please edit the LyX source: ${context.file}\nLines ${context.startLine}–${context.endLine}; revision ${context.revision.slice(0,12)}.`;
      const result=document.oai?.annotation?.request(range,{initialComment:initialComment.slice(0,240)});
      notice(result?.accepted ? 'Annotation requested. Save it to your chat draft and describe the changes you want.' : 'The host did not accept the request. Try clicking it yourself; if it still fails, check annotation permissions or an existing annotation.');
    } else {
      if (!extensions?.modelContext) throw new Error('The host does not support adding chat context.');
      await extensions.modelContext.update({content:[{type:'text',text:contextText(context)}],structuredContent:context});
      notice('Added to this chat context. Describe your changes before sending.');
    }
  } catch(error) { notice(error.message); }
});

async function reload() {
  if (busy) return;
  busy=true;
  try {
    if (isBrowser) {
      const response=await fetch('/document',{cache:'no-store'});
      const data=await response.json(); if (!response.ok) throw new Error(data.error ?? 'Could not read the file'); render(data);
    } else if (resourceUri && extensions?.resources) {
      const resource=await extensions.resources.read({uri:resourceUri,representation:'text'});
      const content=resource.contents[0];
      if (!content || !('text' in content)) throw new Error('The host did not provide LyX source text.');
      const result=await app.callServerTool({name:'render_lyx',arguments:{source:content.text}});
      if (result.isError) throw new Error(result.content?.find(c=>c.type==='text')?.text ?? 'Preview failed');
      render(result.structuredContent);
    } else if (nativePath) {
      const result=await app.callServerTool({name:'open_lyx',arguments:{path:nativePath}});
      if (result.isError) throw new Error('Could not reload the document.'); render(result.structuredContent);
    }
  } catch(error) { $('sync').textContent='Could not read the file'; notice(error.message); }
  finally { busy=false; }
}
$('refresh').addEventListener('click',reload);

if (isBrowser) {
  await reload(); setConnection();
  setInterval(reload,1500);
} else {
  app=new App({name:'LyX Preview',version:'0.1.0'});
  extensions=new OpenAIExtensions(app);
  const applyTheme=()=>{const c=app.getHostContext();if(c?.theme)applyDocumentTheme(c.theme);if(c?.styles?.variables)applyHostStyleVariables(c.styles.variables);};
  app.addEventListener('hostcontextchanged',()=>{applyTheme();setConnection();});
  async function subscribeFile() {
    if (!resourceUri || !extensions.resources || subscribedUri === resourceUri) return;
    if (subscribedUri) {try {await extensions.resources.unsubscribe({uri:subscribedUri});}catch{}}
    try {await extensions.resources.subscribe({uri:resourceUri});subscribedUri=resourceUri;}catch{}
  }
  app.addEventListener('toolinput',async({arguments:args})=>{
    const parsed=OpenAIFileEntrypointInputSchema.safeParse(args);
    if (parsed.success) {resourceUri=parsed.data.file.resourceUri;await reload();await subscribeFile();}
    else if (args?.path) nativePath=args.path;
  });
  app.ontoolresult=result=>{
    if (result.structuredContent?.html) {nativePath=result.structuredContent.path;render(result.structuredContent);}
  };
  await app.connect(); applyTheme(); setConnection();
  extensions.resources?.addUpdateHandler(({params})=>{if(params.uri===resourceUri)reload();});
  if(resourceUri){await reload();await subscribeFile();}
}
