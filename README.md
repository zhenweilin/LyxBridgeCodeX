# LyxBridgeCodeX

Native LyX editing inside Codex, with editable formulas and document context sharing.

**v0.3.0 is an experimental source overlay for LyX 2.4.1, plus a Codex plugin.** It supplements official LyX source with a native editing bridge and presents that engine in a Codex side panel. This repository does not vendor the full LyX source or distribute a compiled application. Build the engine locally; this is not a standalone installer or a signed macOS application.

## Features

- Edit text and formulas using LyX's own document model, rendering, menus, and undo history.
- Keep familiar keyboard shortcuts, including formula entry and undo.
- Copy and paste native LyX content while retaining editable formulas.
- Select text or a formula and click **add to chat** to attach context to the next message. It inserts no text into the composer and does not send a message.
- Let Codex read the current unsaved document and replace a selection with revision and input-state checks.

The interface is English. Document language is independent of interface language. Each selection update replaces the previous context for that panel; it is not a growing collection of selections.

## Tested versions

| Component | Verified version |
| --- | --- |
| **Codex desktop host** | **26.1016.51333 (build 21161)** |
| Codex CLI used for plugin installation | 0.163.0-alpha.11 |
| macOS / architecture | 26.7.1 / Apple Silicon arm64 |
| LyX source / format | 2.4.1 / LyX 2.4 format 620 |
| Qt development libraries | 5.15.2 |
| Node.js used locally | 23.11.0 |

These are tested versions, not a guarantee for every earlier or later Codex release. The desktop host must support plugin file entry points, MCP Apps, and OpenAI model-context extensions. CLI-only use does not provide the side-panel editor. Windows, Linux, and Intel macOS native editing have not been verified. See [compatibility and limitations](docs/compatibility.md).

## Build and install

Prerequisites: the Codex desktop app and CLI, Node.js 22 or newer with npm, Git, CMake, a C++ compiler (Xcode Command Line Tools on macOS), Python 3, and a complete Qt **5.15** development installation. The native CMake build also needs its usual LyX dependencies, including zlib, iconv, and Hunspell development files. A TeX distribution is needed for LyX PDF compilation/export.

Clone the repository. Packaged releases are currently on hold while testing continues:

```sh
git clone https://github.com/zhenweilin/LyxBridgeCodeX.git
cd LyxBridgeCodeX
npm ci
npm run build
```

To use your own upstream source checkout, first obtain the exact supported revision, then point the build at it:

```sh
git clone --branch 2.4.1 --depth 1 https://codeberg.org/LyX-org/lyx.git ../lyx-2.4.1
LYX_SOURCE_DIR="$(cd ../lyx-2.4.1 && pwd)" npm run build:native
```

The script validates commit `1d25832edcfde1eac543a7b7b82545319d79c1e3` before patching. Use a dedicated Git checkout; other revisions and source archives without Git metadata are not accepted. It copies five bridge files and applies small, repeatable edits to the upstream build and Qt frontend. Build output stays under this repository's ignored `.native/` directory. See [the overlay contract](docs/overlay.md).

For convenience, omit `LYX_SOURCE_DIR` to download that checkout automatically. If Qt 5.15's `qmake` is on `PATH`, the build detects its installation prefix:

```sh
npm run build:native
```

Otherwise provide the prefix explicitly:

```sh
LYX_QT_PREFIX=/path/to/qt-5.15 npm run build:native
```

Both paths apply the same overlay and do not replace your desktop LyX installation. You may combine `LYX_SOURCE_DIR` and `LYX_QT_PREFIX` in one command.

Generate this checkout's local plugin configuration and install it:

```sh
npm run configure
codex plugin marketplace add "$PWD"
codex plugin add lyx-preview@lyxbridgecodex
```

`lyx-preview` is the retained internal plugin identifier. The display name is **LyxBridgeCodeX**. Configuration records the current Node executable and checkout path in an ignored `.mcp.json`. Keep this checkout in place; after moving it or changing Node installations, rerun configuration and plugin installation. The GitHub repository is a source distribution, not a ready-to-run remote marketplace installation.

Open `demo/demo.lyx` in Codex, or ask Codex to open a local `.lyx` file through the plugin. The footer should say **Connected to this chat**. Select content and use **add to chat**, then type your request in Codex and submit it normally. Save in LyX when you want changes written to disk. `npm run editor` opens a local debugging view without chat integration.

If Codex has not loaded a newly installed plugin, save your work and restart the desktop app. Merely reopening the debugging browser does not connect it to chat. Existing native engines can retain older capabilities; resolve unsaved edits before closing or replacing them.

## Development and verification

```sh
npm test
npm run test:native
npm run package:release
```

Unit/protocol tests require the web build but not the native build. Native integration tests start disposable LyX sessions and require the built engine. The public sample and fixtures are synthetic, self-contained documents. `package:release` creates compact overlay archives and SHA-256 checksums in `release/`; it excludes upstream LyX source, native binaries, generated web bundles, dependencies, local configuration, logs, and sessions. Run `npm ci` and `npm run build` after extraction. GitHub Actions publishes these assets for version tags after the unit/protocol tests pass.

## Architecture

`native/` is compiled into LyX. A local broker owns independent editing processes and authenticated sockets; the iframe receives no broker credentials. `server/mcp.mjs` provides file entry points and guarded read/edit tools. `web/native-app.mjs` displays native frames and forwards editing input. A separate HTML/KaTeX preview is retained for diagnostics.

Native engines use a private copy of your LyX preferences, preserving fonts and key bindings. The bridge uses Qt's offscreen platform and Fusion styling. It is not a pixel-identical Cocoa window. Running document sessions are not automatically restarted by plugin updates.

## License

The web/server JavaScript, tests, and documentation use the repository's [Apache License 2.0](LICENSE). The native bridge and native-source patch script use [GPL-2.0-or-later](native/COPYING), as marked in their source files, and are compiled into GPL-licensed LyX. See [license scope and third-party notices](LICENSES.md). This is an independent project, not an official OpenAI or LyX product.
