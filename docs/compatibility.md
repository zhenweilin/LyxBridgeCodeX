# Compatibility and known limitations

Verified desktop host on October 22, 2026: **Codex 26.1016.51333 (build 21161)**. The installation CLI was **0.163.0-alpha.11**. The desktop and CLI versions identify different components; installing the CLI alone does not supply the required MCP App panel.

The current integration uses `@openai/mcp-extensions` 0.2.1 and `@modelcontextprotocol/ext-apps` 1.7.5, pinned in the lockfile. The host must expose model-context updates. The HTML native-editor resource keeps its v3 address and v4 alias for compatibility with previously cached entry points.

## Covered workflows

Native text/formula editing, undo/redo, clipboard formulas, tables, citations, references, image paste, native dialogs, guarded model edits, and selection context have automated or interactive verification. Manual checks confirmed typing, undo, formula shortcuts, and editable formula paste in the actual Codex panel. Historical verification does not imply that every workflow has been tested on every platform or host release.

## Limits

- Native widgets use Fusion styling, not macOS Cocoa styling.
- Menu Paste cannot read the system clipboard in the tested Codex sandbox. Use the keyboard paste event, normally Command-V.
- Native file drag-and-drop is not implemented; the available browser file interface does not supply authoritative original paths and sibling assets.
- OS input-method candidate windows, physical trackpad gestures, and all host-intercepted shortcuts have not been exhaustively verified.
- A selected context updates the panel's previous attachment. It does not accumulate an unlimited history of selections and does not include the complete document source. Codex can request a fresh unsaved document snapshot when needed.
- The tested host disables **Steer** for an app-context message while a response is in progress. Wait for that response to finish and submit your request normally. Attaching context does not submit it.
- Model replacement checks the current path, revision, selection, and pending input. It supports selected text and a selection within one math cell, not arbitrary replacements spanning table or matrix cells. A changed selection requires a new read.
- A successful edit enters native undo history but does not automatically save. After an uncertain tool result, read the document before retrying.
- External disk changes use native reload and save-conflict behavior. They are not automatically merged into unsaved editor content.
- The private preference-copy default follows the macOS LyX 2.4 profile location. `LYX_USER_PROFILE` can select another profile. Other operating systems are unverified.
- A broker listens on loopback port 43128 and authenticates requests. Existing sessions are intentionally preserved across frontend updates. Resolve unsaved work before stopping a broker or native process.

## Reporting a problem

Include the LyxBridgeCodeX release, desktop Codex version and build, operating system/architecture, Qt version, and whether the problem occurs in the connected plugin panel or the standalone debug view. Use a small synthetic document when possible. Do not publish `.native/broker.json`, local session logs, document snapshots, or credentials.
