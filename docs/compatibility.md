# Compatibility and known limitations

Verified desktop host on October 22, 2026: **Codex 26.1016.51333 (build 21161)**. The installation CLI was **0.163.0-alpha.11**. The desktop and CLI versions identify different components; installing the CLI alone does not supply the required MCP App panel.

The installed host inspected later on the same date was **26.1016.62342 (build 21477)**, with bundled CLI **0.163.0-alpha.11.2**. Its file-opening contract was checked in the application resources; the earlier manual interaction results do not establish a complete UI verification of this newer build. The file-open tool's `queued` response is an acknowledgement, not a success or failure result. Display the target chat in the main window and confirm the actual panel.

The current integration uses `@openai/mcp-extensions` 0.2.1 and `@modelcontextprotocol/ext-apps` 1.7.5, pinned in the lockfile. The host must expose model-context updates. The HTML native-editor resource keeps its v3 address and v4 alias for compatibility with previously cached entry points.

The integration uses a [file entrypoint](https://developers.openai.com/plugins/build/extensions). Keep `.lyx` in this SDK version's extension list: its schema requires a leading dot, and the inspected host normalizes both dotted and undotted forms. The host resource cache refreshes on mounting; an already-mounted iframe keeps its loaded JavaScript until reopened.

The supported native baseline is LyX **2.5.3**, pinned to commit `b6a54136e3fb519bfc25e32431801a6cf6992b3a`, with Qt 5.15.2. It imports LyX 2.4 files (format 620); saving writes format 643. Source/build directories are versioned, and an upgrade changes the engine for newly opened sessions. Existing windows keep their running engine until reopened.

## Updating a running checkout

The web panel, MCP service, broker, and native editors have separate lifetimes. Rebuilding the web resources updates panels mounted afterward, but an existing MCP service retains its registered tools and JavaScript. Reinstalling the plugin registration alone does not prove that the host reconnected that service. The broker runs independently of Codex and may also retain older code after the host restarts.

Save every document you need, including hidden LyX tabs, before deliberately closing old editing sessions for a backend update. A copy of the active document does not preserve other buffers or undo history. Do not delete the broker registry or kill processes merely to clear an opening error: the old processes may still own unsaved documents. Keep existing sessions until a controlled update is appropriate, then verify the newly connected service and a newly opened editor together.

For current-host acceptance, verify the visible plugin panel and its **Connected to this chat** footer, edit and undo text, paste an editable formula, scroll in the actual side panel, and attach a selection while preserving a draft. A standalone debug page or a successful build does not verify the host's relay, clipboard, or chat-context behavior.

## Covered workflows

Native text/formula editing, undo/redo, clipboard formulas, tables, citations, references, image paste, native dialogs, guarded model edits, and selection context have automated or interactive verification. Manual checks confirmed typing, undo, formula shortcuts, and editable formula paste in the actual Codex panel. Historical verification does not imply that every workflow has been tested on every platform or host release.

## Limits

- Native widgets retain a Fusion base with macOS-inspired flat chrome and arrowless rounded scrollbars. The full Macintosh widget style crashes under the tested offscreen platform, so this is not a Cocoa window. Native scrollbar hit regions match their appearance; the wider fixed gutter remains draggable without layout changes on hover.
- Menu Paste cannot read the system clipboard in the tested Codex sandbox. Use the keyboard paste event, normally Command-V.
- Native file drag-and-drop is not implemented; the available browser file interface does not supply authoritative original paths and sibling assets.
- OS input-method candidate windows, physical trackpad gestures, and all host-intercepted shortcuts have not been exhaustively verified.
- A selected context updates the panel's previous attachment. It does not accumulate an unlimited history of selections and does not include the complete document source. Codex can request a fresh unsaved document snapshot when needed.
- The tested host disables **Steer** for an app-context message while a response is in progress. Wait for that response to finish and submit your request normally. Attaching context does not submit it.
- Model replacement checks the document path, revision, target range and pending input. It supports selected text and a selection within one math cell, not arbitrary replacements spanning table or matrix cells. New selection snapshots survive cursor/selection movement; legacy current-selection edits require a fresh read when the selection changes. Changed document content always requires fresh context.
- A successful edit enters native undo history but does not automatically save. After an uncertain snapshot edit, retry only the identical snapshot ID and replacement to recover its original receipt without another edit. After an uncertain legacy edit, read the document before retrying. Snapshot IDs expire after 30 minutes or eviction from the latest 32 captures.
- External disk changes use native reload and save-conflict behavior. They are not automatically merged into unsaved editor content.
- The private preference copy prefers the macOS LyX 2.5 profile and falls back to the LyX 2.4 profile when 2.5 is absent. `LYX_USER_PROFILE` selects an explicit profile. Desktop preferences are not modified. Other operating systems are unverified.
- Each checkout starts an authenticated broker on an available loopback port and records its address in its private `.native/broker.json`. Older brokers on port 43128 remain discoverable. Separate checkouts can run together without replacing existing sessions. Resolve unsaved work before stopping a broker or native process.
- Broker startup is serialized per checkout. If a process crashes during startup, the next attempt reports an interrupted startup and identifies `.native/broker-start.lock`. Remove that stale file only after the error confirms its owner has exited, then retry. A lock owned by a live process is never automatically removed.

## Reporting a problem

Include the LyxBridgeCodeX release, desktop Codex version and build, operating system/architecture, Qt version, and whether the problem occurs in the connected plugin panel or the standalone debug view. Use a small synthetic document when possible. Do not publish `.native/broker.json`, local session logs, document snapshots, or credentials.
