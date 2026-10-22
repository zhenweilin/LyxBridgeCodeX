// SPDX-License-Identifier: GPL-2.0-or-later
import {readFile, writeFile, copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const source = resolve(process.argv[2] ?? resolve(root,'.native/lyx-source'));
const commit=execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(commit!=='1d25832edcfde1eac543a7b7b82545319d79c1e3')throw new Error('Only the pinned LyX 2.4.1 commit is supported.');
const qt = resolve(source, 'src/frontends/qt');
for (const file of ['CodexBridge.h', 'CodexBridge.cpp','CodexFramePng.h','CodexSelectionEdit.h','CodexSelectionEdit.cpp']) await copyFile(resolve(root, 'native', file), resolve(qt, file));
let cpp = await readFile(resolve(qt, 'GuiApplication.cpp'), 'utf8');
if (!cpp.includes('#include "CodexBridge.h"')) cpp = '#include "CodexBridge.h"\n' + cpp;
if (!cpp.includes('startCodexBridge(this);')) cpp = cpp.replace('QCoreApplication::setApplicationName(lyx_package);', 'QCoreApplication::setApplicationName(lyx_package);\n\tstartCodexBridge(this);');
if (!cpp.includes('interceptCodexClipboard(this, cmd, dr)')) cpp = cpp.replace(
  '\tif (cmd.origin() == FuncRequest::LYXSERVER) {',
  '\tif (interceptCodexClipboard(this, cmd, dr)) return;\n\n\tif (cmd.origin() == FuncRequest::LYXSERVER) {');
// Confirmed browser text must continue an unfinished native shortcut instead
// of looking up only the top-level text binding in inputMethodEvent().
let applicationHeader=await readFile(resolve(qt,'GuiApplication.h'),'utf8');
if(!applicationHeader.includes('bool hasPendingCodexKeySequence() const;')){
  const anchor='\tbool queryKeySym(KeySymbol const & key, KeyModifier state) const;';
  if(!applicationHeader.includes(anchor))throw new Error('GuiApplication key query anchor changed');
  applicationHeader=applicationHeader.replace(anchor,`${anchor}\n\t/// Whether confirmed browser text should continue a native shortcut.\n\tbool hasPendingCodexKeySequence() const;`);
  await writeFile(resolve(qt,'GuiApplication.h'),applicationHeader);
}
if(!cpp.includes('bool GuiApplication::hasPendingCodexKeySequence() const')){
  const anchor='docstring GuiApplication::viewStatusMessage()';
  if(!cpp.includes(anchor))throw new Error('GuiApplication key sequence anchor changed');
  cpp=cpp.replace(anchor,'bool GuiApplication::hasPendingCodexKeySequence() const\n{\n\treturn d->meta_fake_bit != NoModifier\n\t\t|| (d->keyseq.length() > 0 && !d->keyseq.deleted());\n}\n\n\n'+anchor);
}
// Qt's MacExtras clipboard constructor dereferences a Cocoa native interface.
// The offscreen platform has none; retain the handler unchanged for Cocoa runs.
cpp = cpp.replace('QMacPasteboardMimeGraphics mac_pasteboard_mime_;',
  'std::unique_ptr<QMacPasteboardMimeGraphics> mac_pasteboard_mime_ = QApplication::platformName() == "cocoa" ? std::make_unique<QMacPasteboardMimeGraphics>() : nullptr;');
await writeFile(resolve(qt, 'GuiApplication.cpp'), cpp);
let clipboard = await readFile(resolve(qt, 'GuiClipboard.cpp'), 'utf8');
// LinkBack uses NSPasteboard directly; an offscreen editor must keep clipboard
// reads in its private Qt clipboard instead of probing the user's pasteboard.
clipboard = clipboard.replace('return isLinkBackDataInPasteboard();',
  'return QApplication::platformName() == "cocoa" && isLinkBackDataInPasteboard();');
await writeFile(resolve(qt, 'GuiClipboard.cpp'), clipboard);
// Stop LyX's own edge-scroll timer without delivering a mouse release to an
// inset or menu when browser pointer capture is interrupted.
let workAreaHeader = await readFile(resolve(qt,'GuiWorkArea.h'),'utf8');
if (!workAreaHeader.includes('void cancelCodexPointer();')) {
  const anchor = '\tvoid queryInputItemTransform();';
  if (!workAreaHeader.includes(anchor)) throw new Error('Cannot locate GuiWorkArea public methods');
  workAreaHeader = workAreaHeader.replace(anchor,anchor+'\n\t/// Cancel an interrupted offscreen pointer without activating its target.\n\tvoid cancelCodexPointer();');
  await writeFile(resolve(qt,'GuiWorkArea.h'),workAreaHeader);
}
let workAreaSource = await readFile(resolve(qt,'GuiWorkArea.cpp'),'utf8');
if (!workAreaSource.includes('void GuiWorkArea::cancelCodexPointer()')) {
  const anchor = 'void GuiWorkArea::mouseReleaseEvent(QMouseEvent * e)';
  if (!workAreaSource.includes(anchor)) throw new Error('Cannot locate GuiWorkArea mouse release');
  workAreaSource = workAreaSource.replace(anchor,`void GuiWorkArea::cancelCodexPointer()
{
\td->synthetic_mouse_event_.timeout.stop();
\td->synthetic_mouse_event_.restart_timeout = false;
\tdoubleClickTimeout();
\td->context_menu_name_.clear();
\td->buffer_view_->cursor().setClickPos(-1, -1);
\t// A motion with no button only updates hover and clears mouse_selecting_.
\td->buffer_view_->mouseEventDispatch(FuncRequest(LFUN_MOUSE_MOTION, 0, 0, mouse_button::none, NoModifier));
\tviewport()->update();
}


`+anchor);
}
workAreaSource = workAreaSource.replace(
  'FuncRequest(LFUN_MOUSE_MOTION, 0, 0, mouse_button::none)',
  'FuncRequest(LFUN_MOUSE_MOTION, 0, 0, mouse_button::none, NoModifier)');
await writeFile(resolve(qt,'GuiWorkArea.cpp'),workAreaSource);
// The macOS menu restriction assumes Cocoa's global menu bar, where a dialog
// can own focus while document menus stay accessible. Offscreen uses ordinary
// Qt popup menus: their focus must not make an open document look unavailable.
let viewSource = await readFile(resolve(qt, 'GuiView.cpp'), 'utf8');
const menuFocusCheck = 'if (cmd.origin() == FuncRequest::MENU && !hasFocus()) {';
const cocoaMenuFocusCheck = 'if (QApplication::platformName() == "cocoa"\n\t    && cmd.origin() == FuncRequest::MENU && !hasFocus()) {';
if (!viewSource.includes(cocoaMenuFocusCheck)) {
  if (!viewSource.includes(menuFocusCheck)) throw new Error('Cannot locate macOS menu focus restriction');
  viewSource = viewSource.replace(menuFocusCheck, cocoaMenuFocusCheck);
  await writeFile(resolve(qt, 'GuiView.cpp'), viewSource);
}
// Export the command identity, never infer clipboard behavior from translated
// menu labels. The property has no effect on normal LyX action dispatch.
let actionSource = await readFile(resolve(qt, 'Action.cpp'), 'utf8');
if (!actionSource.includes('codexClipboardAction')) {
  const anchor = '\tsetMenuRole(NoRole);';
  if (!actionSource.includes(anchor)) throw new Error('Cannot locate native Action initialization');
  actionSource = actionSource.replace('#include "Action.h"', '#include "Action.h"\n#include <QVariant>');
  actionSource = actionSource.replace(anchor, anchor + '\n\tif (func_->action() == LFUN_COPY || func_->action() == LFUN_CUT)\n\t\tsetProperty("codexClipboardAction", QString::fromLatin1(func_->action() == LFUN_COPY ? "copy" : "cut"));');
  await writeFile(resolve(qt, 'Action.cpp'), actionSource);
}
let bufferHeader = await readFile(resolve(source,'src/Buffer.h'),'utf8');
if(!bufferHeader.includes('void checkExternalModification();')){
  bufferHeader=bufferHeader.replace('bool notifiesExternalModification() const;',
    'bool notifiesExternalModification() const;\n\t/// Deliver a checksum-verified external change when native file events are unavailable.\n\tvoid checkExternalModification();');
  await writeFile(resolve(source,'src/Buffer.h'),bufferHeader);
}
let bufferSource = await readFile(resolve(source,'src/Buffer.cpp'),'utf8');
if(!bufferSource.includes('void Buffer::checkExternalModification()')){
  bufferSource=bufferSource.replace('void Buffer::clearExternalModification() const',
    'void Buffer::checkExternalModification()\n{\n\tif (!d->externally_modified_ && fileName().exists() && isChecksumModified())\n\t\td->fileExternallyModified(true);\n}\n\n\nvoid Buffer::clearExternalModification() const');
  await writeFile(resolve(source,'src/Buffer.cpp'),bufferSource);
}
// Upstream includes a Latin-1 copyright name; preserve its bytes while appending ASCII.
let cmake = await readFile(resolve(qt, 'CMakeLists.txt'), 'latin1');
if (!cmake.includes('# Codex native bridge')) cmake += '\n# Codex native bridge\nfind_package(Qt5 REQUIRED COMPONENTS Network)\ntarget_link_libraries(frontend_qt Qt5::Network)\n';
await writeFile(resolve(qt, 'CMakeLists.txt'), cmake, 'latin1');
console.log(`Applied native bridge to ${source}`);
