// SPDX-License-Identifier: GPL-2.0-or-later
#include <config.h>
#include "CodexReview.h"
#include "CodexSelectionEdit.h"
#include "GuiApplication.h"
#include "GuiView.h"
#include "Buffer.h"
#include "BufferParams.h"
#include "BufferView.h"
#include "Cursor.h"
#include "DispatchResult.h"
#include "DocIterator.h"
#include "Font.h"
#include "FuncRequest.h"
#include "FuncStatus.h"
#include "Paragraph.h"
#include "Text.h"
#include "Undo.h"
#include "insets/InsetNote.h"
#include "support/qstring_helpers.h"
#include <QApplication>
#include <QDialog>
#include <QJsonArray>
#include <QLineEdit>
#include <QPlainTextEdit>
#include <QTextEdit>
#include <QRegularExpression>
#include <QUuid>
#include <memory>

namespace lyx { namespace frontend {
namespace {
QJsonObject failure(char const * code, char const * message) {
    return {{"error", true}, {"code", code}, {"applied", false}, {"message", message}};
}
QJsonArray position(DocIterator const & it) {
    QJsonArray a;
    for (size_t i = 0; i < it.depth(); ++i)
        a.append(QJsonObject{{"paragraph", double(it[i].pit())}, {"position", double(it[i].pos())}, {"cell", double(it[i].idx())}});
    return a;
}
QJsonObject comment(InsetNote * note, DocIterator const & it) {
    if (!note || note->params().type != InsetNoteParams::Note || note->paragraphs().size() < 3) return {};
    static QRegularExpression const header("^\\[Codex comment ([a-f0-9-]{36}) (open|resolved)\\]$");
    auto const match = header.match(toqstr(note->paragraphs()[0].asString()));
    if (!match.hasMatch()) return {};
    QStringList body;
    for (pit_type p = 2; p < pit_type(note->paragraphs().size()); ++p)
        body.append(toqstr(note->paragraphs()[p].asString()));
    return {{"id", match.captured(1)}, {"resolved", match.captured(2) == "resolved"},
        {"quote", toqstr(note->paragraphs()[1].asString())}, {"text", body.join('\n')}, {"anchor", position(it)}};
}
void fillParagraph(Paragraph & par, QString const & value, Font const & font) {
    par.eraseChars(0, par.size(), false);
    for (char_type ch : qstring_to_ucs4(value)) par.insertChar(par.size(), ch, font, Change());
}
void fillNote(InsetNote & note, QString const & id, QString quote, QString const & body, Font const & font) {
    quote.replace('\n', ' '); quote.replace('\r', ' ');
    QStringList lines{QString("[Codex comment %1 open]").arg(id), quote};
    lines.append(body.split('\n'));
    auto & pars = note.paragraphs();
    for (int i = 0; i < lines.size(); ++i) {
        if (i) pars.push_back(Paragraph(pars.front(), 0, 0));
        fillParagraph(pars.back(), lines[i], font);
    }
}
}

QJsonObject codexReviewState(Buffer & buffer, bool includeComments) {
    QJsonObject result{{"tracking", buffer.params().track_changes}};
    if (includeComments) {
        QJsonArray comments;
        for (DocIterator it = doc_iterator_begin(&buffer); it; it.forwardInset()) {
            if (!it.inTexted() || it.pos() >= it.lastpos() || it.paragraph().isDeleted(it.pos())) continue;
            QJsonObject item = comment(dynamic_cast<InsetNote *>(it.nextInset()), it);
            if (!item.isEmpty()) comments.append(item);
        }
        result["comments"] = comments;
        result["hasChanges"] = buffer.areChangesPresent();
    }
    return result;
}

QJsonObject reviewCodexDocument(GuiApplication * app, QJsonObject const & p) {
    auto * window = app ? app->currentView() : nullptr;
    auto * view = window ? window->documentBufferView() : nullptr;
    if (!view) return failure("not_editable", "Open a native document first");
    QString const operation = p["operation"].toString();
    if (operation == "list") return codexDocumentSnapshot(*view);
    QWidget * focus = QApplication::focusWidget();
    if (QApplication::activeModalWidget() || QApplication::activePopupWidget()
        || qobject_cast<QLineEdit *>(focus) || qobject_cast<QTextEdit *>(focus) || qobject_cast<QPlainTextEdit *>(focus))
        return failure("not_editable", "Close native menus and dialogs before reviewing");
    for (QWidget * widget : QApplication::topLevelWidgets())
        if (widget->isVisible() && qobject_cast<QDialog *>(widget))
            return failure("not_editable", "Close native menus and dialogs before reviewing");
    Buffer & buffer = view->buffer(); Cursor & cursor = view->cursor();
    QJsonObject const before = codexDocumentSnapshot(*view);
    if (before["error"].toBool()) return before;
    if (!p["path"].isString() || p["path"] != before["path"])
        return failure("document_mismatch", "The active document changed; refresh review first");
    if (!p["sourceRevision"].isString() || p["sourceRevision"] != before["sourceRevision"])
        return failure("revision_conflict", "The document changed; refresh review before trying again");
    bool const navigation = operation == "next" || operation == "previous" || operation == "comment-locate";
    if (!navigation && buffer.isReadonly()) return failure("not_editable", "The document is read-only");
    if (operation == "comment-add" || operation == "accept" || operation == "reject") {
        if (!p["selection"].isObject() || p["selection"] != before["clipboardSelection"])
            return failure("selection_conflict", "The selection changed; select the intended content again");
    }

    DocIterator anchor;
    InsetNote * target = nullptr;
    if (operation == "comment-locate" || operation == "comment-resolve") {
        int matches = 0;
        for (DocIterator it = doc_iterator_begin(&buffer); it; it.forwardInset()) {
            if (!it.inTexted() || it.pos() >= it.lastpos() || it.paragraph().isDeleted(it.pos())) continue;
            auto * note = dynamic_cast<InsetNote *>(it.nextInset());
            auto const item = comment(note, it);
            if (!item.isEmpty() && item["id"] == p["commentId"]) { target = note; anchor = it; ++matches; }
        }
        if (matches != 1) return failure("not_editable", "The comment is missing or duplicated; refresh and check its native note");
        if (operation == "comment-resolve" && !p["resolved"].isBool())
            return failure("invalid_replacement", "A resolved state is required");
    }
    if (operation == "comment-add") {
        QString const text = p["text"].toString();
        if (!p["text"].isString() || text.trimmed().isEmpty() || text.contains(QChar(0)) || text.size() > 16000)
            return failure("invalid_replacement", "Enter a comment of at most 16000 characters");
        if (!cursor.selection()) return failure("not_editable", "Select text or a formula to annotate");
        anchor = cursor.selectionEnd();
        if (anchor.inMathed()) { anchor = anchor.getInnerText(); ++anchor.pos(); }
        if (!anchor.inTexted() || !anchor.inset().insetAllowed(NOTE_CODE))
            return failure("not_editable", "This document region does not allow a native note");
    }
    FuncCode code = LFUN_NOACTION;
    if (operation == "next") code = LFUN_CHANGE_NEXT;
    else if (operation == "previous") code = LFUN_CHANGE_PREVIOUS;
    else if (operation == "accept") code = LFUN_CHANGE_ACCEPT;
    else if (operation == "reject") code = LFUN_CHANGE_REJECT;
    else if (operation == "track") {
        if (!p["enabled"].isBool()) return failure("invalid_replacement", "A tracking state is required");
        code = LFUN_CHANGES_TRACK;
    } else if (operation != "comment-add" && operation != "comment-locate" && operation != "comment-resolve")
        return failure("invalid_replacement", "Unknown review operation");
    if (code != LFUN_NOACTION && !app->getStatus(FuncRequest(code)).enabled())
        return failure("not_editable", "This review action is not available at the current selection");

    cursor.finishUndo();
    bool mutated = false;
    {
        UndoGroupHelper group(&buffer);
        if (operation == "comment-add") {
            auto note = std::make_unique<InsetNote>(&buffer, "Note");
            QString const id = QUuid::createUuid().toString(QUuid::WithoutBraces);
            fillNote(*note, id, before["selection"].toString(), p["text"].toString(), cursor.current_font);
            note->setStatus(cursor, InsetCollapsible::Collapsed);
            cursor.recordUndoFullBuffer();
            cursor.clearSelection(); cursor.setCursor(anchor); cursor.resetAnchor();
            // Review metadata is independent of text revisions and omitted from PDF output.
            cursor.paragraph().insertInset(cursor.pos(), note.release(), cursor.current_font, Change());
            mutated = true;
        } else if (target) {
            if (operation == "comment-resolve") {
                cursor.recordUndoFullBuffer();
                fillParagraph(target->paragraphs()[0], QString("[Codex comment %1 %2]").arg(
                    p["commentId"].toString(), p["resolved"].toBool() ? "resolved" : "open"), cursor.current_font);
                mutated = true;
            }
            cursor.clearSelection(); cursor.setCursor(anchor); cursor.resetAnchor();
            if (operation == "comment-locate") {
                docstring const quote = qstring_to_ucs4(comment(target, anchor)["quote"].toString());
                pos_type const length = pos_type(quote.size());
                if (length > 0 && anchor.pos() >= length
                    && anchor.paragraph().asString(anchor.pos() - length, anchor.pos()) == quote) {
                    DocIterator begin = anchor; begin.pos() -= length;
                    cursor.setSelection(begin, length);
                } else if (anchor.pos() > 0 && anchor.prevInset() && anchor.prevInset()->lyxCode() == MATH_HULL_CODE) {
                    DocIterator begin = anchor; --begin.pos(); cursor.setSelection(begin, 1);
                }
            }
        } else if (operation != "track" || p["enabled"].toBool() != buffer.params().track_changes) {
            FuncRequest request(code); request.setOrigin(FuncRequest::LYXSERVER);
            DispatchResult result; app->dispatch(request, result);
            if (result.error()) return failure("not_editable", "LyX could not perform this review action");
            mutated = !navigation;
        }
        if (mutated) {
            cursor.forceBufferUpdate(); buffer.updateBuffer(); cursor.clearBufferUpdate(); buffer.changed(true);
        }
        view->processUpdateFlags(Update::Force | Update::FitCursor); window->restartCaret();
    }
    cursor.finishUndo();
    QJsonObject result = codexDocumentSnapshot(*view);
    result["applied"] = true;
    return result;
}
}}
