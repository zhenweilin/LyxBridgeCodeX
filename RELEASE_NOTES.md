# LyxBridgeCodeX v0.3.0 (unreleased)

Experimental LyX source overlay and Codex plugin for macOS Apple Silicon. Source is available in the repository; packaged releases remain on hold while testing continues.

- Real LyX 2.5.3 editing in a Codex side panel, including editable formulas, native undo, and familiar shortcuts.
- Versioned native builds support upgrading from 2.4.1 without interrupting open sessions. LyX 2.4 files import normally; saves use format 643. Private preferences prefer the 2.5 profile, with a 2.4 fallback.
- Pure LaTeX pseudocode templates in the environment chooser, native rendered previews, and a complete PDF tutorial in `demo/`.
- Native recovery snapshots run every minute while changes are unsaved; use Save to update the main `.lyx` file.
- Environment lists and native menus fit the editor panel, with scrolling for long lists and menu reflow after resizing.
- The hidden keyboard input no longer changes the browser's scrollable area when the LyX caret moves offscreen.
- Faster scrolling through lossless PNG encoding and a combined input/state MCP request. Native changed-frame median latency fell by about 41% in the second local comparison; complete Codex input-to-display latency remains unmeasured. See `docs/scroll-performance.md`.
- Browser-confirmed printable keys complete native shortcut sequences, including Control-P followed by Space or a letter; the environment chooser supports navigation, acceptance and cancellation.
- **add to chat** attaches only selection context. No text is inserted into the composer and no message is automatically sent.
- Read and replace native unsaved selections with revision and input-state guards.
- Portable local configuration, Qt-prefix detection, support for an existing pinned LyX source checkout, a self-contained example, build scripts, compact overlay archives, and SHA-256 checksums.

**Tested Codex desktop: 26.1016.51333 (build 21161).** Plugin-installation CLI: 0.163.0-alpha.11. Native environment: macOS 26.7.1 arm64, Qt 5.15.2. These identify verified environments; other versions and platforms are not guaranteed.

Clone the repository and follow its README. Node/npm, Qt 5.15 development files, CMake, compiler tooling, and LyX's build dependencies are required. Provide an official LyX 2.5.3 Git checkout at the pinned commit via `LYX_SOURCE_DIR`, or let the build fetch it. Web resources and the native engine are built locally. Upstream LyX source, compiled engines, Qt, node_modules, and generated bundles are excluded. This is not a signed installer or a self-contained application binary.

Known limits include Fusion styling, keyboard-only system paste in the tested host, no native file dropping, and incomplete OS input-method/trackpad coverage. Native edits do not automatically save. See `docs/compatibility.md` for details.
