# License scope and third-party software

- The root `LICENSE` retains the Apache License 2.0 selected for this repository. It applies to original JavaScript, tests, documentation, and the synthetic sample documents unless a file says otherwise.
- `native/CodexBridge.{h,cpp}`, `native/CodexSelectionEdit.{h,cpp}`, `native/CodexPseudocode.{h,cpp}`, `native/CodexFramePng.h`, and `scripts/patch-native.mjs` are GPL-2.0-or-later. `native/COPYING` contains the LyX notice and GPL version 2 text. These files form or modify the component compiled into LyX.
- The native build obtains LyX 2.5.3, commit `b6a54136e3fb519bfc25e32431801a6cf6992b3a`, from https://codeberg.org/LyX-org/lyx. LyX is GPL-2.0-or-later; its source distribution carries additional notices for bundled components.
- Qt and the other native build dependencies retain their own licenses. This release does not distribute their binaries or a precompiled LyX executable.
- npm dependencies retain their individual licenses. The overlay includes the lockfile but no npm packages, generated bundles, or fonts. `npm ci` obtains dependencies with their notices. Generated web resources include third-party code and fonts; retain the corresponding dependency notices if distributing those generated resources separately.

The source package includes the native bridge and patch script required to reproduce this modified LyX build. Before separately redistributing a compiled engine or its dependencies, include the notices and corresponding source required for those particular artifacts. The current release is a source distribution.
