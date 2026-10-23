// SPDX-License-Identifier: GPL-2.0-or-later
#ifndef LYX_CODEX_SELECTION_EDIT_H
#define LYX_CODEX_SELECTION_EDIT_H

#include <QJsonObject>

namespace lyx { namespace frontend {
class GuiApplication;
// Called on the Qt thread. Checks and mutation share one synchronous operation.
QJsonObject editCodexSelection(GuiApplication * app, QJsonObject const & params);
// Compact, session-local targets survive cursor movement, never document edits.
QJsonObject captureCodexSelection(GuiApplication * app);
QJsonObject editCodexSnapshot(GuiApplication * app, QJsonObject const & params);
QJsonObject captureCodexColorTarget(GuiApplication * app);
QJsonObject applyCodexColor(GuiApplication * app, QJsonObject const & params);
}}
namespace lyx {
class BufferView;
namespace frontend {
QJsonObject codexDocumentSnapshot(BufferView & view);
}}
#endif
