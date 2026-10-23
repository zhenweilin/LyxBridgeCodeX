// SPDX-License-Identifier: GPL-2.0-or-later
#include <config.h>
#include "CodexSelectionEdit.h"
#include "CodexReview.h"
#include "Paragraph.h"
#include "GuiApplication.h"
#include "GuiView.h"
#include "Buffer.h"
#include "BufferParams.h"
#include "ColorSet.h"
#include "BufferView.h"
#include "Cursor.h"
#include "CutAndPaste.h"
#include "DispatchResult.h"
#include "Font.h"
#include "FuncRequest.h"
#include "FuncStatus.h"
#include "Text.h"
#include "Undo.h"
#include "insets/Inset.h"
#include "mathed/InsetMath.h"
#include "mathed/InsetMathColor.h"
#include "mathed/MathData.h"
#include "mathed/MathParser.h"
#include "support/FileName.h"
#include "support/qstring_helpers.h"

#include <QApplication>
#include <QComboBox>
#include <QColor>
#include <QCryptographicHash>
#include <QDialog>
#include <QFile>
#include <QElapsedTimer>
#include <QHash>
#include <QMap>
#include <QJsonArray>
#include <QJsonDocument>
#include <QLineEdit>
#include <QPlainTextEdit>
#include <QRegularExpression>
#include <QTextEdit>
#include <QUuid>
#include <sstream>
#include <memory>

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

// A text patch must not flatten formulas, paragraph layouts, formatting runs
// or existing tracked changes. Old engines omit this explicit eligibility flag.
bool plainTextSelection(BufferView const & view)
{
    Cursor const & cursor = view.cursor();
    if (!cursor.selection() || !cursor.inTexted()) return false;
    DocIterator const begin = cursor.selectionBegin(), end = cursor.selectionEnd();
    if (&begin.inset() != &end.inset() || begin.idx() != end.idx()
        || begin.pit() != end.pit()) return false;
    Paragraph const & paragraph = begin.paragraph();
    Font const font = paragraph.getFontSettings(view.buffer().params(), begin.pos());
    if (font != cursor.current_font) return false;
    for (pos_type pos = begin.pos(); pos < end.pos(); ++pos)
        if (paragraph.isInset(pos) || paragraph.lookupChange(pos).changed()
            || paragraph.getFontSettings(view.buffer().params(), pos) != font) return false;
    return true;
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

bool editingBlocked()
{
    if (QApplication::activeModalWidget() || QApplication::activePopupWidget() || widgetFocus()) return true;
    // Modeless dialogs can focus checkboxes or buttons, not only text fields.
    // Do not restore a saved document cursor behind any visible native dialog.
    for (QWidget * widget : QApplication::topLevelWidgets())
        if (widget->isVisible() && qobject_cast<QDialog *>(widget)) return true;
    return false;
}

QJsonObject snapshot(BufferView & view, bool includeSource = true)
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
        {"hasSelection", cursor.selection()}, {"cursor", position(cursor)},
        {"selection", selected["text"]}, {"selectionStart", selected["start"]},
        {"selectionEnd", selected["end"]}, {"clipboardSelection", selected},
        {"sourceRevision", revision},
        {"review", codexReviewState(buffer, includeSource)},
        {"capabilities", QJsonObject{{"review", true}, {"trackedReplacement", true}, {"editSelection", true}, {"compositionGuard", true}, {"selectionSnapshots", true}, {"imagePaste", true}, {"imagePasteChunks", true}, {"wheelInput", true}}}};
    if (includeSource) {
        result["externalModified"] = buffer.notifiesExternalModification()
            || (buffer.fileName().exists() && buffer.isChecksumModified());
        result["source"] = QString::fromUtf8(bytes);
        QFile disk(toqstr(buffer.fileName().absFileName()));
        if (disk.open(QIODevice::ReadOnly))
            result["diskRevision"] = QString::fromLatin1(QCryptographicHash::hash(disk.readAll(), QCryptographicHash::Sha256).toHex());
    }
    return result;
}

// Only native-issued targets enter this bounded process-local store. Stable
// iterators contain no inset pointers. Reconstruct them only after validating
// the exact document revision, and compare the reconstructed range and text.
struct SelectionSnapshot {
    StableDocIterator begin, end;
    QJsonObject selected, receipt;
    QString path, revision;
    QByteArray replacementHash;
    Font currentFont;
    bool reverse = false;
    qint64 created = 0;
};
QHash<QString, SelectionSnapshot> snapshots;
QList<QString> snapshotOrder;
qint64 snapshotTime()
{
    static QElapsedTimer timer;
    if (!timer.isValid()) timer.start();
    return timer.elapsed();
}
void expireSnapshots()
{
    qint64 const now = snapshotTime();
    while (!snapshotOrder.isEmpty()
        && (snapshotOrder.size() >= 32 || now - snapshots.value(snapshotOrder.first()).created > 30 * 60 * 1000))
        snapshots.remove(snapshotOrder.takeFirst());
}

QJsonObject applySelection(GuiApplication * app, QJsonObject const & params,
    bool includeSource, QString const & verifiedRevision = QString())
{
    auto * window = app ? app->currentView() : nullptr;
    auto * view = window ? window->documentBufferView() : nullptr;
    if (!view || editingBlocked())
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
    beforeRevision = verifiedRevision;
    if (beforeRevision.isEmpty() && !source(buffer, before, beforeRevision))
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

    bool const tracked = params["trackChanges"].toBool(false) || buffer.params().track_changes;
    DocIterator formula = cursor.getInnerText();
    std::unique_ptr<Inset> originalFormula;
    if (math && tracked) {
        if (!formula.nextInset() || formula.paragraph().lookupChange(formula.pos()).changed())
            return failure("not_editable", "Accept or reject the existing formula revision before changing it again");
        // LyX tracks formulas as text insets, not individual math atoms. Preserve
        // a complete editable copy before replacing a nested math selection.
        Paragraph copy(formula.paragraph(), formula.pos(), formula.pos() + 1);
        originalFormula.reset(copy.releaseInset(0));
        originalFormula->setBuffer(buffer);
    }

    // No event loop, clipboard import, or asynchronous dispatch may occur between
    // the checks above and this mutation. All fallible parsing precedes undo.
    cursor.finishUndo();
    {
        UndoGroupHelper group(&buffer);
        bool const previousTracking = buffer.params().track_changes;
        if (math && tracked) cursor.recordUndoFullBuffer();
        buffer.params().track_changes = tracked;
        if (math) {
            if (!tracked) cursor.recordUndoSelection();
            // insert(MathData) replaces the selection literally. niceInsert()
            // would instead move it into a newly inserted fraction or macro.
            cursor.insert(parsed);
            if (tracked) {
                Font const font = formula.paragraph().getFontSettings(buffer.params(), formula.pos());
                formula.paragraph().insertInset(formula.pos(), originalFormula.release(), font, Change(Change::DELETED));
                formula.paragraph().setChange(formula.pos() + 1, Change(Change::INSERTED));
                ++cursor[formula.depth() - 1].pos();
            }
        } else {
            Font const font = cursor.current_font;
            cap::replaceSelection(cursor);
            if (!text.empty()) {
                cursor.recordUndo();
                cursor.text()->insertStringAsLines(cursor, text, font);
            }
        }
        buffer.params().track_changes = previousTracking;
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
    QJsonObject result = snapshot(*view, includeSource);
    // Even a serialization failure after mutation must explicitly prohibit a
    // blind retry. It is distinct from every validation failure above.
    result["applied"] = true;
    result["tracked"] = tracked;
    result["previousSourceRevision"] = beforeRevision;
    return result;
}
}

QJsonObject codexDocumentSnapshot(BufferView & view) { return snapshot(view); }

QJsonObject editCodexSelection(GuiApplication * app, QJsonObject const & params)
{
    return applySelection(app, params, true);
}

QJsonObject captureCodexSelection(GuiApplication * app)
{
    auto * window = app ? app->currentView() : nullptr;
    auto * view = window ? window->documentBufferView() : nullptr;
    if (!view || editingBlocked())
        return failure("not_editable", "Select text or a formula in the native document first");
    Cursor const & cursor = view->cursor();
    if (!cursor.selection()) return failure("no_selection", "Select text or a formula in LyX first");
    QJsonObject result = snapshot(*view, false);
    if (result["error"].toBool()) return result;
    result["plainTextSelection"] = plainTextSelection(*view);
    // Long/cross-cell selections remain shareable as context, but cannot acquire
    // an edit target. No cursor change or hidden document mutation is needed.
    if (view->buffer().isReadonly() || result["selection"].toString().size() > 128 * 1024
        || &cursor.selBegin().inset() != &cursor.selEnd().inset()
        || cursor.selBegin().idx() != cursor.selEnd().idx()) return result;
    expireSnapshots();
    QString const id = QUuid::createUuid().toString(QUuid::WithoutBraces);
    SelectionSnapshot target;
    target.begin = cursor.selectionBegin(); target.end = cursor.selectionEnd();
    target.reverse = cursor == cursor.selectionBegin();
    target.currentFont = cursor.current_font;
    target.selected = result["clipboardSelection"].toObject();
    target.path = result["path"].toString(); target.revision = result["sourceRevision"].toString();
    target.created = snapshotTime();
    snapshots.insert(id, target); snapshotOrder.append(id);
    result["snapshotId"] = id;
    result["snapshotTtlSeconds"] = 1800;
    result["selectionFormat"] = cursor.inMathed() ? "math" : "text";
    return result;
}

QJsonObject editCodexSnapshot(GuiApplication * app, QJsonObject const & params)
{
    QString const id = params["snapshotId"].toString();
    auto found = snapshots.find(id);
    if (found == snapshots.end() || snapshotTime() - found->created > 30 * 60 * 1000)
        return failure("snapshot_expired", "This selection snapshot is unavailable or expired; capture a new selection");
    if (!params["replacement"].isObject())
        return failure("invalid_replacement", "A typed replacement object is required");
    QByteArray const replacementHash = QCryptographicHash::hash(
        QJsonDocument(QJsonObject{{"replacement", params["replacement"]}, {"trackChanges", params["trackChanges"].toBool(false)}}).toJson(QJsonDocument::Compact), QCryptographicHash::Sha256);
    if (!found->receipt.isEmpty()) {
        if (found->replacementHash != replacementHash)
            return failure("snapshot_used", "This selection was already edited; capture a new selection for another edit");
        QJsonObject receipt = found->receipt;
        receipt["replayed"] = true;
        return receipt; // Lost replies can be recovered without applying twice.
    }
    auto * window = app ? app->currentView() : nullptr;
    auto * view = window ? window->documentBufferView() : nullptr;
    if (!view || editingBlocked())
        return failure("not_editable", "Close the native menu or dialog before applying the selection edit");
    Buffer & buffer = view->buffer();
    if (found->path != toqstr(buffer.fileName().absFileName()))
        return failure("document_mismatch", "The active document changed; return to the document that supplied this selection");
    QByteArray bytes; QString revision;
    if (!source(buffer, bytes, revision)) return failure("snapshot_failed", "The current document could not be checked");
    if (revision != found->revision)
        return failure("revision_conflict", "The document changed after this selection was shared; capture a fresh selection before editing");
    DocIterator const begin = found->begin.asDocIterator(&buffer), end = found->end.asDocIterator(&buffer);
    if (position(begin) != found->selected["start"].toArray() || position(end) != found->selected["end"].toArray())
        return failure("selection_conflict", "The shared selection can no longer be resolved exactly");
    Cursor & cursor = view->cursor();
    Cursor const previous = cursor;
    cursor.setCursor(found->reverse ? end : begin); cursor.resetAnchor();
    cursor.setCursor(found->reverse ? begin : end); cursor.selection(true);
    cursor.setCurrentFont();
    cursor.current_font = found->currentFont;
    QJsonObject result = applySelection(app, {{"path", found->path}, {"sourceRevision", found->revision},
        {"selection", found->selected}, {"replacement", params["replacement"]}, {"trackChanges", params["trackChanges"]}}, false, revision);
    if (!result["applied"].toBool()) {
        cursor.setCursorData(previous);
        return result;
    }
    result["snapshotId"] = id;
    result["replayed"] = false;
    // Bound both the native reply and its idempotent retry cache.
    QJsonObject receipt;
    for (char const * key : {"applied", "tracked", "path", "modified", "sourceRevision",
        "previousSourceRevision", "snapshotId", "replayed", "error", "code", "message"})
        if (result.contains(key)) receipt[key] = result[key];
    found->replacementHash = replacementHash;
    found->receipt = receipt;
    return receipt;
}
QJsonObject captureCodexColorTarget(GuiApplication * app)
{
    auto * window = app ? app->currentView() : nullptr;
    auto * view = window ? window->documentBufferView() : nullptr;
    if (!view || view->buffer().isReadonly())
        return failure("not_editable", "Focus a writable LyX document first");
    Cursor const & cursor = view->cursor();
    if (cursor.inset().lyxCode() == ERT_CODE)
        return failure("not_editable", "Use LaTeX color commands inside a source block; select ordinary text or a formula for this palette");
    if (cursor.inMathed() && (!cursor.selection()
        || &cursor.selBegin().inset() != &cursor.selEnd().inset()
        || cursor.selBegin().idx() != cursor.selEnd().idx()))
        return failure("not_editable", "Select the formula or a portion within one math cell first");
    return snapshot(*view, false);
}

namespace {
MathData removeMathColors(MathData const & original, Buffer * buffer)
{
    MathData result(buffer);
    for (auto const & atom : original) {
        if (atom->lyxCode() == MATH_COLOR_CODE) {
            result.append(removeMathColors(atom->cell(0), buffer));
        } else {
            MathAtom copy = atom;
            if (auto * nest = copy->asNestInset())
                for (idx_type i = 0; i < nest->nargs(); ++i)
                    nest->cell(i) = removeMathColors(nest->cell(i), buffer);
            result.push_back(copy);
        }
    }
    return result;
}
}

QJsonObject applyCodexColor(GuiApplication * app, QJsonObject const & params)
{
    if (editingBlocked())
        return failure("not_editable", "Close native menus and dialogs before applying a color");
    QJsonObject const target = captureCodexColorTarget(app);
    if (target["error"].toBool()) return target;
    if (params["path"] != target["path"])
        return failure("document_mismatch", "The document changed; select the color again");
    if (params["sourceRevision"] != target["sourceRevision"])
        return failure("revision_conflict", "The document was edited while choosing a color; select the color again");
    if (params["selection"] != target["clipboardSelection"])
        return failure("selection_conflict", "The selection changed; select the color again");
    QString const color = params["color"].toString().toLower();
    bool const reset = color == "default";
    static QRegularExpression const hex("^#[0-9a-f]{6}$");
    if (!reset && !hex.match(color).hasMatch())
        return failure("invalid_color", "Choose a six-digit hex color, such as #B3261E");
    auto * window = app->currentView();
    auto * view = window->documentBufferView();
    Buffer & buffer = view->buffer();
    Cursor & cursor = view->cursor();
    if (!cursor.inMathed() && !app->getStatus(FuncRequest(LFUN_TEXTSTYLE_UPDATE, "color 0 toggleall false")).enabled())
        return failure("not_editable", "LyX does not allow character formatting here");
    // Standard colors avoid adding document definitions. All other colors use
    // LyX 2.5's native custom_colors map, so save/reopen and PDF agree.
    static QMap<QString, std::string> const standard{
        {"#000000", "black"}, {"#ffffff", "white"}, {"#ff0000", "red"},
        {"#00ff00", "green"}, {"#0000ff", "blue"}, {"#ffff00", "yellow"},
        {"#00ffff", "cyan"}, {"#ff00ff", "magenta"}};
    std::string name = standard.value(color);
    bool const custom = !reset && name.empty();
    if (custom) {
        std::string const base = "codexcolor" + color.mid(1).toStdString();
        name = base;
        unsigned suffix = 0;
        while (lcolor.getFromLyXName(name, false) != Color_none
            && lcolor.getX11HexName(lcolor.getFromLyXName(name, false)) != color.toStdString())
            name = base + "x" + std::to_string(++suffix);
    }
    cursor.finishUndo();
    {
        UndoGroupHelper group(&buffer);
        if (custom && !buffer.params().custom_colors.count(name)) {
            cursor.recordUndoBufferParams();
            buffer.params().custom_colors[name] = color.toStdString();
            lcolor.setColor(name, color.toStdString());
            lcolor.setLaTeXName(name, name);
            lcolor.setGUIName(name, name);
        }
        ColorCode const code = reset ? (cursor.inMathed() ? Color_none : Color_inherit)
            : lcolor.getFromLyXName(name);
        if (cursor.inMathed()) {
            // Recoloring must replace selected color wrappers. Simply nesting
            // a new wrapper leaves the old inner color in control.
            DocIterator const begin = cursor.selectionBegin(), end = cursor.selectionEnd();
            MathData const chosen(&buffer, begin.cell().begin() + begin.pos(), end.cell().begin() + end.pos());
            MathAtom colored(new InsetMathColor(&buffer, true, code));
            colored->cell(0) = removeMathColors(chosen, &buffer);
            MathData replacement(&buffer); replacement.push_back(colored);
            cursor.recordUndoSelection();
            cursor.insert(replacement);
            cursor.setCursor(begin); cursor.resetAnchor();
            ++cursor.pos(); cursor.setSelection();
        } else {
            DispatchResult result;
            app->dispatch(FuncRequest(LFUN_TEXTSTYLE_UPDATE,
                "color " + std::to_string(int(code)) + " toggleall false"), result);
        }
        cursor.forceBufferUpdate(); buffer.updateBuffer(); cursor.clearBufferUpdate();
        buffer.changed(true);
        view->processUpdateFlags(Update::Force | Update::FitCursor);
        window->restartCaret();
    }
    cursor.finishUndo();
    QJsonObject result = snapshot(*view, false);
    result["applied"] = true;
    result["color"] = color;
    return result;
}
}}
