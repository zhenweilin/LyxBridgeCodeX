// SPDX-License-Identifier: GPL-2.0-or-later
import {readFile,writeFile,copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export async function patchSourceLabels(root,source){
  for(const file of ['CodexLatexLabels.h','CodexSourceLabels.inc'])
    await copyFile(resolve(root,'native',file),resolve(source,'src/insets',file));
  async function patch(path,marker,apply){
    const file=resolve(source,'src',path),before=await readFile(file,'utf8');
    if(before.includes(marker))return;
    const after=apply(before);
    if(after===before||!after.includes(marker))throw new Error(`Source-label patch anchor changed: ${path}`);
    await writeFile(file,after);
  }
  await patch('insets/InsetERT.h','// Codex: literal LaTeX label index.',s=>s.replace('private:',`\t// Codex: literal LaTeX label index.
\tvoid updateBuffer(ParIterator const &, UpdateType, bool deleted = false) override;
\tvoid addToToc(DocIterator const &, bool, UpdateType, TocBackend &) const override;
private:`));
  await patch('insets/InsetERT.cpp','#include "CodexSourceLabels.inc"',s=>s+'\n#include "CodexSourceLabels.inc"\n');
  await patch('insets/InsetERT.cpp','// Codex: source edits may change label targets.',s=>s
    .replace('#include "Cursor.h"','#include "Cursor.h"\n#include "LyXAction.h"')
    .replace('void InsetERT::doDispatch(Cursor & cur, FuncRequest & cmd)\n{',`void InsetERT::doDispatch(Cursor & cur, FuncRequest & cmd)
{
\t// Codex: source edits may change label targets.
\tif (!lyxaction.funcHasFlag(cmd.action(), LyXAction::ReadOnly))
\t\tcur.forceBufferUpdate();`));
  await patch('Buffer.h','bool hasLabel(docstring const & label) const;',s=>s.replace(
    '\tbool activeLabel(docstring const & label) const;',
    '\tbool activeLabel(docstring const & label) const;\n\t/// Includes literal labels indexed from ERT, which have no InsetLabel.\n\tbool hasLabel(docstring const & label) const;'));
  await patch('Buffer.cpp','bool Buffer::hasLabel(docstring const & label) const',s=>s.replace(
    '\treturn insetLabel(label, true) != nullptr;',`\tfor (auto const & entry : masterBuffer()->d->label_cache_)
\t\tif (entry.label == label && entry.active) return true;
\treturn false;
}


bool Buffer::hasLabel(docstring const & label) const
{
\tfor (auto const & entry : masterBuffer()->d->label_cache_)
\t\tif (entry.label == label) return true;
\treturn false;`));
  await patch('insets/InsetRef.cpp','buffer().hasLabel(label)',s=>s
    .replaceAll('buffer().insetLabel(label)', 'buffer().hasLabel(label)')
    .replaceAll('buf->insetLabel(label)', 'buf->hasLabel(label)'));
}
