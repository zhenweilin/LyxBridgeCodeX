import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import katex from 'katex';

export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const digest = source => createHash('sha256').update(source).digest('hex');

export function parseLyx(source) {
  const lines = source.split(/\r?\n/);
  const body = lines.indexOf('\\begin_body');
  if (body < 0 || !source.includes('\\end_document')) throw new Error('This is not a complete LyX document.');
  const root = {type:'root', children:[], start:body + 1, end:lines.length};
  const stack = [root];
  for (let i = body + 1; i < lines.length; i++) {
    const text = lines[i];
    const open = text.match(/^\\begin_(layout|inset) (.*)$/);
    if (open) {
      const node = {type:open[1], kind:open[2], start:i + 1, end:null, children:[]};
      stack.at(-1).children.push(node); stack.push(node);
    } else if (/^\\end_(layout|inset)$/.test(text)) {
      const type = text.slice(5);
      if (stack.length === 1 || stack.at(-1).type !== type) throw new Error(`Invalid LyX structure at line ${i + 1}.`);
      stack.pop().end = i + 1;
    } else if (text === '\\end_body') break;
    else stack.at(-1).children.push({type:'text', text, start:i + 1, end:i + 1});
  }
  if (stack.length !== 1) throw new Error('A LyX layout or inset is not properly closed.');
  return {root, lines};
}

function* nodes(node) {
  yield node;
  for (const child of node.children ?? []) yield* nodes(child);
}

function rawERT(node) {
  const parts = [];
  for (const layout of node.children.filter(n => n.type === 'layout')) {
    let value = '';
    for (const child of layout.children) {
      if (child.type !== 'text') continue;
      if (child.text === '\\backslash') value += '\\';
      else if (child.text.startsWith('\\')) continue;
      else value += child.text;
    }
    parts.push(value);
  }
  return parts.join('\n');
}

function extractDefinitions(source) {
  return [...source.matchAll(/\\begin_inset FormulaMacro\s*\n([\s\S]*?)\\end_inset/g)].map(m => m[1].trim());
}

async function macroSources(source, path, seen = new Set(), warnings = []) {
  const definitions = extractDefinitions(source);
  const files = [];
  const tree = parseLyx(source);
  for (const node of nodes(tree.root)) {
    if (node.type !== 'inset' || node.kind !== 'CommandInset include') continue;
    const filename = node.children.find(n => n.type === 'text' && n.text.startsWith('filename '))?.text.match(/^filename "(.*)"$/)?.[1];
    if (!filename) continue;
    if (!path) { warnings.push(`Cannot resolve macro file ${filename}: the host did not provide a local document path.`); continue; }
    const full = filename.startsWith('~/') ? resolve(homedir(), filename.slice(2)) : resolve(dirname(path), filename);
    if (!full.endsWith('.lyx')) { warnings.push(`External file is not expanded: ${filename}`); continue; }
    try {
      const canonical = await realpath(full);
      if (seen.has(canonical)) continue;
      if (seen.size >= 16) throw new Error('More than 16 included files');
      seen.add(canonical);
      const buffer = await readFile(canonical);
      if (buffer.length > 4 * 1024 * 1024) throw new Error('The included file exceeds 4 MB');
      const text = buffer.toString('utf8');
      const child = await macroSources(text, canonical, seen, warnings);
      definitions.push(...child.definitions);
      files.push({path:canonical, revision:digest(buffer)}, ...child.files);
      // Includes are treated as macro libraries in this first version.
      const hasProse = child.tree.root.children.some(n => n.type === 'layout' && n.children.some(c => c.type === 'text' && c.text.trim() && !c.text.startsWith('\\')));
      if (hasProse) warnings.push(`Only math macros were loaded from ${filename}; document text is not expanded.`);
    } catch (error) { warnings.push(`Macro file ${filename}: ${error.message}`); }
  }
  return {definitions, files, tree};
}

export async function renderLyx(source, path = null) {
  if (Buffer.byteLength(source) > 4 * 1024 * 1024) throw new Error('The preview supports LyX files up to 4 MB.');
  const warnings = [];
  const {definitions, files, tree} = await macroSources(source, path, new Set(path ? [path] : []), warnings);
  const macros = {};
  let macroCount = 0;
  for (const definition of definitions) {
    try {
      katex.renderToString(definition, {macros, globalGroup:true, throwOnError:true, trust:false, maxExpand:1000, strict:'ignore'});
      macroCount++;
    } catch { /* Unused unsupported macros must not prevent reading the document. */ }
  }
  const blocks = [];
  const counts = {};
  let title = path?.split('/').at(-1) ?? 'LyX document';
  function math(tex, display = false) {
    try {
      const html = katex.renderToString(tex, {macros:{...macros}, displayMode:display, throwOnError:true, trust:false, maxExpand:1000, strict:'ignore'});
      return `<span class="math${display ? ' math-display' : ''}" data-tex="${escapeHtml(tex)}" data-display="${display}" title="${escapeHtml(tex)}">${html}</span>`;
    } catch (error) {
      warnings.push(`Formula could not be fully rendered: ${tex.slice(0,120)}`);
      return `<code class="unsupported" title="${escapeHtml(error.message)}">${escapeHtml(tex)}</code>`;
    }
  }
  function latex(text) {
    // ERT remains data: only math delimiters and common text wrappers are rendered.
    text = text.replace(/(?<!\\)%[^\n]*/g, '').replace(/~/g, '\u00a0');
    const pattern = /(\$\$[\s\S]*?\$\$|(?<!\\)\$(?:\\.|[^$])*?\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\))/g;
    let html = '', start = 0;
    for (const match of text.matchAll(pattern)) {
      html += escapeHtml(text.slice(start,match.index));
      const token = match[0], display = token.startsWith('$$') || token.startsWith('\\[');
      const cut = token.startsWith('$$') || token.startsWith('\\') ? 2 : 1;
      html += math(token.slice(cut,-cut), display); start = match.index + token.length;
    }
    html += escapeHtml(text.slice(start));
    return html;
  }
  function inline(node) {
    if (node.type === 'text') {
      if (!node.text) return '';
      if (node.text === '\\backslash') return '\\';
      if (node.text.startsWith('\\')) return '';
      return escapeHtml(node.text);
    }
    if (node.type === 'layout') return node.children.map(inline).join('');
    if (node.type !== 'inset') return '';
    if (node.kind.startsWith('Note ') || node.kind === 'FormulaMacro' || node.kind === 'CommandInset include') return '';
    if (node.kind === 'ERT') return latex(rawERT(node));
    if (node.kind.startsWith('Formula ')) {
      const tex = [node.kind.slice(8), ...node.children.filter(n => n.type === 'text').map(n => n.text)].join('\n').trim();
      if (/^(\$|\\\[|\\\()/.test(tex)) return latex(tex);
      return math(tex, true);
    }
    if (node.kind.startsWith('Quotes ')) return node.kind.includes('l') ? '“' : '”';
    if (node.kind.startsWith('space ')) return '&nbsp;';
    if (node.kind.startsWith('Newline')) return '<br>';
    if (node.kind === 'CommandInset label') return '';
    if (node.kind.startsWith('CommandInset ref')) {
      const reference = node.children.find(n=>n.type==='text' && n.text.startsWith('reference '))?.text ?? 'Cross-reference';
      return `<span class="reference">[${escapeHtml(reference.replace(/^reference /,''))}]</span>`;
    }
    warnings.push(`${node.kind} at line ${node.start} is not fully supported; a placeholder is shown.`);
    return `<span class="unsupported">[${escapeHtml(node.kind)}]</span>`;
  }
  const theoremNames = {Definition:'Definition', Theorem:'Theorem', Lemma:'Lemma', Proposition:'Proposition', Corollary:'Corollary', Assumption:'Assumption', Remark:'Remark', Example:'Example', Proof:'Proof'};
  let html = '';
  for (const node of tree.root.children) {
    if (node.type !== 'layout') continue;
    const content = node.children.map(inline).join('');
    if (!content.trim()) continue;
    const id = `lyx-line-${node.start}`;
    const block = {id, path, startLine:node.start, endLine:node.end, layout:node.kind, source:tree.lines.slice(node.start-1,node.end).join('\n')};
    blocks.push(block);
    const attrs = `id="${id}" data-source-block="${id}" data-start-line="${node.start}" data-end-line="${node.end}"`;
    const kind = node.kind.replace(/\*$/, '');
    if (kind === 'Title') { title = content.replace(/<[^>]*>/g,''); html += `<h1 class="doc-title" ${attrs}>${content}</h1>`; }
    else if (kind === 'Author') html += `<p class="doc-author" ${attrs}>${content}</p>`;
    else if (['Section','Subsection','Subsubsection'].includes(kind)) {
      const level = ['Section','Subsection','Subsubsection'].indexOf(kind)+2;
      const number = node.kind.endsWith('*') ? '' : `${counts[kind] = (counts[kind] ?? 0)+1} `;
      html += `<h${level} ${attrs}>${number}${content}</h${level}>`;
    } else if (theoremNames[kind]) {
      const number = kind === 'Proof' || node.kind.endsWith('*') ? '' : ` ${counts[kind] = (counts[kind] ?? 0)+1}`;
      html += `<div class="theorem" ${attrs}><strong>${theoremNames[kind]}${number}.</strong> ${content}</div>`;
    } else if (['Standard','Plain Layout','Abstract','Paragraph','Date','Itemize','Enumerate'].includes(kind)) {
      html += `<p ${attrs}>${kind === 'Itemize' ? '• ' : ''}${content}</p>`;
    } else {
      warnings.push(`Layout ${kind} is displayed as a paragraph.`);
      html += `<p ${attrs}>${content}</p>`;
    }
  }
  return {path, name:path?.split('/').at(-1) ?? 'document.lyx', title, revision:digest(source), html, blocks, warnings:[...new Set(warnings)], macroCount, dependencies:files};
}

export async function renderFile(path) {
  if (!path.endsWith('.lyx')) throw new Error('Select a .lyx file.');
  const canonical = await realpath(path);
  return renderLyx(await readFile(canonical,'utf8'), canonical);
}
