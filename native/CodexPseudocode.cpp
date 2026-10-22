// SPDX-License-Identifier: GPL-2.0-or-later
// Standard LyX Preview + ERT insets retain literal LaTeX in the saved document.
#include <config.h>
#include "CodexPseudocode.h"
#include "GuiApplication.h"
#include "GuiView.h"
#include "Buffer.h"
#include "BufferParams.h"
#include "BufferView.h"
#include "Cursor.h"
#include "DispatchResult.h"
#include "FuncRequest.h"
#include "FuncStatus.h"
#include "LyXRC.h"
#include "Text.h"
#include "Undo.h"
#include "insets/Inset.h"
#include "support/qstring_helpers.h"
#include <QApplication>
#include <QMap>
#include <QRegularExpression>

namespace lyx { namespace frontend {
namespace {
QMap<QString, QString> const & templates()
{
    static QMap<QString, QString> const values{
        {"LaTeX Pseudocode", "\\Require Initial data\n\\Ensure Result\n\\State $x\\gets 0$\n\\While{$x<10$}\n  \\State $x\\gets x+1$\n\\EndWhile\n\\State \\Return $x$"},
        {"LaTeX While", "\\While{$x<10$}\n  \\State $x\\gets x+1$\n\\EndWhile"},
        {"LaTeX For", "\\For{$i=1,\\ldots,n$}\n  \\State $x_i\\gets 0$\n\\EndFor"},
        {"LaTeX For All", "\\ForAll{$x\\in S$}\n  \\State $y\\gets f(x)$\n\\EndFor"},
        {"LaTeX If / Else", "\\If{$x>0$}\n  \\State $x\\gets 1$\n\\Else\n  \\State $x\\gets 0$\n\\EndIf"},
        {"LaTeX Repeat / Until", "\\Repeat\n  \\State $x\\gets x+1$\n\\Until{$x\\geq 10$}"},
        {"LaTeX Function", "\\Function{Example}{$x$}\n  \\State \\Return $x$\n\\EndFunction"},
        {"LaTeX Procedure", "\\Procedure{Example}{$x$}\n  \\State $y\\gets x$\n\\EndProcedure"},
        {"LaTeX State", "\\State $x\\gets 0$"},
        {"LaTeX Return", "\\State \\Return $x$"},
        {"LaTeX Comment", "\\Comment{Explanation}"},
        {"LaTeX Input / Output", "\\Require Initial data\n\\Ensure Result"}
    };
    return values;
}

bool inPreview(Cursor const & cursor)
{
    for (size_t i = 0; i < cursor.depth(); ++i)
        if (cursor[i].inset().lyxCode() == PREVIEW_CODE) return true;
    return false;
}
}

bool codexPseudocodeSource(BufferView const * view)
{
    return view && view->cursor().inTexted()
        && view->cursor().inset().lyxCode() == ERT_CODE && inPreview(view->cursor());
}

QStringList codexPseudocodeEntries(BufferView const * view)
{
    if (qEnvironmentVariableIsEmpty("LYX_CODEX_SOCKET") || !view
        || !view->cursor().inTexted()) return {};
    // A raw-code inset cannot contain another Preview inset.
    if (view->cursor().inset().lyxCode() == ERT_CODE && !codexPseudocodeSource(view)) return {};
    QStringList entries = templates().keys();
    entries.removeAll("LaTeX Pseudocode");
    entries.prepend("LaTeX Pseudocode");
    if (inPreview(view->cursor())) entries.prepend("Render LaTeX Pseudocode");
    return entries;
}

bool dispatchCodexPseudocode(GuiApplication * app, FuncRequest const & request, DispatchResult & result)
{
    if (qEnvironmentVariableIsEmpty("LYX_CODEX_SOCKET") || request.action() != LFUN_LAYOUT) return false;
    QString const name = toqstr(request.argument());
    bool const render = name == "Render LaTeX Pseudocode";
    if (!render && !templates().contains(name)) return false;
    auto * window = app->currentView();
    auto * view = window ? window->documentBufferView() : nullptr;
    auto fail = [&](char const * message) {
        result.setError(true); result.setMessage(std::string(message)); result.dispatched(false);
        return true;
    };
    if (!view || view->buffer().isReadonly() || !view->cursor().inTexted()
        || QApplication::activeModalWidget()) return fail("Focus an editable document paragraph first.");
    Cursor & cursor = view->cursor();
    auto command = [&](FuncCode code) {
        DispatchResult status;
        app->dispatch(FuncRequest(code), status);
        // A following inset command can query the new inset's coordinates.
        // Recompute metrics before dispatching it, without pumping input events.
        if (!status.error()) view->processUpdateFlags(Update::Force | Update::FitCursor);
        return !status.error();
    };
    if (render) {
        if (!inPreview(cursor)) return fail("The cursor is not inside a LaTeX preview block.");
        // Normal LyX navigation notifies the preview loader when leaving it.
        for (int i = 0; i < 8 && inPreview(cursor); ++i) {
            if (!command(LFUN_INSET_END) || !command(LFUN_CHAR_FORWARD))
                return fail("Could not leave the source block; click outside it to render.");
        }
        if (inPreview(cursor)) return fail("Could not leave the source block; click outside it to render.");
        result.dispatched(true); return true;
    }
    bool const insertSource = codexPseudocodeSource(view);
    if (cursor.selection()) return fail("Place the cursor where the template should be inserted first.");
    if (!insertSource && (!app->getStatus(FuncRequest(LFUN_PREVIEW_INSERT)).enabled()
        || cursor.selection() || inPreview(cursor)))
        return fail("Place the cursor in a paragraph to create a block, or inside its LaTeX source to insert a template.");

    Buffer & buffer = view->buffer();
    QString const preamble = toqstr(buffer.params().preamble);
    QRegularExpression const packages(R"(\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:algpseudocodex|algpseudocode)\b[^}]*\})");
    bool const addPackage = !packages.match(preamble).hasMatch();
    if (addPackage && QRegularExpression(R"(\\usepackage(?:\[[^\]]*\])?\{[^}]*\balgorithmic\b[^}]*\})").match(preamble).hasMatch())
        return fail("This document uses the legacy algorithmic package; use algpseudocode or algpseudocodex for these templates.");
    QString text = templates().value(name);
    cursor.finishUndo();
    {
        UndoGroupHelper group(&buffer);
        if (addPackage) {
            cursor.recordUndoBufferParams();
            buffer.params().preamble += from_ascii("\n% Native LaTeX pseudocode previews\n\\usepackage[noEnd=false]{algpseudocodex}\n");
        }
        if (!insertSource) {
            if (!command(LFUN_PREVIEW_INSERT) || !command(LFUN_ERT_INSERT))
                return fail("Could not create the native LaTeX preview block.");
            if (name == "LaTeX Comment") text.prepend("\\State ");
            text = "\\begin{minipage}{\\linewidth}\n\\begin{algorithmic}[1]\n"
                + text + "\n\\end{algorithmic}\n\\end{minipage}";
        } else {
            // Source indentation is cosmetic; LaTeX computes the rendered block
            // indentation. Keep templates on their own source lines.
            if (cursor.pos() != 0) text.prepend('\n');
            if (cursor.pos() != cursor.lastpos()) text.append('\n');
        }
        cursor.recordUndo();
        cursor.text()->insertStringAsLines(cursor, qstring_to_ucs4(text), cursor.current_font);
        cursor.clearSelection(); cursor.resetAnchor();
        cursor.forceBufferUpdate(); buffer.updateBuffer(); cursor.clearBufferUpdate();
        buffer.changed(true);
        view->processUpdateFlags(Update::Force | Update::FitCursor);
        window->restartCaret();
    }
    cursor.finishUndo();
    result.dispatched(true);
    result.setMessage(std::string("Edit the LaTeX source; click outside the block or choose Render LaTeX Pseudocode to preview."));
    return true;
}
}}
