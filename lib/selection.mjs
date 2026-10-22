export function selectionContext(document, blocks, selectedText) {
  if (!blocks.length || !selectedText.trim()) throw new Error('Select text or a formula first.');
  return {
    kind:'lyx-selection',
    file:document.path ?? document.resourceUri ?? document.name,
    revision:document.revision,
    startLine:Math.min(...blocks.map(b=>b.startLine)),
    endLine:Math.max(...blocks.map(b=>b.endLine)),
    selectedText,
    blocks:blocks.map(({id,startLine,endLine,layout,source})=>({id,startLine,endLine,layout,source})),
  };
}

export function contextText(context) {
  return `LyX document selection\nFile: ${context.file}\nSource lines: ${context.startLine}–${context.endLine}\nSHA-256 revision: ${context.revision}\n\nSelected text (formulas preserved as LaTeX):\n${context.selectedText}\n\nCorresponding .lyx source:\n${context.blocks.map(b=>b.source).join('\n\n')}\n\nThe content above was selected by the user. Before editing, verify the current file and revision. Edit the original .lyx file while preserving its structure.`;
}
