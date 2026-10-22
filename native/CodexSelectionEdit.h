// SPDX-License-Identifier: GPL-2.0-or-later
#ifndef LYX_CODEX_SELECTION_EDIT_H
#define LYX_CODEX_SELECTION_EDIT_H

#include <QJsonObject>

namespace lyx { namespace frontend {
class GuiApplication;
// Called on the Qt thread. Checks and mutation share one synchronous operation.
QJsonObject editCodexSelection(GuiApplication * app, QJsonObject const & params);
}}
#endif
