// SPDX-License-Identifier: GPL-2.0-or-later
// Built into LyX. This bridge uses LyX's real widgets, cursor, and document model.
#include <config.h>
#include "CodexBridge.h"
#include "CodexFramePng.h"
#include "CodexSelectionEdit.h"
#include "GuiApplication.h"
#include "GuiView.h"
#include "GuiWorkArea.h"
#include "qt_helpers.h"
#include "Buffer.h"
#include "BufferView.h"
#include "Cursor.h"
#include "Dimension.h"
#include "DispatchResult.h"
#include "FuncRequest.h"
#include "LyXAction.h"
#include "LyXRC.h"
#include "support/FileName.h"
#include <QApplication>
#include <QAbstractButton>
#include <QAbstractItemView>
#include <QBuffer>
#include <QClipboard>
#include <QComboBox>
#include <QCompleter>
#include <QContextMenuEvent>
#include <QCryptographicHash>
#include <QDateTime>
#include <QElapsedTimer>
#include <QFile>
#include <QImage>
#include <QImageReader>
#include <QInputMethodEvent>
#include <QInputMethodQueryEvent>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QKeyEvent>
#include <QLocalServer>
#include <QLocalSocket>
#include <QMenuBar>
#include <QMenu>
#include <QMessageBox>
#include <QMimeData>
#include <QMouseEvent>
#include <QPainter>
#include <QPointer>
#include <QScrollBar>
#include <QSlider>
#include <QTimer>
#include <QUuid>
#include <QLineEdit>
#include <QPlainTextEdit>
#include <QTextEdit>
#include <QTextDocument>
#include <QTextDocumentFragment>
#include <QTextCharFormat>
#include <QWheelEvent>
#include <memory>
#include <functional>
#include <sstream>
#include <cmath>

namespace lyx { namespace frontend {
namespace {
QJsonArray position(DocIterator const & it)
{
    QJsonArray result;
    for (size_t i = 0; i < it.depth(); ++i) {
        CursorSlice const & s = it[i];
        result.append(QJsonObject{{"paragraph", double(s.pit())}, {"position", double(s.pos())}, {"cell", double(s.idx())}});
    }
    return result;
}

class CodexBridge : public QObject {
    GuiApplication * app_;
    QLocalServer server_;
    QHash<QString, QPointer<QWidget>> surfaces_;
    QPointer<QWidget> pressed_;
    bool contextPress_ = false;
    int pendingInput_ = 0;
    QPointer<QWidget> compositionTarget_;
    QMetaObject::Connection compositionDestroyed_;
    bool compositionActive_ = false;
    QByteArray frameHash_;
    quint64 frameSerial_ = 0;
    struct CapturedSurface {QImage image; QByteArray png;};
    QHash<QString, CapturedSurface> frameImages_;
    QJsonObject menuClipboard_;
    Buffer const * menuClipboardBuffer_ = nullptr;
    QByteArray menuClipboardHash_;
    QStringList completedMenuRequests_;
    QJsonObject copiedDocumentClipboard_;
    Buffer const * copiedDocumentBuffer_ = nullptr;
    QByteArray copiedDocumentHash_;
    static constexpr int maxImageBytes_ = 8 * 1024 * 1024;
    static constexpr int maxImageChunkBytes_ = 192 * 1024;
    static constexpr int imageUploadLifetime_ = 120000;
    QJsonObject imageUpload_;
    QByteArray imageUploadBytes_;
    Buffer const * imageUploadBuffer_ = nullptr;
    QElapsedTimer imageUploadAge_;
    qint64 imageUploadDeadline_ = 0;
    QTimer imageUploadExpiry_;

    template<class Event> class PendingInputEvent : public Event {
        std::function<void()> completed_;
    public:
        PendingInputEvent(Event const & event, std::function<void()> completed)
            : Event(event), completed_(std::move(completed)) {}
        ~PendingInputEvent() override {completed_();}
    };
    class DeferredActionEvent : public QEvent {
        std::function<void()> action_;
    public:
        static QEvent::Type eventType() {
            static auto const type = static_cast<QEvent::Type>(QEvent::registerEventType());
            return type;
        }
        explicit DeferredActionEvent(std::function<void()> action)
            : QEvent(eventType()), action_(std::move(action)) {}
        void run() {action_();}
    };
    template<class Event> void postInput(QObject * target, Event const & event) {
        ++pendingInput_;
        QPointer<CodexBridge> guard(this);
        QApplication::postEvent(target, new PendingInputEvent<Event>(event, [guard] {
            if (guard) --guard->pendingInput_;
        }));
    }
    void postAction(std::function<void()> action) {
        // Share the posted-input ordering and lifetime counter. In particular,
        // a paste may stay pending inside a nested import-dialog event loop.
        postInput(this, DeferredActionEvent(std::move(action)));
    }
    bool event(QEvent * event) override {
        if (event->type() == DeferredActionEvent::eventType()) {
            static_cast<DeferredActionEvent *>(event)->run();
            return true;
        }
        return QObject::event(event);
    }

    QWidget * root() { return app_->currentView(); }
    BufferView * bufferView() {
        auto * view = app_->currentView();
        return view ? view->documentBufferView() : nullptr;
    }
    QByteArray bufferSourceHash(Buffer const & buffer) {
        std::ostringstream source;
        if (!buffer.write(source)) return QByteArray();
        return QCryptographicHash::hash(QByteArray::fromStdString(source.str()), QCryptographicHash::Sha256);
    }
    void clearImageUpload() {
        imageUploadExpiry_.stop();
        imageUploadAge_.invalidate();
        imageUploadDeadline_ = 0;
        imageUpload_ = QJsonObject();
        imageUploadBytes_.clear();
        imageUploadBytes_.squeeze();
        imageUploadBuffer_ = nullptr;
    }
    void expireImageUpload() {
        // Monotonic clocks can pause during suspend; a wall clock can move
        // backwards. Neither event may extend this bounded upload lifetime.
        if (!imageUpload_.isEmpty() && (imageUploadAge_.elapsed() >= imageUploadLifetime_
            || QDateTime::currentMSecsSinceEpoch() >= imageUploadDeadline_))
            clearImageUpload();
    }
    QString imageTargetError(QJsonObject const & p, Buffer const * expectedBuffer = nullptr) {
        if (compositionActive_)
            return "Finish or cancel the active input-method composition before pasting an image";
        if (pendingInput_ > 0)
            return "Native input is still pending; paste the image again after it finishes";
        auto * bv = bufferView();
        QJsonObject const current = state(false);
        if (!bv || current["clipboardSelection"].toObject()["kind"] != "document")
            return "Select the document before pasting an image";
        if ((expectedBuffer && &bv->buffer() != expectedBuffer)
            || !p["expectedPath"].isString() || p["expectedPath"] != current["path"]
            || !p["expectedSelection"].isObject() || p["expectedSelection"] != current["clipboardSelection"]
            || !p["expectedSourceRevision"].isString()
            || p["expectedSourceRevision"].toString() != QString::fromLatin1(bufferSourceHash(bv->buffer()).toHex()))
            return "The document or selection changed while reading the clipboard image; paste again";
        return QString();
    }
    void clearMenuClipboard() {
        menuClipboard_ = QJsonObject();
        menuClipboardBuffer_ = nullptr;
        menuClipboardHash_.clear();
    }
    QJsonObject reusableDocumentClipboard(QJsonObject const & current) {
        auto * bv = bufferView();
        QJsonObject const origin = copiedDocumentClipboard_["origin"].toObject();
        if (!bv || &bv->buffer() != copiedDocumentBuffer_ || copiedDocumentHash_.isEmpty()
            || current["path"] != origin["path"] || current["clipboardSelection"] != origin["clipboardSelection"]
            || bufferSourceHash(bv->buffer()) != copiedDocumentHash_) return QJsonObject();
        return copiedDocumentClipboard_;
    }
    QString surfaceId(QWidget * w) { return QString::number(quintptr(w), 16); }
    Qt::KeyboardModifiers modifiers(QJsonObject const & p) {
        Qt::KeyboardModifiers m = Qt::NoModifier;
        if (p["shift"].toBool()) m |= Qt::ShiftModifier;
        if (p["alt"].toBool()) m |= Qt::AltModifier;
        bool swap = false;
#ifdef Q_OS_MAC
        swap = !QApplication::testAttribute(Qt::AA_MacDontSwapCtrlAndMeta);
#endif
        if (p["meta"].toBool()) m |= swap ? Qt::ControlModifier : Qt::MetaModifier;
        if (p["ctrl"].toBool()) m |= swap ? Qt::MetaModifier : Qt::ControlModifier;
        return m;
    }
    Qt::MouseButton button(int b) {
        return b == 2 ? Qt::RightButton : b == 1 ? Qt::MiddleButton : Qt::LeftButton;
    }
    Qt::MouseButtons buttons(int b) {
        Qt::MouseButtons result = Qt::NoButton;
        if (b & 1) result |= Qt::LeftButton;
        if (b & 2) result |= Qt::RightButton;
        if (b & 4) result |= Qt::MiddleButton;
        return result;
    }
    QWidget * clipboardFocus() {
        QWidget * focus = QApplication::focusWidget();
        // Editable combo boxes (notably LyX Find/Replace) retain QWidget focus
        // while their internal QLineEdit owns the actual text selection.
        if (auto * combo = qobject_cast<QComboBox *>(focus))
            if (combo->isEditable()) return combo->lineEdit();
        return focus;
    }
    QWidget * inputMethodFocus() {
        QWidget * focus = nullptr;
        if (auto * modal = QApplication::activeModalWidget())
            focus = modal->focusWidget() ? modal->focusWidget() : modal;
        if (!focus) focus = QApplication::focusWidget();
        if (auto * combo = qobject_cast<QComboBox *>(focus))
            if (combo->isEditable()) focus = combo->lineEdit();
        if (auto * popup = QApplication::activePopupWidget()) {
            QWidget * editor = popup->focusWidget() ? popup->focusWidget() : popup;
            if (auto * combo = qobject_cast<QComboBox *>(editor))
                if (combo->isEditable()) editor = combo->lineEdit();
            QInputMethodQueryEvent query(Qt::ImEnabled);
            QApplication::sendEvent(editor, &query);
            // Keep a popup's real text editor. Only an editor's own completion
            // popup may pass text back to it; menus and selection-only popups
            // must never allow typing into the document behind them.
            if (query.value(Qt::ImEnabled).toBool()) return editor;
            if (auto * line = qobject_cast<QLineEdit *>(focus))
                if (line->completer() && line->completer()->popup() == popup) return line;
            return popup;
        }
        return focus;
    }
    GuiWorkArea * inputWorkArea(QWidget * focus) {
        for (QWidget * widget = focus; widget; widget = widget->parentWidget()) {
            if (auto * area = qobject_cast<GuiWorkArea *>(widget)) return area;
            // A dialog can be owned by the document's work area without being
            // part of that editor. In particular, QFileDialog uses the focused
            // widget as its parent. Never map its text field through the owner's
            // viewport (which is not a child of the dialog's native surface).
            if (widget->isWindow()) break;
        }
        return nullptr;
    }
    void clearComposition() {
        disconnect(compositionDestroyed_);
        compositionTarget_.clear();
        compositionActive_ = false;
    }
    QJsonObject inputMethodState() {
        QJsonObject result{{"enabled", false}, {"composing", compositionActive_}};
        QWidget * focus = inputMethodFocus();
        if (!focus || !focus->isVisible() || !focus->isEnabled()) return result;
        QWidget * coordinates = focus;
        auto * area = inputWorkArea(focus);
        // LyX stores its preedit rectangle during viewport painting. Without
        // preedit, non-Chinese QPA locales never update that cached rectangle.
        // Query the real widget, but use BufferView's current caret in that case.
        if (area && compositionActive_ && compositionTarget_ == focus)
            area->viewport()->repaint();
        QInputMethodQueryEvent query(Qt::ImEnabled | Qt::ImCursorRectangle);
        QApplication::sendEvent(focus, &query);
        if (!query.value(Qt::ImEnabled).toBool()) return result;
        QRectF rect = query.value(Qt::ImCursorRectangle).toRectF();
        if (area) {
            coordinates = area->viewport();
            if (area->bufferView().busy()) return result;
            if (!compositionActive_ || compositionTarget_ != focus) {
                Point point;
                Dimension dim;
                area->bufferView().caretPosAndDim(point, dim);
                rect = QRectF(point.x_ - area->bufferView().horizScrollOffset(),
                    point.y_, qMax(1, dim.width()), dim.height());
            }
        }
        if (!rect.isValid()) return result;
        QWidget * surface = focus->window();
        rect.translate(coordinates->mapTo(surface, QPoint()));
        result["enabled"] = true;
        result["surface"] = surfaceId(surface);
        result["rect"] = QJsonObject{{"x", rect.x()}, {"y", rect.y()},
            {"width", rect.width()}, {"height", rect.height()}};
        return result;
    }
    QList<QInputMethodEvent::Attribute> compositionAttributes(QWidget * focus,
            QString const & text, QJsonObject const & p) {
        auto boundary = [&text](int offset) {
            offset = qBound(0, offset, text.size());
            if (offset > 0 && offset < text.size() && text.at(offset).isLowSurrogate()
                && text.at(offset - 1).isHighSurrogate()) --offset;
            return offset;
        };
        bool const lyxText = inputWorkArea(focus);
        auto index = [&text, lyxText](int offset) {
            // Qt fields consume UTF-16 positions. LyX 2.4 paints a UCS-4
            // preedit string and directly indexes it with these attributes.
            return lyxText ? text.left(offset).toUcs4().size() : offset;
        };
        int const cursor = boundary(p["cursor"].toInt(text.size()));
        QList<QInputMethodEvent::Attribute> attributes;
        attributes.append(QInputMethodEvent::Attribute(QInputMethodEvent::Cursor,
            index(cursor), 1, QVariant()));
        if (p["selection"].isObject()) {
            auto const selection = p["selection"].toObject();
            int const start = boundary(selection["start"].toInt());
            int const end = boundary(start + qBound(0, selection["length"].toInt(), text.size() - start));
            if (end > start) {
                QTextCharFormat format;
                format.setFontUnderline(true);
                format.setBackground(focus->palette().brush(QPalette::Highlight));
                format.setForeground(focus->palette().brush(QPalette::HighlightedText));
                // Selection means a highlighted preedit clause, never Qt's
                // Selection attribute, which moves the surrounding edit cursor.
                attributes.append(QInputMethodEvent::Attribute(QInputMethodEvent::TextFormat,
                    index(start), index(end) - index(start), QVariant::fromValue(QTextFormat(format))));
            }
        }
        return attributes;
    }
    QJsonObject clipboardSelection(QJsonObject const & document) {
        QWidget * focus = clipboardFocus();
        if (auto * line = qobject_cast<QLineEdit *>(focus)) {
            // Qt intentionally disables copying password fields. Do not reveal
            // their selected text through the browser's clipboard status either.
            bool const selected = line->hasSelectedText() && line->echoMode() == QLineEdit::Normal;
            return {{"kind", "widget"}, {"widget", surfaceId(line)},
                {"hasSelection", selected}, {"text", selected ? line->selectedText() : QString()},
                {"start", selected ? line->selectionStart() : line->cursorPosition()},
                {"end", selected ? line->selectionStart() + line->selectedText().size() : line->cursorPosition()}};
        }
        QTextCursor cursor;
        if (auto * text = qobject_cast<QTextEdit *>(focus)) cursor = text->textCursor();
        else if (auto * text = qobject_cast<QPlainTextEdit *>(focus)) cursor = text->textCursor();
        if (!cursor.isNull()) {
            return {{"kind", "widget"}, {"widget", surfaceId(focus)},
                {"hasSelection", cursor.hasSelection()}, {"text", cursor.selection().toPlainText()},
                {"start", cursor.selectionStart()}, {"end", cursor.selectionEnd()},
                {"revision", cursor.document()->revision()}};
        }
        return {{"kind", "document"}, {"hasSelection", document["hasSelection"]},
            {"text", document["selection"]}, {"start", document["selectionStart"]},
            {"end", document["selectionEnd"]}};
    }
    QJsonObject state(bool includeSource) {
        auto * bv = bufferView();
        if (!bv) {
            // File New/Open and their text fields still work in an empty LyX
            // window. Report their input state without retaining a closed
            // document's selection, path, or save status in the web panel.
            QJsonObject result{{"ready", false}, {"hasSelection", false}, {"selection", QString()},
                {"selectionStart", QJsonArray()}, {"selectionEnd", QJsonArray()},
                {"capabilities", QJsonObject{{"pointerCancel", true}, {"editSelection", true}, {"compositionGuard", true}, {"imagePaste", true}, {"imagePasteChunks", true}, {"wheelInput", true}}},
                {"inputPending", pendingInput_ > 0}};
            result["clipboardSelection"] = clipboardSelection(result);
            result["inputMethod"] = inputMethodState();
            if (!menuClipboard_.isEmpty()) result["menuClipboard"] = menuClipboard_;
            return result;
        }
        auto & buffer = bv->buffer();
        buffer.checkExternalModification();
        auto & cursor = bv->cursor();
        QJsonObject result{{"ready", true}, {"path", toqstr(buffer.fileName().absFileName())},
            {"capabilities", QJsonObject{{"pointerCancel", true}, {"editSelection", true}, {"compositionGuard", true}, {"imagePaste", true}, {"imagePasteChunks", true}, {"wheelInput", true}}},
            {"inputPending", pendingInput_ > 0},
            {"modified", !buffer.isClean()},
            {"externalModified", buffer.notifiesExternalModification()
                || (buffer.fileName().exists() && buffer.isChecksumModified())},
            {"hasSelection", cursor.selection()},
            {"cursor", position(cursor)}, {"selectionStart", position(cursor.selectionBegin())},
            {"selectionEnd", position(cursor.selectionEnd())},
            {"selection", cursor.selection() ? toqstr(cursor.selectionAsString(true)) : QString()}};
        result["clipboardSelection"] = clipboardSelection(result);
        result["inputMethod"] = inputMethodState();
        if (!menuClipboard_.isEmpty()) result["menuClipboard"] = menuClipboard_;
        if (includeSource) {
            std::ostringstream source;
            buffer.write(source);
            result["source"] = QString::fromUtf8(source.str().c_str());
            result["sourceRevision"] = QString::fromLatin1(QCryptographicHash::hash(
                QByteArray::fromStdString(source.str()), QCryptographicHash::Sha256).toHex());
            QFile disk(toqstr(buffer.fileName().absFileName()));
            if (disk.open(QIODevice::ReadOnly))
                result["diskRevision"] = QString::fromLatin1(QCryptographicHash::hash(disk.readAll(), QCryptographicHash::Sha256).toHex());
        }
        return result;
    }
    // The offscreen QPA clipboard belongs to this engine, not the user's macOS
    // pasteboard. Carry LyX's own MIME payload without serializing rich text in JS.
    static bool clipboardFormat(QString const & mime) {
        return mime == "application/x-lyx" || mime == "text/plain" || mime == "text/html"
            || mime == "text/x-tex" || mime == "application/x-latex";
    }
    bool clipboardAction(QString const & action) {
        QWidget * focus = clipboardFocus();
        // Dialog text fields implement standard Qt editing slots; document
        // actions must go through LyX so its cut stack and undo remain intact.
        if (qobject_cast<QLineEdit *>(focus) || qobject_cast<QTextEdit *>(focus)
            || qobject_cast<QPlainTextEdit *>(focus)) {
            return QMetaObject::invokeMethod(focus, action.toLatin1().constData(), Qt::DirectConnection);
        } else {
            auto request = lyxaction.lookupFunc(action.toStdString());
            request.setOrigin(FuncRequest::LYXSERVER);
            DispatchResult result;
            app_->dispatch(request, result);
            return result.dispatched() && !result.error();
        }
    }
    QJsonObject clipboard(QJsonObject const & p) {
        auto fail = [](QString const & message) {return QJsonObject{{"error", true}, {"message", message}};};
        if (QApplication::platformName() != "offscreen")
            return fail("Clipboard bridge requires the private offscreen platform");
        QString const action = p["action"].toString("read");
        if (action == "image-begin" || action == "image-chunk"
            || action == "image-commit" || action == "image-cancel") {
            expireImageUpload();
            if (action == "image-begin") {
                if (!imageUpload_.isEmpty()) return fail("A clipboard image upload is already active; finish or cancel it first");
                QString const targetError = imageTargetError(p);
                if (!targetError.isEmpty()) return fail(targetError);
                QString const mime = p["mimeType"].toString();
                if (mime != "image/png" && mime != "image/jpeg")
                    return fail("Only PNG and JPEG clipboard images are supported");
                double const size = p["size"].toDouble(-1);
                if (!p["size"].isDouble() || size < 1 || size > maxImageBytes_ || size != std::floor(size))
                    return fail("Clipboard image size must be between 1 byte and 8 MiB");
                QString const id = QUuid::createUuid().toString(QUuid::WithoutBraces);
                imageUpload_ = {{"id", id}, {"mimeType", mime}, {"size", size},
                    {"expectedPath", p["expectedPath"]}, {"expectedSelection", p["expectedSelection"]},
                    {"expectedSourceRevision", p["expectedSourceRevision"]}};
                imageUploadBuffer_ = &bufferView()->buffer();
                imageUploadBytes_.reserve(int(size));
                imageUploadAge_.start();
                imageUploadDeadline_ = QDateTime::currentMSecsSinceEpoch() + imageUploadLifetime_;
                imageUploadExpiry_.start(1000);
                return {{"uploadId", id}, {"maxChunkBytes", maxImageChunkBytes_}, {"expiresInMs", imageUploadLifetime_}};
            }
            QString const id = p["uploadId"].toString();
            if (id.isEmpty() || id != imageUpload_.value("id").toString())
                return fail("Clipboard image upload expired or is no longer available");
            if (action == "image-cancel") {
                clearImageUpload();
                return state(false);
            }
            auto rejectUpload = [this, &fail](QString const & message) {
                clearImageUpload();
                return fail(message);
            };
            if (action == "image-chunk") {
                double const offset = p["offset"].toDouble(-1);
                if (!p["offset"].isDouble() || offset != imageUploadBytes_.size())
                    return rejectUpload("Clipboard image chunk is out of order; paste the image again");
                if (!p["data"].isString() || p["data"].toString().size() > (maxImageChunkBytes_ + 2) / 3 * 4)
                    return rejectUpload("Clipboard image chunk exceeds 192 KiB or is invalid");
                QByteArray const encoded = p["data"].toString().toLatin1();
                QByteArray const bytes = QByteArray::fromBase64(encoded);
                if (bytes.isEmpty() || bytes.toBase64() != encoded || bytes.size() > maxImageChunkBytes_)
                    return rejectUpload("Clipboard image chunk has invalid base64 or size");
                if (imageUploadBytes_.size() + bytes.size() > imageUpload_["size"].toInt())
                    return rejectUpload("Clipboard image exceeds its declared size");
                imageUploadBytes_.append(bytes);
                return {{"uploadId", id}, {"receivedBytes", imageUploadBytes_.size()}};
            }
            if (imageUploadBytes_.size() != imageUpload_["size"].toInt())
                return rejectUpload("Clipboard image upload is incomplete; paste the image again");
            QString const targetError = imageTargetError(imageUpload_, imageUploadBuffer_);
            if (!targetError.isEmpty()) return rejectUpload(targetError);
            // Consume the upload before dispatch. A repeated or lost commit
            // cannot paste twice, and no image bytes reach disk at this stage.
            QJsonObject paste = imageUpload_;
            paste["action"] = "paste";
            paste["formats"] = QJsonObject();
            paste["image"] = QJsonObject{{"mimeType", imageUpload_["mimeType"]},
                {"data", QString::fromLatin1(imageUploadBytes_.toBase64())}};
            clearImageUpload();
            return clipboard(paste);
        }
        if (action == "menu-cancel" || action == "menu-commit") {
            QString const id = p["requestId"].toString();
            if (completedMenuRequests_.contains(id)) return state(false);
            if (id.isEmpty() || id != menuClipboard_["id"].toString())
                return fail("Native menu clipboard request expired");
            QJsonObject const pending = menuClipboard_;
            Buffer const * const expectedBuffer = menuClipboardBuffer_;
            QByteArray const expectedHash = menuClipboardHash_;
            clearMenuClipboard();
            if (action == "menu-cancel") return state(false);
            if (pending["action"] == "paste")
                return fail("Use the browser paste shortcut to supply clipboard contents");
            QJsonObject const origin = pending["clipboard"].toObject()["origin"].toObject();
            QJsonObject const current = state(false);
            if (current["path"] != origin["path"] || current["clipboardSelection"] != origin["clipboardSelection"])
                return fail("Native menu selection changed; nothing was cut");
            if (expectedBuffer) {
                auto * bv = bufferView();
                // Text and cursor positions can stay identical after a font,
                // inset, or document-setting edit. Never cut that newer source.
                if (!bv || &bv->buffer() != expectedBuffer || expectedHash.isEmpty()
                    || bufferSourceHash(bv->buffer()) != expectedHash)
                    return fail("Native menu document changed; nothing was cut");
            }
            QJsonObject result;
            if (pending["action"] == "cut") {
                result = clipboard({{"action", "cut"}, {"expectedPath", origin["path"]},
                    {"expectedSelection", origin["clipboardSelection"]}});
                if (result["error"].toBool()) return result;
            } else result = current;
            completedMenuRequests_.append(id);
            while (completedMenuRequests_.size() > 32) completedMenuRequests_.removeFirst();
            return result;
        }
        if (action != "read" && action != "copy" && action != "cut" && action != "paste")
            return fail("Unknown clipboard action");
        if (action == "copy" || action == "cut") {
            QJsonObject const current = state(false);
            if (p.contains("expectedPath") && (!p["expectedPath"].isString()
                || p["expectedPath"] != current["path"]))
                return fail("Clipboard document changed; select and copy again");
            if (p.contains("expectedSelection") && (!p["expectedSelection"].isObject()
                || p["expectedSelection"] != current["clipboardSelection"]))
                return fail("Clipboard selection changed; select and copy again");
        }
        constexpr int maxBytes = 512 * 1024;
        if (action == "paste") {
            if (!p["formats"].isObject()) return fail("Clipboard formats must be an object");
            auto const formats = p["formats"].toObject();
            bool const hasImage = p.contains("image");
            if ((formats.isEmpty() && !hasImage) || formats.size() > 5) return fail("Invalid clipboard format count");
            QHash<QString, QByteArray> decodedFormats;
            int size = 0;
            for (auto it = formats.begin(); it != formats.end(); ++it) {
                if (!clipboardFormat(it.key()) || !it.value().isString()) return fail("Unsupported clipboard format");
                QByteArray const encoded = it.value().toString().toLatin1();
                if (encoded.size() > (maxBytes + 2) / 3 * 4) return fail("Clipboard exceeds 512 KiB");
                QByteArray const decoded = QByteArray::fromBase64(encoded);
                if (decoded.toBase64() != encoded) return fail("Invalid clipboard base64");
                size += decoded.size();
                if (size > maxBytes) return fail("Clipboard exceeds 512 KiB");
                decodedFormats.insert(it.key(), decoded);
            }
            QImage clipboardImage;
            if (hasImage) {
                QString const targetError = imageTargetError(p);
                if (!targetError.isEmpty()) return fail(targetError);
                if (!p["image"].isObject()) return fail("Invalid clipboard image");
                QJsonObject const image = p["image"].toObject();
                QString const mime = image["mimeType"].toString();
                if ((mime != "image/png" && mime != "image/jpeg") || !image["data"].isString())
                    return fail("Only PNG and JPEG clipboard images are supported");
                QString const encodedString = image["data"].toString();
                if (encodedString.size() > (maxImageBytes_ + 2) / 3 * 4)
                    return fail("Clipboard image exceeds 8 MiB");
                QByteArray const encoded = encodedString.toLatin1();
                QByteArray bytes = QByteArray::fromBase64(encoded);
                if (bytes.isEmpty() || bytes.toBase64() != encoded || bytes.size() > maxImageBytes_)
                    return fail("Invalid clipboard image base64 or size");
                QBuffer input(&bytes);
                input.open(QIODevice::ReadOnly);
                QImageReader reader(&input);
                reader.setDecideFormatFromContent(true);
                QByteArray const format = reader.format();
                if ((mime == "image/png" && format != "png") || (mime == "image/jpeg" && format != "jpeg"))
                    return fail("Clipboard image data does not match its PNG or JPEG type");
                QSize const dimensions = reader.size();
                if (!dimensions.isValid() || dimensions.width() > 16384 || dimensions.height() > 16384
                    || qint64(dimensions.width()) * dimensions.height() > 16 * 1024 * 1024)
                    return fail("Clipboard image exceeds the 16 megapixel limit or has invalid dimensions");
                clipboardImage = reader.read();
                if (clipboardImage.isNull()) return fail("Clipboard image could not be decoded");
            }
            if (menuClipboard_["action"] == "paste") clearMenuClipboard();
            // Native paste may open an import/branch dialog. Acknowledge first,
            // as with dispatch, so the browser can supply that dialog's input.
            // Each queued operation owns its MIME snapshot: another request
            // must not replace the shared Qt clipboard before this paste runs.
            postAction([this, decodedFormats, clipboardImage] {
                auto * data = new QMimeData;
                for (auto it = decodedFormats.begin(); it != decodedFormats.end(); ++it)
                    data->setData(it.key(), it.value());
                if (!clipboardImage.isNull()) data->setImageData(clipboardImage);
                QApplication::clipboard()->setMimeData(data, QClipboard::Clipboard);
                clipboardAction("paste");
            });
            return state(false);
        }
        // Validate a copy before cutting: a payload limit must never remove text
        // that the browser could not place on its clipboard.
        bool const copied = (action == "copy" || action == "cut") && clipboardAction("copy");
        QJsonObject formats;
        int size = 0;
        QString text;
        if (auto * data = QApplication::clipboard()->mimeData(QClipboard::Clipboard)) {
            for (auto const & mime : data->formats()) {
                if (!clipboardFormat(mime)) continue;
                QByteArray const bytes = data->data(mime);
                size += bytes.size();
                if (size > maxBytes) return fail("Clipboard exceeds 512 KiB");
                formats[mime] = QString::fromLatin1(bytes.toBase64());
            }
            text = data->text();
        }
        QJsonObject const origin = state(false);
        if (action == "cut") clipboardAction("cut");
        QJsonObject result = state(false);
        result["clipboard"] = QJsonObject{{"formats", formats}, {"text", text}, {"origin", origin}};
        QJsonObject const selection = origin["clipboardSelection"].toObject();
        if (action == "copy" && copied && !formats.isEmpty()
            && selection["kind"] == "document" && selection["hasSelection"].toBool()) {
            if (auto * bv = bufferView()) {
                copiedDocumentClipboard_ = result["clipboard"].toObject();
                copiedDocumentBuffer_ = &bv->buffer();
                copiedDocumentHash_ = bufferSourceHash(bv->buffer());
            }
        }
        return result;
    }
    QJsonObject frame(QJsonObject const & p) {
        QWidget * main = root();
        if (!main) return state(false);
        int width = qBound(480, p["width"].toInt(main->width()), 2560);
        int height = qBound(300, p["height"].toInt(main->height()), 1800);
        if (main->size() != QSize(width, height)) main->resize(width, height);
        surfaces_.clear();
        QJsonArray surfaces;
        QList<QWidget *> widgets{main};
        for (auto * w : QApplication::topLevelWidgets())
            if (w != main && w->isVisible() && !qobject_cast<GuiView *>(w)
                && w->windowType() != Qt::ToolTip) widgets.append(w);
        // Paint the native root and transient windows separately, retaining their coordinates.
        QByteArray total;
        QHash<QString, CapturedSurface> nextImages;
        for (auto * w : widgets) {
            QString id = surfaceId(w);
            surfaces_.insert(id, w);
            QImage const image = w->grab().toImage();
            auto cached = frameImages_.constFind(id);
            QByteArray png;
            if (cached != frameImages_.constEnd() && cached->image == image
                && cached->image.devicePixelRatio() == image.devicePixelRatio()) {
                png = cached->png;
            } else {
                if (!codex_frame_png::encode(image, png))
                    return {{"error", "Could not encode the native frame"}};
            }
            nextImages.insert(id, {image, png});
            QPoint offset = w == main ? QPoint() : w->mapToGlobal(QPoint()) - main->mapToGlobal(QPoint());
            QJsonObject surface{{"id", id}, {"x", offset.x()}, {"y", offset.y()},
                {"width", w->width()}, {"height", w->height()}, {"main", w == main},
                {"type", w->metaObject()->className()}, {"title", w->windowTitle()},
                {"modal", w->isModal()}, {"active", w->isActiveWindow()}};
            if (w == main) {
                auto * view = qobject_cast<GuiView *>(main);
                auto * area = view ? view->currentWorkArea() : nullptr;
                if (area && area->isVisible()) {
                    auto * viewport = area->viewport();
                    QPoint const origin = viewport->mapTo(main, QPoint());
                    surface["scrollViewport"] = QJsonObject{{"x", origin.x()}, {"y", origin.y()},
                        {"width", viewport->width()}, {"height", viewport->height()}};
                }
            }
            if (auto * message = qobject_cast<QMessageBox *>(w)) {
                surface["message"] = message->text();
                surface["informativeText"] = message->informativeText();
            }
            QMenu * menu = qobject_cast<QMenu *>(w);
            if (menu) surface["isMenu"] = true;
            QMenuBar * bar = w == main ? main->findChild<QMenuBar *>() : nullptr;
            if (menu || bar) {
                QJsonArray actions;
                for (auto * action : menu ? menu->actions() : bar->actions()) {
                    QRect rect = menu ? menu->actionGeometry(action) : bar->actionGeometry(action);
                    if (bar) rect.translate(bar->mapTo(main, QPoint()));
                    QJsonObject item{{"text", action->text()}, {"enabled", action->isEnabled()},
                        {"separator", action->isSeparator()}, {"x", rect.x()}, {"y", rect.y()},
                        {"width", rect.width()}, {"height", rect.height()}};
                    QString const clipboardAction = action->property("codexClipboardAction").toString();
                    if (clipboardAction == "copy" || clipboardAction == "cut")
                        item["clipboardAction"] = clipboardAction;
                    actions.append(item);
                }
                surface["menuActions"] = actions;
            }
            total += png;
            total += QJsonDocument(surface).toJson(QJsonDocument::Compact);
            surface["png"] = QString::fromLatin1(png.toBase64());
            surfaces.append(surface);
        }
        frameImages_ = std::move(nextImages);
        QByteArray hash = QCryptographicHash::hash(total, QCryptographicHash::Sha256);
        bool changed = hash != frameHash_ || p["serial"].toDouble(-1) != double(frameSerial_);
        if (hash != frameHash_) {frameHash_ = hash; ++frameSerial_;}
        QJsonObject result = state(false);
        result["serial"] = double(frameSerial_);
        result["width"] = main->width(); result["height"] = main->height();
        if (changed) result["surfaces"] = surfaces;
        return result;
    }
    void cancelPointer(QPointer<QWidget> target) {
        if (!target) return;
        // A browser interruption is not a click: never release a menu item or
        // a document inset, which could activate it. End each native gesture
        // through its cancellation state instead.
        for (QWidget * widget = target; widget; widget = widget->parentWidget()) {
            if (auto * area = qobject_cast<GuiWorkArea *>(widget)) {
                area->cancelCodexPointer();
                break;
            }
        }
        if (auto * button = qobject_cast<QAbstractButton *>(target)) button->setDown(false);
        if (qobject_cast<QScrollBar *>(target) || qobject_cast<QSlider *>(target)) {
            // Qt's slider/scrollbar release handlers only stop dragging and
            // auto-repeat; unlike buttons and menus, they do not click actions.
            QMouseEvent release(QEvent::MouseButtonRelease, QPointF(), Qt::LeftButton,
                Qt::NoButton, Qt::NoModifier);
            QApplication::sendEvent(target, &release);
        }
        if (target) {
            if (auto * menu = qobject_cast<QMenu *>(target->window())) menu->hide();
            // A queued press on the menu bar can open a popup before this
            // cancellation runs. Close only a popup owned by the same window.
            if (auto * menu = qobject_cast<QMenu *>(QApplication::activePopupWidget())) {
                for (QWidget * ancestor = menu; ancestor; ancestor = ancestor->parentWidget()) {
                    if (ancestor == target->window()) {menu->hide(); break;}
                }
            }
            QEvent ungrab(QEvent::UngrabMouse);
            QApplication::sendEvent(target, &ungrab);
        }
    }
    void input(QJsonObject const & p) {
        QWidget * main = root();
        if (!main) return;
        QString type = p["type"].toString();
        if (type == "pointercancel") {
            QPointer<QWidget> target = pressed_;
            pressed_.clear();
            contextPress_ = false;
            postAction([this, target] {cancelPointer(target);});
            return;
        }
        auto m = modifiers(p);
        if (type == "pointerdown" || type == "pointerup" || type == "pointermove" || type == "dblclick" || type == "wheel") {
            QWidget * surface = surfaces_.value(p["surface"].toString(), main);
            if (!surface) return;
            QPoint pos(p["x"].toInt(), p["y"].toInt());
            QWidget * target = pressed_ ? pressed_.data() : surface->childAt(pos);
            if (!target) target = surface;
            QPoint global = surface->mapToGlobal(pos);
            QPoint local = target->mapFromGlobal(global);
            if (type == "wheel") {
                int const mode = p["deltaMode"].toInt(-1);
                if (mode >= 0 && mode <= 2) {
                    double const rawX = p["dx"].toDouble(), rawY = p["dy"].toDouble();
                    if (!std::isfinite(rawX) || !std::isfinite(rawY)) return;
                    double const dx = qBound(-1000000.0, rawX, 1000000.0);
                    double const dy = qBound(-1000000.0, rawY, 1000000.0);
                    double const factor = p["zoomFactor"].toDouble(1.0);
                    bool const browserZoom = p.contains("zoomFactor") && mode == 0
                        && std::isfinite(factor) && factor > 0;
                    QPointer<QWidget> guardedTarget(target);
                    postAction([guardedTarget, local, global, m, mode, dx, dy, factor, browserZoom] {
                        if (!guardedTarget) return;
                        QWidget * target = guardedTarget;
                        GuiWorkArea * area = nullptr;
                        QAbstractScrollArea * scrollArea = nullptr;
                        for (QWidget * w = target; w; w = w->parentWidget()) {
                            if (!scrollArea) scrollArea = qobject_cast<QAbstractScrollArea *>(w);
                            if ((area = qobject_cast<GuiWorkArea *>(w))) break;
                            // Dialogs may keep the work area as their QObject
                            // parent. Never cross their native window boundary.
                            if (w->isWindow()) break;
                        }
                        if (area && browserZoom) {
                            GuiView & view = area->view();
                            double desired = view.property("codexWheelZoom").toDouble();
                            if (!view.property("codexWheelZoomApplied").isValid()
                                || view.property("codexWheelZoomApplied").toInt() != lyxrc.currentZoom)
                                desired = lyxrc.currentZoom;
                            desired = qBound(1.0, desired * qBound(0.01, factor, 100.0), 10000.0);
                            int const requested = qRound(desired);
                            // This is the same slot used by GuiView's native
                            // QPinchGesture. LyX owns zoom limits and repainting.
                            QMetaObject::invokeMethod(&view, "zoomValueChanged", Qt::DirectConnection,
                                Q_ARG(int, requested));
                            if (lyxrc.currentZoom != requested) desired = lyxrc.currentZoom;
                            view.setProperty("codexWheelZoom", desired);
                            view.setProperty("codexWheelZoomApplied", lyxrc.currentZoom);
                            return;
                        }
                        bool modifierZoom = false;
                        switch (lyxrc.scroll_wheel_zoom) {
                        case LyXRC::SCROLL_WHEEL_ZOOM_CTRL:
                            modifierZoom = (m & Qt::ControlModifier) && !(m & (Qt::ShiftModifier | Qt::AltModifier)); break;
                        case LyXRC::SCROLL_WHEEL_ZOOM_SHIFT:
                            modifierZoom = (m & Qt::ShiftModifier) && !(m & (Qt::ControlModifier | Qt::AltModifier)); break;
                        case LyXRC::SCROLL_WHEEL_ZOOM_ALT:
                            modifierZoom = (m & Qt::AltModifier) && !(m & (Qt::ShiftModifier | Qt::ControlModifier)); break;
                        case LyXRC::SCROLL_WHEEL_ZOOM_OFF: break;
                        }
                        // LyX 2.4 ignores pixelDelta and derives every scroll
                        // from angleDelta. Preserve native horizontal-wheel
                        // behavior, but use its scrollbar for exact DOM units.
                        if (area && !modifierZoom) {
                            if (std::abs(dx) > std::abs(dy)) return;
                            QScrollBar * bar = area->verticalScrollBar();
                            double const unit = mode == 1 ? bar->singleStep() : mode == 2 ? bar->pageStep() : 1.0;
                            double const total = bar->property("codexWheelRemainder").toDouble()
                                + dy * unit * lyxrc.mouse_wheel_speed;
                            if (!std::isfinite(total)) return;
                            double const whole = std::trunc(total + (total < 0 ? -1e-9 : 1e-9));
                            double const requested = double(bar->value()) - whole;
                            int const value = int(qBound(double(bar->minimum()), requested, double(bar->maximum())));
                            double const remainder = total - whole;
                            bool const boundary = (value == bar->minimum() && total > 0)
                                || (value == bar->maximum() && total < 0);
                            bar->setProperty("codexWheelRemainder", requested == value && !boundary
                                && std::abs(remainder) >= 1e-9 ? remainder : 0.0);
                            bar->setValue(value);
                            return;
                        }
                        // Other Qt controls and native modifier-wheel zoom keep
                        // receiving QWheelEvent. Their fractional integer fields
                        // accumulate on that widget rather than being discarded.
                        auto integral = [target](char const * property, double delta) {
                            double const total = target->property(property).toDouble() + delta;
                            double const limited = qBound(-1000000000.0, total, 1000000000.0);
                            int const whole = int(std::trunc(limited + (limited < 0 ? -1e-9 : 1e-9)));
                            double const remainder = limited - whole;
                            target->setProperty(property, limited == total && std::abs(remainder) >= 1e-9 ? remainder : 0.0);
                            return whole;
                        };
                        double const lines = qMax(1, QApplication::wheelScrollLines());
                        auto angle = [scrollArea, target, lines, mode](double delta, bool vertical) {
                            if (mode == 0) return delta * 3.0;
                            if (mode == 1) return delta * 120.0 / lines;
                            QScrollBar * bar = scrollArea ? (vertical ? scrollArea->verticalScrollBar() : scrollArea->horizontalScrollBar()) : nullptr;
                            double const page = bar ? double(bar->pageStep()) / qMax(1, bar->singleStep())
                                : double(vertical ? target->height() : target->width()) / qMax(1, target->fontMetrics().height());
                            return delta * page * 120.0 / lines;
                        };
                        QPoint const pixels = mode == 0 ? QPoint(integral("codexWheelPixelX", dx), integral("codexWheelPixelY", dy)) : QPoint();
                        QPoint const angles(integral("codexWheelAngleX", angle(dx, false)), integral("codexWheelAngleY", angle(dy, true)));
                        QWheelEvent event(QPointF(local), QPointF(global), pixels, angles,
                            Qt::NoButton, m, Qt::NoScrollPhase, false);
                        QApplication::sendEvent(target, &event);
                    });
                    return;
                }
                QWheelEvent event(QPointF(local), QPointF(global), QPoint(p["dx"].toInt(), p["dy"].toInt()),
                    QPoint(p["ax"].toInt(), p["ay"].toInt()), Qt::NoButton, m, Qt::NoScrollPhase, false);
                postInput(target, event);
            } else {
                auto eventType = type == "pointerdown" ? QEvent::MouseButtonPress : type == "pointerup" ? QEvent::MouseButtonRelease
                    : type == "dblclick" ? QEvent::MouseButtonDblClick : QEvent::MouseMove;
                if (type == "pointerdown") {
                    pressed_ = target;
                    contextPress_ = p["button"].toInt() == 2;
#ifdef Q_OS_MAC
                    // Cocoa normally turns Control-click into a context click.
                    // This offscreen process receives synthetic input instead.
                    contextPress_ = contextPress_ || (p["button"].toInt() == 0 && p["ctrl"].toBool());
#endif
                    // Native popup menus borrow their parent window's activation;
                    // activating the popup itself can make LyX reject the action
                    // for having a different current view when it is clicked.
                    if (target->window()->windowType() != Qt::Popup)
                        QApplication::setActiveWindow(target->window());
                    // Posted mouse events are not spontaneous, so Qt skips its
                    // normal click-focus traversal. A scroll area's viewport
                    // is NoFocus; its parent/proxy owns keyboard focus instead.
                    QWidget * focusTarget = target;
                    QPoint focusPosition = local;
                    while (focusTarget) {
                        QWidget * proxy = focusTarget;
                        while (proxy->focusProxy()) proxy = proxy->focusProxy();
                        auto clickFocus = [](QWidget * widget) {
                            return (widget->focusPolicy() & Qt::ClickFocus) == Qt::ClickFocus;
                        };
                        if (focusTarget->isEnabled() && focusTarget->rect().contains(focusPosition)
                            && clickFocus(focusTarget) && clickFocus(proxy)) {
                            focusTarget->setFocus(Qt::MouseFocusReason);
                            break;
                        }
                        // Preserve an existing focus and never cross a native
                        // window boundary, including popup menus and dialogs.
                        if (focusTarget->isWindow() || proxy->hasFocus()) break;
                        focusPosition += focusTarget->pos();
                        focusTarget = focusTarget->parentWidget();
                    }
                }
                Qt::MouseButtons pressedButtons = buttons(p["buttons"].toInt());
                if (contextPress_ && pressedButtons.testFlag(Qt::LeftButton)) {
                    pressedButtons &= ~Qt::LeftButton;
                    pressedButtons |= Qt::RightButton;
                }
                QMouseEvent event(eventType, QPointF(local), QPointF(target->window()->mapFromGlobal(global)), QPointF(global),
                    type == "pointermove" ? Qt::NoButton : contextPress_ ? Qt::RightButton : button(p["button"].toInt()), pressedButtons, m);
                postInput(target, event);
                if (type == "pointerup") {
                    // GuiWorkArea records the appropriate native menu during
                    // right-button press, but requires this separate QPA event
                    // to show it. Post after release to keep menu exec modal-safe.
                    if (contextPress_)
                        postInput(target, QContextMenuEvent(QContextMenuEvent::Mouse, local, global, m));
                    pressed_.clear();
                    contextPress_ = false;
                }
            }
            return;
        }
        // QPA redirects keyboard input to popups for navigation and acceptance.
        // IME text belongs to the focused editor instead: a QFileDialog
        // completion popup can otherwise consume or alter committed characters.
        bool const textInput = type == "commit" || type == "composition";
        QWidget * focus = textInput ? inputMethodFocus() : QApplication::activePopupWidget();
        if (!textInput && focus) {
            // QComboBox's popup is a private container. Navigation and Return
            // are handled by filters installed on its item view, not by the
            // outer window. Offscreen QPA does not redirect these for us.
            if (auto * combo = qobject_cast<QComboBox *>(focus->parentWidget())) {
                auto * view = combo->view();
                if (view && view->isVisible() && view->window() == focus)
                    focus = view;
            }
        }
        if (!focus) {
            if (auto * modal = QApplication::activeModalWidget())
                focus = modal->focusWidget() ? modal->focusWidget() : modal;
        }
        if (!focus) focus = QApplication::focusWidget();
        if (!focus) {
            // Closing an offscreen dialog can leave Qt without a focus widget.
            // Restore the active document, not the first work area in the
            // QObject tree, which may belong to a different open tab.
            auto * area = app_->currentView()->currentMainWorkArea();
            focus = area ? area : main;
            QApplication::setActiveWindow(main);
            focus->setFocus();
        }
        if (qEnvironmentVariableIsSet("LYX_CODEX_DEBUG_INPUT")) {
            auto * modal = QApplication::activeModalWidget();
            auto * popup = QApplication::activePopupWidget();
            qWarning("Codex input %s key=%d target=%s title=%s modal=%s popup=%s", qPrintable(type),
                p["key"].toInt(), focus->metaObject()->className(), qPrintable(focus->window()->windowTitle()),
                modal ? modal->metaObject()->className() : "none", popup ? popup->metaObject()->className() : "none");
        }
        if (type == "commit" || type == "composition") {
            // A browser composition belongs to the widget where it began. A
            // later focus change must not deliver its update/commit to a dialog
            // field or another document. Pending input guards its final event.
            if (compositionActive_ && compositionTarget_) focus = compositionTarget_;
            else if (auto * combo = qobject_cast<QComboBox *>(focus))
                if (combo->isEditable()) focus = combo->lineEdit();
            QString const preedit = type == "composition" ? p["text"].toString() : QString();
            if (!preedit.isEmpty() && !compositionActive_) {
                compositionActive_ = true;
                compositionTarget_ = focus;
                compositionDestroyed_ = connect(focus, &QObject::destroyed, this, [this] {clearComposition();});
            }
            QInputMethodEvent event(preedit, type == "composition"
                ? compositionAttributes(focus, preedit, p) : QList<QInputMethodEvent::Attribute>());
            if (type == "commit") event.setCommitString(p["text"].toString());
            if (type == "commit" && p["key"].toInt() > 0 && !compositionActive_
                && inputWorkArea(focus)) {
                QPointer<QWidget> target(focus);
                // Decide when the queued event executes: an earlier key may
                // still be establishing the prefix when this RPC arrives.
                postAction([this, target, event, p, m]() mutable {
                    if (!target) return;
                    // GuiWorkArea queues key symbols once more through its
                    // compressor. Drain only that receiver's earlier keys so
                    // a batched prefix is visible before testing its next key.
                    if (auto * area = inputWorkArea(target))
                        if (auto * proxy = area->findChild<CompressorProxy *>())
                            QCoreApplication::sendPostedEvents(proxy, QEvent::MetaCall);
                    if (!target) return;
                    if (auto * current = inputMethodFocus()) {
                        if (current != target) {
                            QApplication::sendEvent(current, &event);
                            return;
                        }
                    }
                    if (app_->hasPendingCodexKeySequence()) {
                        QKeyEvent press(QEvent::KeyPress, p["key"].toInt(), m,
                            p["text"].toString(), p["repeat"].toBool());
                        QApplication::sendEvent(target, &press);
                        if (target) {
                            QKeyEvent release(QEvent::KeyRelease, p["key"].toInt(), m, p["text"].toString());
                            QApplication::sendEvent(target, &release);
                        }
                    } else QApplication::sendEvent(target, &event);
                });
            } else postInput(focus, event);
            if (preedit.isEmpty()) clearComposition();
        } else if (type == "keydown" || type == "keyup") {
            QKeyEvent event(type == "keydown" ? QEvent::KeyPress : QEvent::KeyRelease,
                p["key"].toInt(), m, p["text"].toString(), p["repeat"].toBool());
            postInput(focus, event);
        }
    }
    QJsonObject handle(QString const & method, QJsonObject const & p) {
        if (method == "frame") return frame(p);
        if (method == "selection") return state(true);
        if (method == "state") return state(false);
        if (method == "clipboard") {
            if (p["action"] == "replace-selection") {
                if (compositionActive_) return {{"error", true}, {"applied", false},
                    {"code", "input_pending"}, {"message", "Finish or cancel the active input-method composition before editing"}};
                if (pendingInput_ > 0) return {{"error", true}, {"applied", false},
                    {"code", "input_pending"}, {"message", "Native input is still pending; read the document again before editing"}};
                return editCodexSelection(app_, p);
            }
            return clipboard(p);
        }
        if (method == "input") {input(p); return state(false);}
        if (method == "dispatch") {
            // Modal dialogs run a nested Qt event loop. Acknowledge UI dispatch
            // before opening one so the browser can send its dialog interaction.
            postAction([this, p] {handle("command", p);});
            return state(false);
        }
        if (method == "command") {
            auto request = lyxaction.lookupFunc(p["command"].toString().toStdString());
            request.setOrigin(FuncRequest::LYXSERVER);
            DispatchResult result;
            app_->dispatch(request, result);
            QJsonObject response = state(false);
            response["error"] = result.error();
            response["message"] = toqstr(result.message());
            return response;
        }
        return {{"error", true}, {"message", "Unknown bridge method"}};
    }
public:
    bool interceptMenuClipboard(GuiApplication * app, FuncRequest const & request, DispatchResult & result) {
        if (app != app_ || (request.origin() != FuncRequest::MENU && request.origin() != FuncRequest::TOOLBAR)
            || (request.action() != LFUN_COPY && request.action() != LFUN_CUT && request.action() != LFUN_PASTE)) return false;
        // Preserve the selection until the browser confirms its clipboard write.
        // Reuse an unchanged document's prepared snapshot: another native copy
        // would regenerate HTML paragraph IDs and break byte-for-byte matching.
        // LYXSERVER requests from clipboard() deliberately bypass this hook.
        clearMenuClipboard();
        bool const paste = request.action() == LFUN_PASTE;
        QJsonObject const current = state(false);
        QJsonObject const prepared = paste ? QJsonObject() : reusableDocumentClipboard(current);
        QJsonObject const copied = paste
            ? QJsonObject{{"clipboard", QJsonObject{{"formats", QJsonObject()}, {"text", ""}, {"origin", current}}}}
            : !prepared.isEmpty() ? QJsonObject{{"clipboard", prepared}} : clipboard({{"action", "copy"}});
        result.setError(copied["error"].toBool());
        if (!result.error()) {
            menuClipboard_ = {{"id", QUuid::createUuid().toString(QUuid::WithoutBraces)},
                {"action", paste ? "paste" : request.action() == LFUN_CUT ? "cut" : "copy"}, {"clipboard", copied["clipboard"]}};
            QJsonObject const origin = copied["clipboard"].toObject()["origin"].toObject();
            if (!paste && origin["clipboardSelection"].toObject()["kind"] == "document") {
                if (auto * bv = bufferView()) {
                    menuClipboardBuffer_ = &bv->buffer();
                    menuClipboardHash_ = bufferSourceHash(bv->buffer());
                }
            }
        }
        result.dispatched(true);
        result.screenUpdate(Update::None);
        result.clearBufferUpdate();
        return true;
    }
    CodexBridge(GuiApplication * app, QString const & socket) : QObject(app), app_(app), server_(this) {
        imageUploadExpiry_.setTimerType(Qt::PreciseTimer);
        connect(&imageUploadExpiry_, &QTimer::timeout, this, [this] {expireImageUpload();});
        server_.setSocketOptions(QLocalServer::UserAccessOption);
        // Unique socket paths are allocated by the broker. Never remove another process's socket.
        if (!server_.listen(socket)) {qWarning("LyX Codex socket could not be opened"); return;}
        connect(&server_, &QLocalServer::newConnection, this, [this] {
            while (auto * client = server_.nextPendingConnection()) {
                // An allowed 8 MiB image expands to more than 10 MiB as base64.
                // Keep a bounded envelope, including JSON request metadata.
                constexpr qint64 maxRequestBytes = 12 * 1024 * 1024 + 64 * 1024;
                client->setReadBufferSize(maxRequestBytes + 1);
                connect(client, &QLocalSocket::disconnected, client, &QObject::deleteLater);
                connect(client, &QLocalSocket::readyRead, this, [this, client] {
                    while (client->canReadLine()) {
                        QByteArray const line = client->readLine(maxRequestBytes + 1);
                        if (!line.endsWith('\n')) {client->abort(); return;}
                        auto request = QJsonDocument::fromJson(line).object();
                        // Never enter a dialog's event loop inside readyRead:
                        // Qt does not emit that socket's readyRead recursively.
                        QPointer<QLocalSocket> safeClient(client);
                        QTimer::singleShot(0, this, [this, safeClient, request] {
                            if (!safeClient) return;
                            QJsonObject response{{"id", request["id"]},
                                {"result", handle(request["method"].toString(), request["params"].toObject())}};
                            if (safeClient) safeClient->write(QJsonDocument(response).toJson(QJsonDocument::Compact) + '\n');
                        });
                    }
                    // A full buffer without a newline must not deadlock this
                    // connection and every subsequent valid request on it.
                    if (client->bytesAvailable() >= maxRequestBytes) client->abort();
                });
            }
        });
    }
};
QPointer<CodexBridge> activeBridge;
}
bool interceptCodexClipboard(GuiApplication * app, FuncRequest const & request, DispatchResult & result)
{
    return activeBridge && activeBridge->interceptMenuClipboard(app, request, result);
}
void startCodexBridge(GuiApplication * app)
{
    QString socket = qEnvironmentVariable("LYX_CODEX_SOCKET");
    if (socket.isEmpty()) return;
    QApplication::setAttribute(Qt::AA_DontUseNativeMenuBar);
    // Isolate native Qt settings from the user's ordinary LyX windows.
    QCoreApplication::setApplicationName("LyX-Codex");
    activeBridge = new CodexBridge(app, socket);
}
}}
