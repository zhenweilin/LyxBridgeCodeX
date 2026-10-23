// SPDX-License-Identifier: GPL-2.0-or-later
// Included by InsetERT.cpp. Index metadata only: never emit or insert labels.
#include "CodexLatexLabels.h"
#include "Buffer.h"
#include "ParIterator.h"
#include "TocBackend.h"
#include "InsetRef.h"
#include "mathed/InsetMathRef.h"

namespace lyx {
namespace {
struct SourceLabel { docstring name; pit_type paragraph; pos_type position; };
std::vector<SourceLabel> sourceLabels(InsetERT const & inset)
{
    docstring text;
    std::vector<std::pair<pit_type, pos_type>> positions;
    for (pit_type p = 0; p < pit_type(inset.paragraphs().size()); ++p) {
        Paragraph const & par = inset.paragraphs()[p];
        for (pos_type i = 0; i < par.size(); ++i) {
            text.push_back(par.isDeleted(i) || par.isInset(i) ? char_type(' ') : par.getChar(i));
            positions.emplace_back(p, i);
        }
        text += '\n'; positions.emplace_back(p, par.size());
    }
    std::vector<SourceLabel> result;
    for (auto const & label : codex::latexLabels(text)) {
        auto const & at = positions[label.offset];
        result.push_back({label.name, at.first, at.second});
    }
    return result;
}
}

void InsetERT::updateBuffer(ParIterator const & it, UpdateType type, bool deleted)
{
    InsetCollapsible::updateBuffer(it, type, deleted);
    bool active = !deleted && producesOutput();
    for (size_t i = 0; active && i < it.depth(); ++i)
        active = !it[i].paragraph().isDeleted(it[i].pos()) && it[i].inset().producesOutput();
    for (auto const & label : sourceLabels(*this))
        buffer().setInsetLabel(label.name, nullptr, active);
}

void InsetERT::addToToc(DocIterator const & it, bool active, UpdateType type, TocBackend & backend) const
{
    InsetCollapsible::addToToc(it, active, type, backend);
    auto toc = backend.toc("label");
    for (auto const & label : sourceLabels(*this)) {
        DocIterator at = it;
        at.push_back(CursorSlice(const_cast<InsetERT &>(*this)));
        at.pit() = label.paragraph; at.pos() = label.position;
        // Existing native labels keep their own target. Duplicates remain
        // visible in the outline; source is never rewritten to conceal them.
        bool duplicate = buffer().insetLabel(label.name, true) != nullptr;
        for (auto const & item : *toc)
            duplicate |= item.depth() == 0 && item.str() == label.name && !item.isMissing();
        docstring display = duplicate ? from_ascii("DUPLICATE: ") + label.name : label.name;
        toc->emplace_back(at, 0, display, active && !duplicate);
        toc->back().prettyStr(from_ascii("LaTeX source"));
        if (!duplicate) for (auto const & ref : buffer().references(label.name)) {
            docstring const displayRef = ref.first->lyxCode() == MATH_REF_CODE
                ? ref.first->asInsetMath()->asRefInset()->screenLabel()
                : static_cast<InsetRef *>(ref.first)->getTOCString();
            toc->emplace_back(DocIterator(ref.second), 1, displayRef, active);
        }
    }
}
}
