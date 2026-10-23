// SPDX-License-Identifier: GPL-2.0-or-later
#ifndef LYX_CODEX_REVIEW_H
#define LYX_CODEX_REVIEW_H
#include <QJsonObject>
namespace lyx {
class Buffer;
namespace frontend {
class GuiApplication;
QJsonObject codexReviewState(Buffer & buffer, bool includeComments = false);
QJsonObject reviewCodexDocument(GuiApplication * app, QJsonObject const & params);
}}
#endif
