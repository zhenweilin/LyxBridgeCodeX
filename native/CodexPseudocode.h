// SPDX-License-Identifier: GPL-2.0-or-later
#ifndef LYX_CODEX_PSEUDOCODE_H
#define LYX_CODEX_PSEUDOCODE_H
#include <QStringList>
namespace lyx {
class BufferView;
class FuncRequest;
class DispatchResult;
namespace frontend {
class GuiApplication;
QStringList codexPseudocodeEntries(BufferView const * view);
bool codexPseudocodeSource(BufferView const * view);
bool dispatchCodexPseudocode(GuiApplication *, FuncRequest const &, DispatchResult &);
}}
#endif
