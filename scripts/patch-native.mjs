// SPDX-License-Identifier: GPL-2.0-or-later
import {readFile, writeFile, copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {lyxUpstream} from '../lib/native-engine.mjs';
import {patchSourceLabels} from './patch-source-labels.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const source = resolve(process.argv[2] ?? resolve(root,`.native/lyx-source-${lyxUpstream.version}`));
const commit=execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(commit!==lyxUpstream.commit)throw new Error(`Only the pinned LyX ${lyxUpstream.version} commit is supported.`);
await patchSourceLabels(root,source);
const qt = resolve(source, 'src/frontends/qt');
for (const file of ['CodexBridge.h', 'CodexBridge.cpp','CodexFramePng.h','CodexPanelStyle.h','CodexSelectionEdit.h','CodexSelectionEdit.cpp','CodexPseudocode.h','CodexPseudocode.cpp']) await copyFile(resolve(root, 'native', file), resolve(qt, file));
let cpp = await readFile(resolve(qt, 'GuiApplication.cpp'), 'utf8');
if (!cpp.includes('#include "CodexBridge.h"')) cpp = '#include "CodexBridge.h"\n' + cpp;
if (!cpp.includes('#include "CodexPseudocode.h"')) cpp = '#include "CodexPseudocode.h"\n' + cpp;
if (!cpp.includes('dispatchCodexPseudocode(this, cmd, dr)')) {
  const anchor='\t// we have not done anything wrong yet.\n\tdr.setError(false);';
  if (!cpp.includes(anchor)) throw new Error('Cannot locate native dispatch initialization');
  cpp=cpp.replace(anchor,anchor+'\n\tif (dispatchCodexPseudocode(this, cmd, dr)) return;');
}
if (!cpp.includes('startCodexBridge(this);')) cpp = cpp.replace('QCoreApplication::setApplicationName(lyx_package);', 'QCoreApplication::setApplicationName(lyx_package);\n\tstartCodexBridge(this);');
if (!cpp.includes('interceptCodexClipboard(this, cmd, dr)')) cpp = cpp.replace(
  '\tif (cmd.origin() == FuncRequest::LYXSERVER) {',
  '\tif (interceptCodexClipboard(this, cmd, dr)) return;\n\n\tif (cmd.origin() == FuncRequest::LYXSERVER) {');
// The bridge uses server dispatch. LyX 2.5 zoom now requests ForceAll, which
// must be consumed at application level before updating a single BufferView.
if (!cpp.includes('// Codex: consume application-wide server updates.')) {
  const anchor='\tif (cmd.origin() == FuncRequest::LYXSERVER)\n\t\tupdateCurrentView(cmd, dr);';
  if (!cpp.includes(anchor)) throw new Error('Cannot locate native server dispatch update');
  cpp=cpp.replace(anchor,`\tif (cmd.origin() == FuncRequest::LYXSERVER) {
\t\t// Codex: consume application-wide server updates.
\t\tif (dr.screenUpdate() & Update::ForceAll) {
\t\t\tfor (Buffer const * b : theBufferList())
\t\t\t\tb->changed(true);
\t\t\tdr.screenUpdate(dr.screenUpdate() & ~Update::ForceAll);
\t\t}
\t\tupdateCurrentView(cmd, dr);
\t}`);
}
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
let layoutBox=await readFile(resolve(qt,'LayoutBox.cpp'),'utf8');
if(!layoutBox.includes('#include "CodexPseudocode.h"')){
  layoutBox='#include "CodexPseudocode.h"\n'+layoutBox;
  const anchor='\tset(d->owner_.currentBufferView()->cursor().innerParagraph().layout().name());';
  if(!layoutBox.includes(anchor))throw new Error('Cannot locate layout list population');
  layoutBox=layoutBox.replace(anchor,'\tfor (QString const & name : codexPseudocodeEntries(bv))\n\t\taddItemSort(qstring_to_ucs4(name), from_ascii("LaTeX Pseudocode"), false, true, false);\n\n'+anchor);
  layoutBox=layoutBox.replace('lyx::getStatus(FuncRequest(LFUN_LAYOUT)).enabled());',
    '(lyx::getStatus(FuncRequest(LFUN_LAYOUT)).enabled() || codexPseudocodeSource(bv)));');
  layoutBox=layoutBox.replace('if (d->text_class_->hasLayout(layoutName)) {',
    'if (d->text_class_->hasLayout(layoutName)\n\t    || codexPseudocodeEntries(d->owner_.currentBufferView()).contains(qlayout)) {');
  await writeFile(resolve(qt,'LayoutBox.cpp'),layoutBox);
}
// Raw LaTeX has no math AST for usedMacros(). Carry document-defined macros
// into Preview snippets as well, using the same scope lookup as native math.
const insetPreviewPath=resolve(source,'src/insets/InsetPreview.cpp');
let insetPreview=await readFile(insetPreviewPath,'utf8');
if(!insetPreview.includes('// Codex: macros used by raw LaTeX previews.')){
  const anchor='\t\tInsetMath * im = dit.nextInset()->asInsetMath();';
  if(!insetPreview.includes(anchor))throw new Error('Cannot locate preview macro collection');
  insetPreview=insetPreview.replace(anchor,`\t\t// Codex: macros used by raw LaTeX previews.
\t\tif (dit.nextInset()->lyxCode() == ERT_CODE) {
\t\t\tfor (auto const & name : macros) {
\t\t\t\tif (MacroData const * data = buffer->getMacro(name, inset->asInsetText()->text().macrocontextPosition(), true)) {
\t\t\t\t\todocstringstream definition;
\t\t\t\t\tdata->write(definition, true);
\t\t\t\t\tdefinition << endl;
\t\t\t\t\tdefs.insert(definition.str());
\t\t\t\t}
\t\t\t}
\t\t}
`+anchor);
  await writeFile(insetPreviewPath,insetPreview);
}
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
  const anchor = '\tvoid queryInputItemGeometry();';
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
// Browser preedit is provisional: keep the native selection and source intact
// until commit. The normal self-insert dispatch then replaces the selection.
const inputMethodPath=resolve(qt,'GuiInputMethod.cpp');
let inputMethod=await readFile(inputMethodPath,'utf8');
const preeditCut='if (d->cur_->selection() && !ev->preeditString().isEmpty()) {';
const guardedPreeditCut='if (d->cur_->selection() && !ev->preeditString().isEmpty()\n\t    && qEnvironmentVariableIsEmpty("LYX_CODEX_SOCKET")) {';
if(!inputMethod.includes(guardedPreeditCut)){
  if(!inputMethod.includes(preeditCut))throw new Error('Cannot locate native provisional selection handling');
  inputMethod=inputMethod.replace(preeditCut,guardedPreeditCut);
  await writeFile(inputMethodPath,inputMethod);
}
// The macOS menu restriction assumes Cocoa's global menu bar, where a dialog
// can own focus while document menus stay accessible. Offscreen uses ordinary
// Qt popup menus: their focus must not make an open document look unavailable.
let viewSource = await readFile(resolve(qt, 'GuiView.cpp'), 'utf8');
// LyX 2.5 rejects out-of-range zoom commands before dispatch. Browser pinch
// gestures must saturate at the native limits instead of being ignored.
if (!viewSource.includes('// Codex: clamp browser pinch to the native zoom range.')) {
  const anchor='void GuiView::zoomValueChanged(int value)\n{\n';
  if (!viewSource.includes(anchor)) throw new Error('Cannot locate native zoom slot');
  viewSource=viewSource.replace(anchor,anchor+`\t// Codex: clamp browser pinch to the native zoom range.
\tif (!qEnvironmentVariableIsEmpty("LYX_CODEX_SOCKET"))
\t\tvalue = qBound(zoom_min_, value, zoom_max_);
`);
}
const menuFocusCheck = 'if (cmd.origin() == FuncRequest::MENU && !hasFocus()) {';
const cocoaMenuFocusCheck = 'if (QApplication::platformName() == "cocoa"\n\t    && cmd.origin() == FuncRequest::MENU && !hasFocus()) {';
if (!viewSource.includes(cocoaMenuFocusCheck)) {
  if (!viewSource.includes(menuFocusCheck)) throw new Error('Cannot locate macOS menu focus restriction');
  viewSource = viewSource.replace(menuFocusCheck, cocoaMenuFocusCheck);
}
await writeFile(resolve(qt, 'GuiView.cpp'), viewSource);
// Keep native menu identities available to offscreen system shortcuts without
// matching translated titles or constructing duplicate popup menus.
const menusPath=resolve(qt,'Menus.cpp');
let menusSource=await readFile(menusPath,'utf8');
if(!menusSource.includes('setProperty("codexMenuName", name);')){
  const anchor='\td->name = name;\n\tsetTitle(name);';
  if(!menusSource.includes(anchor))throw new Error('Cannot locate native menu identity');
  menusSource=menusSource.replace(anchor,anchor+'\n\tsetProperty("codexMenuName", name);');
  await writeFile(menusPath,menusSource);
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
// QPA screen geometry is private to this offscreen engine. Qt's native menus
// must lay out and scroll against the browser panel, not a fixed virtual screen.
if (!cmake.includes('Qt5::GuiPrivate')) cmake = cmake.replace(
  'target_link_libraries(frontend_qt Qt5::Network)',
  'target_link_libraries(frontend_qt Qt5::Network Qt5::GuiPrivate)');
await writeFile(resolve(qt, 'CMakeLists.txt'), cmake, 'latin1');
// LyX 2.5 replaced pipes, but its fallback passes an unsplit command to run()
// and never rewinds the output. Preserve checked, shell-free cropping.
const previewScript=resolve(source,'lib/scripts/legacy_lyxpreview2ppm.py');
let previewPython=await readFile(previewScript,'utf8');
if(!previewPython.includes('# Codex: checked preview cropping.')){
  if(!previewPython.includes("conv_call = f'{pnmcrop} -left -right -- {file}'"))
    throw new Error('Cannot locate upstream preview crop command');
  const start=previewPython.indexOf('def crop_files(pnmcrop, basename):');
  const end=previewPython.indexOf('\n\ndef legacy_conversion(',start);
  if(start<0||end<0)throw new Error('Cannot locate legacy preview crop function');
  previewPython=previewPython.slice(0,start)+`def crop_files(pnmcrop, basename):
    # Codex: checked preview cropping.
    for file in glob.glob("%s*.ppm" % basename):
        with tempfile.TemporaryFile() as left, tempfile.TemporaryFile() as right:
            with open(file, "rb") as original:
                subprocess.run([pnmcrop, "-left"], stdin=original, stdout=left, check=True)
            left.seek(0)
            subprocess.run([pnmcrop, "-right"], stdin=left, stdout=right, check=True)
            right.seek(0)
            with open(file, "wb") as output:
                copyfileobj(right, output)
`+previewPython.slice(end);
  await writeFile(previewScript,previewPython);
}
// TikZ-based indent guides need saved positions from a second TeX pass.
const previewToolsPath=resolve(source,'lib/scripts/lyxpreview_tools.py');
let previewTools=await readFile(previewToolsPath,'utf8');
if(!previewTools.includes('# Codex: resolve algpseudocodex guide positions.')){
  const anchor='    latex_status, latex_stdout = run_tex(latex, latex_file)\n\n    if bibtex is None:';
  if(!previewTools.includes(anchor))throw new Error('Cannot locate preview TeX execution');
  previewTools=previewTools.replace(anchor,`    latex_status, latex_stdout = run_tex(latex, latex_file)

    # Codex: resolve algpseudocodex guide positions.
    if not latex_status and string_in_file(r"algpseudocodex\\.sty", latex_file_re.sub(".log", latex_file)):
        latex_status, latex_stdout = run_tex(latex, latex_file)

    if bibtex is None:`);
  await writeFile(previewToolsPath,previewTools);
}
console.log(`Applied native bridge to ${source}`);
