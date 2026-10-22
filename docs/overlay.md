# LyX source overlay

LyxBridgeCodeX supplements an official LyX checkout rather than redistributing the full LyX source tree. The native executable is compiled from that checkout plus this overlay; an ordinary unpatched LyX binary cannot provide the bridge.

## Upstream identity

- Repository: https://codeberg.org/LyX-org/lyx
- Tag: `2.4.1`
- Required Git commit: `1d25832edcfde1eac543a7b7b82545319d79c1e3`
- Native build currently targets Qt 5.15 on macOS Apple Silicon.

Use a dedicated checkout. Both the build and standalone patch script reject a different commit before changing files. Patches may be reapplied to this pinned checkout; changes are idempotent. If you have your own LyX modifications, review the patch script and use a separate checkout to avoid mixing them.

## Applying the overlay

```sh
git clone --branch 2.4.1 --depth 1 https://codeberg.org/LyX-org/lyx.git ../lyx-2.4.1
LYX_SOURCE_DIR="$(cd ../lyx-2.4.1 && pwd)" npm run build:native
```

For inspection without compiling:

```sh
node scripts/patch-native.mjs ../lyx-2.4.1
git -C ../lyx-2.4.1 diff --stat
git -C ../lyx-2.4.1 status --short
```

The patch script copies `CodexBridge.h/.cpp`, `CodexSelectionEdit.h/.cpp`, and `CodexFramePng.h` into `src/frontends/qt/`. It changes `GuiApplication.h/.cpp`, `GuiClipboard.cpp`, `GuiView.cpp`, `GuiWorkArea.h/.cpp`, `Action.cpp`, the Qt frontend `CMakeLists.txt`, and `Buffer.h/.cpp`. These changes start the authenticated local bridge, support offscreen input/clipboard behavior, expose guarded selection edits, and handle native external-file notifications.

The native build writes `.native/engine.json` with the selected source, library, and executable paths. The Codex plugin then starts the compiled engine using a private LyX profile. Keep the upstream checkout and its `lib/` directory available at those paths. Do not delete or move them while engines are running. An existing CMake build directory is tied to its source path; use a fresh checkout of this overlay when switching upstream source directories.

## Package boundaries

Release archives contain only this repository's overlay, plugin, scripts, tests, and synthetic sample. They exclude the upstream checkout, Qt, TeX, compiled engines, npm dependencies, generated bundles, profiles, logs, document sessions, and local paths. Installation/build tools obtain or generate those components on the recipient's machine. Small downloads do not imply a small compiler toolchain or native build directory.

The root Apache license covers the web/server portion; native code and the patch script are GPL-2.0-or-later. Compiling the overlay into LyX retains the applicable LyX licensing requirements; describing it as an overlay does not change them. See `LICENSES.md`.
