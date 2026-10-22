// SPDX-License-Identifier: GPL-2.0-or-later
#include <config.h>
#include "CodexSelectionEdit.h"
#include "GuiApplication.h"
#include "GuiView.h"
#include "Buffer.h"
#include "BufferView.h"
#include "Cursor.h"
#include "CutAndPaste.h"
#include "Font.h"
#include "FuncRequest.h"
#include "FuncStatus.h"
#include "Text.h"
#include "Undo.h"
#include "insets/Inset.h"
#include "mathed/InsetMath.h"
#include "mathed/MathData.h"
#include "mathed/MathParser.h"
#include "support/FileName.h"
#include "support/qstring_helpers.h"

#include <QApplication>
#include <QComboBox>
#include <QCryptographicHash>
#include <QFile>
#include <QJsonArray>
#include <QLineEdit>
#include <QPlainTextEdit>
#include <QRegularExpression>
#include <QTextEdit>
#include <sstream>

namespace lyx { namespace frontend {
namespace {
QJsonObject failure(char const * code, char const * message)
{
    return {{"error", true}, {"code", code}, {"message", message}};
}

QJsonArray position(DocIterator const & iterator)
{
    QJsonArray result;
    for (size_t i = 0; i < iterator.depth(); ++i) {
        CursorSlice const & slice = iterator[i];
        result.append(QJsonObject{{"paragraph", double(slice.pit())},
            {"position", double(slice.pos())}, {"cell", double(slice.idx())}});
    }
    return result;
}

QJsonObject selection(Cursor const & cursor)
{
    return {{"kind", "document"}, {"hasSelection", cursor.selection()},
        {"text", cursor.selection() ? toqstr(cursor.selectionAsString(true)) : QString()},
        {"start", position(cursor.selectionBegin())}, {"end", position(cursor.selectionEnd())}};
}

bool source(Buffer const & buffer, QByteArray & bytes, QString & revision)
{
    std::ostringstream stream;
    if (!buffer.write(stream)) return false;
    bytes = QByteArray::fromStdString(stream.str());
    revision = QString::fromLatin1(QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex());
    return true;
}

bool widgetFocus()
{
    QWidget * focus = QApplication::focusWidget();
    if (auto * combo = qobject_cast<QComboBox *>(focus))
        if (combo->isEditable()) return true;
    return qobject_cast<QLineEdit *>(focus) || qobject_cast<QTextEdit *>(focus)
        || qobject_cast<QPlainTextEdit *>(focus);
}

QJsonObject snapshot(BufferView & view)
{
    Buffer & buffer = view.buffer();
    Cursor const & cursor = view.cursor();
    QByteArray bytes;
    QString revision;
    if (!source(buffer, bytes, revision))
        return failure("snapshot_failed", "The native edit completed, but its updated source could not be serialized; read the document before retrying");
    QJsonObject const selected = selection(cursor);
    QJsonObject result{{"ready", true}, {"path", toqstr(buffer.fileName().absFileName())},
        {"modified", !buffer.isClean()},
        {"externalModified", buffer.notifiesExternalModification()
            || (buffer.fileName().exists() && buffer.isChecksumModified())},
        {"hasSelection", cursor.selection()}, {"cursor", position(cursor)},
        {"selection", selected["text"]}, {"selectionStart", selected["start"]},
        {"selectionEnd", selected["end"]}, {"clipboardSelection", selected},
        {"source", QString::fromUtf8(bytes)}, {"sourceRevision", revision},
        {"capabilities", QJsonObject{{"editSelection", true}, {"compositionGuard", true}, {"imagePaste", true}, {"imagePasteChunks", true}, {"wheelInput", true}}}};
    QFile disk(toqstr(buffer.fileName().absFileName()));
    if (disk.open(QIODevice::ReadOnly))
        result["diskRevision"] = QString::fromLatin1(QCryptographicHash::hash(disk.readAll(), QCryptographicHash::Sha256).toHex());
    return result;
}
}

QJsonObject editCodexSelection(GuiApplication * app, QJsonObject const & params)
{
    auto * window = app ? app->currentView() : nullptr;
    auto * view = window ? window->documentBufferView() : nullptr;
    if (!view || QApplication::activeModalWidget() || QApplication::activePopupWidget() || widgetFocus())
        return failure("not_editable", "Focus the native document and close its menus or dialogs before replacing a selection");
    Buffer & buffer = view->buffer();
    Cursor & cursor = view->cursor();
    if (buffer.isReadonly() || !cursor.selection())
        return failure("not_editable", "The native document must be writable and have a nonempty selection");
    FuncStatus const editStatus = app->getStatus(FuncRequest(LFUN_SELF_INSERT, "x"));
    if (!editStatus.enabled())
        return failure("not_editable", "LyX does not allow editing in the current document region");
    if (!params["path"].isString() || params["path"].toString() != toqstr(buffer.fileName().absFileName()))
        return failure("document_mismatch", "The active native document changed; read it again before editing");
    QByteArray before;
    QString beforeRevision;
    if (!source(buffer, before, beforeRevision))
        return failure("snapshot_failed", "The current native document could not be serialized");
    static QRegularExpression const revisionPattern("^[a-f0-9]{64}$");
    if (!params["sourceRevision"].isString()
        || !revisionPattern.match(params["sourceRevision"].toString()).hasMatch()
        || params["sourceRevision"].toString() != beforeRevision)
        return failure("revision_conflict", "The native document has changed; read its latest source before editing");
    if (!params["selection"].isObject() || params["selection"].toObject() != selection(cursor))
        return failure("selection_conflict", "The native selection changed; read the current selection before editing");
    if (!params["replacement"].isObject())
        return failure("invalid_replacement", "A typed replacement object is required");
    QJsonObject const replacement = params["replacement"].toObject();
    if (!replacement["format"].isString() || !replacement["text"].isString()
        || replacement["text"].toString().toUtf8().size() > 512 * 1024)
        return failure("invalid_replacement", "The replacement must contain a format and at most 512 KiB of text");
    QString const format = replacement["format"].toString();
    QString const value = replacement["text"].toString();
    if (value.contains(QChar(0)))
        return failure("invalid_replacement", "NUL characters are not valid replacement text");
    bool const math = format == "math";
    if ((!math && format != "text") || (math && !cursor.inMathed()) || (!math && !cursor.inTexted()))
        return failure("invalid_replacement", "Use text for a text selection or math for a selection inside a formula");
    if (&cursor.selBegin().inset() != &cursor.selEnd().inset()
        || cursor.selBegin().idx() != cursor.selEnd().idx())
        return failure("not_editable", "A replacement cannot span different inset cells");
    if (!math && value.contains('\n') && !cursor.inset().allowMultiPar())
        return failure("invalid_replacement", "This native text inset does not allow multiple paragraphs");
    docstring const text = qstring_to_ucs4(value);
    MathData parsed(&buffer);
    if (math && !mathed_parse_cell(parsed, text, Parse::QUIET | Parse::USETEXT))
        return failure("invalid_replacement", "The replacement is not a valid native LyX math expression");

    // No event loop, clipboard import, or asynchronous dispatch may occur between
    // the checks above and this mutation. All fallible parsing precedes undo.
    cursor.finishUndo();
    {
        UndoGroupHelper group(&buffer);
        if (math) {
            cursor.recordUndoSelection();
            // insert(MathData) replaces the selection literally. niceInsert()
            // would instead move it into a newly inserted fraction or macro.
            cursor.insert(parsed);
        } else {
            Font const font = cursor.current_font;
            cap::replaceSelection(cursor);
            if (!text.empty()) {
                cursor.recordUndo();
                cursor.text()->insertStringAsLines(cursor, text, font);
            }
        }
        cursor.clearSelection();
        cursor.resetAnchor();
        cursor.forceBufferUpdate();
        buffer.updateBuffer();
        cursor.clearBufferUpdate();
        buffer.changed(true);
        view->processUpdateFlags(Update::Force | Update::FitCursor);
        window->restartCaret();
    }
    cursor.finishUndo();
    QJsonObject result = snapshot(*view);
    // Even a serialization failure after mutation must explicitly prohibit a
    // blind retry. It is distinct from every validation failure above.
    result["applied"] = true;
    result["previousSourceRevision"] = beforeRevision;
    return result;
}
}}
