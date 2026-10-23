# LyX source overlay

LyxBridgeCodeX supplements an official LyX checkout rather than redistributing the full LyX source tree. The native executable is compiled from that checkout plus this overlay; an ordinary unpatched LyX binary cannot provide the bridge.

## Upstream identity

- Repository: https://codeberg.org/LyX-org/lyx
- Tag: `2.5.3`
- Required Git commit: `b6a54136e3fb519bfc25e32431801a6cf6992b3a`
- Native build currently targets Qt 5.15 on macOS Apple Silicon.
- Include QtGui's matching private/QPA development headers. The bridge uses the screen-geometry notification API to make Qt lay out native popup menus within the embedded panel; this applies only to the private offscreen engine.

Use a dedicated checkout. Both the build and standalone patch script reject a different commit before changing files. Patches may be reapplied to this pinned checkout; changes are idempotent. If you have your own LyX modifications, review the patch script and use a separate checkout to avoid mixing them.

## Applying the overlay

```sh
git clone --branch 2.5.3 --depth 1 https://codeberg.org/LyX-org/lyx.git ../lyx-2.5.3
LYX_SOURCE_DIR="$(cd ../lyx-2.5.3 && pwd)" npm run build:native
```

For inspection without compiling:

```sh
node scripts/patch-native.mjs ../lyx-2.5.3
git -C ../lyx-2.5.3 diff --stat
git -C ../lyx-2.5.3 status --short
```

The patch script copies `CodexBridge.h/.cpp`, `CodexSelectionEdit.h/.cpp`, `CodexPseudocode.h/.cpp`, `CodexFramePng.h`, and `CodexPanelStyle.h` into `src/frontends/qt/`. It changes `GuiApplication.h/.cpp`, `GuiClipboard.cpp`, `GuiInputMethod.cpp`, `GuiView.cpp`, `GuiWorkArea.h/.cpp`, `Action.cpp`, `LayoutBox.cpp`, `Menus.cpp`, the Qt frontend `CMakeLists.txt`, `Buffer.h/.cpp`, `InsetPreview.cpp`, `legacy_lyxpreview2ppm.py`, and `lyxpreview_tools.py`. These changes start the authenticated local bridge, support offscreen input/clipboard behavior, expose guarded selection edits, and handle native external-file notifications. The 2.5 adapter preserves selected text during provisional browser composition, supplies complete preedit formatting ranges, and consumes application-wide redraw flags before a server-dispatched zoom updates the current view.

Pseudocode commands are embedded-editor-only entries in the native environment dropdown. They insert standard Preview and raw-LaTeX (ERT) insets, preserving portable `.lyx` files and ordinary LaTeX export. The bridge enables text previews while retaining native formula editing. Preview macro collection includes native document math macros referenced by raw LaTeX. A second TeX pass resolves the positions of `algpseudocodex` indent guides. The legacy PPM preview fallback uses checked subprocess calls and rewinds temporary output before replacing an image; a failed crop preserves the original image.

Browser pinch zoom is clamped to LyX's own minimum and maximum before dispatch; LyX 2.5 otherwise rejects gestures that exceed those limits. This change applies only to the embedded engine.

The default source and build directories are `.native/lyx-source-2.5.3` and `.native/build-engine-2.5.3`. The build writes `.native/engine-2.5.3.json`, then atomically activates it as `.native/engine.json`. Set `LYX_NATIVE_ACTIVATE=0` to build and inspect a candidate without changing the active manifest. Tests can select the candidate using `LYX_CODEX_BINARY` and `LYX_CODEX_LIBRARY`.

The Codex plugin starts new engines from the active manifest using a private LyX profile. Existing document sessions continue using their current engine. Keep both the upstream checkout and its `lib/` directory available while those engines run. Versioned directories preserve older installations during upgrades. An existing CMake build directory is tied to its source path; changing a custom `LYX_SOURCE_DIR` requires a fresh build directory.

LyX 2.5.3 reads 2.4 documents (format 620) and saves format 643. Opening an old document does not rewrite its file. The supplied demo and test fixtures intentionally retain format 620 to exercise migration. Use LyX's older-format export when a document must be shared with LyX 2.4.

## Package boundaries

Release archives contain only this repository's overlay, plugin, scripts, tests, and synthetic sample. They exclude the upstream checkout, Qt, TeX, compiled engines, npm dependencies, generated bundles, profiles, logs, document sessions, and local paths. Installation/build tools obtain or generate those components on the recipient's machine. Small downloads do not imply a small compiler toolchain or native build directory.

The root Apache license covers the web/server portion; native code and the patch script are GPL-2.0-or-later. Compiling the overlay into LyX retains the applicable LyX licensing requirements; describing it as an overlay does not change them. See `LICENSES.md`.
