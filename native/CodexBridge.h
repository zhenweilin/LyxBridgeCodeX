// SPDX-License-Identifier: GPL-2.0-or-later
#ifndef LYX_CODEX_BRIDGE_H
#define LYX_CODEX_BRIDGE_H
namespace lyx {
class FuncRequest;
class DispatchResult;
namespace frontend {
class GuiApplication;
void startCodexBridge(GuiApplication * app);
bool interceptCodexClipboard(GuiApplication * app, FuncRequest const & request, DispatchResult & result);
}}
#endif
