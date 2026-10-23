# Embedded editor appearance and stability

The editor keeps LyX's native document model and Qt input handling. `CodexPanelStyle.h` uses Fusion controls with flat chrome and slim, rounded, arrowless scrollbars. The complete Qt Macintosh style crashed in the offscreen renderer during a disposable local probe, so this remains a macOS-inspired interface rather than a Cocoa window.

The scrollbar's 14-pixel hit area stays fixed. Its visible thumb is 6 pixels wide at rest and 8 on hover or press. Painting, hit testing and native geometry use the same track, including horizontal right-to-left configurations. Hover does not resize the document.

## Browser layout

`native-viewport.mjs` fits native frames using CSS `zoom`. The previous transform-only scale reduced visible pixels while retaining the original layout width, creating extra browser scrollbars in panels narrower than the native 480-pixel minimum. Requests now use the viewport's available client dimensions, including any genuine overflow scrollbar gutters. Logical height accounts for the fitting scale.

Every frame refits the existing images and updates the input-method anchor, even when LyX omits unchanged image data. This matters when proportionally resized panels request the same native dimensions. Oversized dialogs remain scrollable; zero-sized panels do not resize the engine. Selection feedback stays on one line so it cannot change editor height.

## Session feedback

Failed frame requests or ambiguous editing errors show a persistent Retry control and pause new input, Save, and add to chat. Retry requests current state through a frame read, or waits for a check already in progress; it does not restart the native process or replay an uncertain edit. Safe pointer/preedit cancellation may finish after recovery. Duplicate attachments preserve the current view, and stale responses from an older session cannot replace it.

Only a structured `session_exited` response confirming the native process has exited exposes **Reopen editor**. The last frame remains visible for reference. Clicking the action reopens the last verified document path, including a verified Save As destination, and retains any existing recovery-choice prompt. It never automatically chooses a backup or sends queued edits to the new session. Current selection and clipboard indicators reset; an earlier chat selection remains a historical snapshot, and the chat draft is unchanged. Select content again to update that context.

Timeouts, unknown sessions and broker loss do not establish that the native process exited. Ordinary editor RPCs and Reopen editor only contact an existing broker; they never spawn a replacement broker. If the broker is lost, its child editors may still be running. This flow does not discover or recover those orphaned sessions, and recovery cannot guarantee changes newer than the last saved file or recovery snapshot.

A connected plugin waiting for initial file context shows **Waiting for file** with opening guidance. Initial tool errors or malformed session results show persistent feedback, while delayed valid context can still attach the editor. A late startup failure cannot replace an already attached editor. Backend session readiness does not by itself confirm that Codex displayed the panel.

The broker verifies a known owning session before probing unrelated sessions. Other probes run concurrently, while absence still requires all relevant probes to finish. A slow owning process is never replaced merely because it is slow.

Fresh-engine startup uses one 40-second deadline for setup, connection, and readiness. The socket can exist before LyX completes synchronous TeX configuration. Ordinary RPCs retain a separate 15-second limit.

## Startup recovery and private preferences

When a newer `#filename.lyx#` recovery snapshot exists, the side panel displays LyX's native **Load backup**, **Load original**, and **Cancel** prompt before the document is ready. The panel shows **Action required** and accepts native pointer and keyboard input. Save and add to chat remain unavailable until a document is loaded. The bridge never chooses a recovery option automatically, and reopening the same requested file reuses its unanswered prompt.

Loading the backup preserves its unsaved changes; the original disk file stays unchanged until an explicit Save. Cancel leaves an empty native editor that can open another document. Closing the last buffer also leaves an available editor rather than being reported as a failed startup. The state protocol distinguishes an available native surface (`uiReady`) from a loaded document (`ready`), with `interactionRequired` and `interactionTitle` describing startup prompts.

Each new engine uses a private copy of the user's LyX profile, preserving fonts and key bindings. Private overrides disable desktop-session restoration, select English and Fusion, enable one-minute recovery snapshots, and hide the welcome banner. Profile copying skips live sockets and FIFO pipes, and preference overrides replace a copied preferences symlink without writing through it into the desktop profile. The startup editor background stays plain; Qt splash windows are excluded from captured surfaces so recovery controls remain visible. These settings apply to newly started engines and do not change the desktop LyX preferences or restart existing sessions.

Fresh document sessions can reuse six verified TeX configuration metadata files through a bounded in-memory cache lasting at most five minutes within the broker process. A completed, document-ready engine publishes a configuration; an unanswered recovery prompt does not. Engine, source-profile and relevant library changes, environment changes, detected tool/TeX updates, or changes to participating private configurations invalidate reuse. Preferences, document content and editing state remain independent. Missing, expired, incompatible or unverifiable entries fall back to normal LyX configuration. External tools can have private data that the checks cannot fully track, so the short lifetime limits residual staleness.

Publishing completed configuration runs in the background. It cannot extend a successful editing RPC or make an already-ready editor fail its startup deadline. Diagnostics can explicitly wait for publication when measuring cache reuse.

Direct reuse of an already configured desktop profile also requires a stable configuration log showing the pinned configure script completed without errors. Manual Reconfigure invalidates a tracked generation when its log or outputs change. An open concurrent with the beginning of reconfiguration can still receive the previous complete generation; it never combines partially generated outputs.

## Verification

- `test/native.panel-style.integration.mjs` compiles a real Qt widget test covering eight direction/orientation configurations, dragging, page clicks, keyboard input, wheel input and hover geometry.
- `test/native-app-session.test.mjs` runs the bundled frontend with controlled host replies, including missing initial context, startup errors, verified-exit reopening, duplicate clicks, stale responses, queued-edit suppression, historical chat context, connection Retry, unchanged frames after resizing and collapsed panels.
- `test/native-broker-open.test.mjs` checks live-owner routing and slow-session ordering; `test/native-startup.test.mjs` uses a real child process and Unix socket to test readiness deadlines and exit handling.
- `test/native-broker-recovery.test.mjs` checks confirmed-exit authorization, last verified Save As paths, pending-prompt reuse, broker ownership and failure routing without replacement startup.
- `test/native.exit-recovery.integration.mjs` stops only a disposable test engine, reopens its verified Save As destination, and checks the actual native recovery prompt. It verifies unchanged original files and recovery data, reuse of the pending prompt, and preservation of another editor's unsaved content.
- `test/native.recovery.integration.mjs` opens disposable documents with newer recovery snapshots and uses actual native keyboard input to test loading the backup, loading the original, and cancelling. It checks repeated-open reuse, unchanged original disk content before Save, captured prompt images without splash surfaces, and continued use after cancelling or closing the last buffer. All three recovery cases passed locally; the captured main-frame image also confirmed the plain startup background.
- `test/native-profile.test.mjs` checks private preference overrides, copied preferences symlinks, and desktop-profile isolation.
- `test/native-config-cache.test.mjs` covers cache validation, expiry and fallback. `test/native.config-cache.integration.mjs` starts two disposable native documents from an empty desktop profile: the measured cold start took 8,876 ms and the warm start 399 ms. The warm engine reused the same six metadata files without running configuration again; its native document model matched, preferences stayed independent, and the desktop profile remained untouched. These are one local comparison, not guaranteed startup times. The latest local unit/protocol suite passed 299 tests, including blocked background publication, delayed Save As replies after RPC timeout, and protection of unavailable document owners.
- Run `node test/native-viewport.browser.mjs` and open its printed URL. `#result` reports browser checks at widths 320–900, short panels, tall and wide dialogs, scroll reachability, pointer mapping and input-method positioning. `/before` runs the prior layout as a failing control.
- Local Codex in-app browser verification passed all ten geometry scenarios. A real native editor at 360 pixels had no outer overflow and its thin scrollbar remained draggable to the end of the document. Disconnect and recovery retained the frame size.
- Before the explicit-exit recovery changes, the full native integration suite passed all 38 cases, including real one-minute recovery snapshots, formula and image clipboard transfer, native input methods, menus, external edits, save/reopen, pseudocode previews and wheel behavior. After those changes, all four targeted exit/recovery cases passed again. These tests used disposable documents and isolated profiles.
- A separate browser check exercised the rebuilt UI against a disposable native engine: confirmed exit displayed **Reopen editor**, clicking it displayed the native recovery prompt, and choosing **Load backup** displayed the recovered section title with **Unsaved** status. The test view and its processes were closed afterward.

Codex's file-open tool returns `queued` after registering a request, regardless of its later outcome. The inspected host drains requests for the chat currently displayed in its targeted main window; an action can also fail after leaving the queue. This acknowledgement alone proves neither success nor failure, and is not evidence that restarting Codex is necessary. Confirm opening from the visible panel or connected-app inventory. The plugin's backend session readiness is separate from that host display step.

Native recovery and browser-layout checks use disposable local sessions; they do not establish that the actual Codex panel opened or that every native startup dialog is covered. Complete Codex input-to-display latency and OS input-method/trackpad coverage remain unverified. Existing native editing sessions retain their running binary; rebuilding does not restart them or discard unsaved work.
