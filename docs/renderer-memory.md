# Renderer memory investigation

## Current fix and validation (October 30, 2026)

The dominant reproduced retention path is the **host-side** MCP Apps
PostMessageTransport debug logger. Removing logs from the plugin's own bundle
cannot remove this separate logger. The installed desktop sandbox adapter was
inspected read-only; it logs entire sent/parsed messages, including frame PNGs.
No host application files or security settings were modified.

A controlled Chromium comparison used the real SDK with a quiet client and a
host transport that either logged normally, omitted debug logging, or cleared
the developer console. It sent distinct approximately 388 KB base64 frame
payloads, with no native edits and no image decoding:

| Host logging mode | Frames completed | Reported heap | Outcome |
| --- | ---: | --- | --- |
| Original debug logging | 600 | 21.6 → 437.8 MB | Stopped at safety threshold |
| Debug logging omitted | 2,000 | 14.2–63.2 MB after warm-up | Completed |
| Console cleared every 25 frames | 2,000 | 24.3–66.3 MB after warm-up | Completed |

The expanded Codex side panel then provided the matching controlled result:
minimal ordinary frame reads grew from 14.3 to 407.8 MB after 1,100 inputs in
43 seconds. Clearing the console after each frame allowed 2,000 inputs in
79 seconds and returned to 26.7 MB, with 13.5–45.0 MB samples after initial
reclamation. This identifies console-retained responses as the dominant growth
in this reproduction; it is not a heap-retainer dump of the original crash.

`web/native-frame-transport.mjs` instead uses the documented
[`window.openai.callTool`](https://developers.openai.com/plugins/reference#windowopenai-component-bridge)
compatibility API for **frame reads only** when available. It calls the same
`native_lyx_rpc` server tool, with the same native session and parameters,
without the host's additional postMessage debug-logging adapter. Read-only
inspection of the installed host also confirmed that both APIs delegate to the
same tools/call handler and authorization path. Normal MCP
input ordering and edit/error handling remain in place. Hosts without this API
use the standard MCP frame route. A failed compatibility request is never
replayed or silently replaced by the leaking route. No console method is
replaced or cleared in production.

The compatibility route completed 2,000 minimal real-side-panel operations in
81 seconds without a safety stop or operation error, ending at 37.7 MB. The
subsequent full expanded-side-panel run completed 8,000 input/frame cycles in
476 seconds, including 80 selection drags, 7,262 changed rendered frames and
759 clipboard reads. At a fixed 1671 × 1211 canvas, heap stayed within
17.5–57.8 MB after warm-up and ended at 48.1 MB. There were no errors or safety
stops. Native source and disk hashes were unchanged; the original user document
also remained ready, unmodified and source-identical.

This validates the compatibility route with ordinary bitmap rendering in the
actual expanded panel, beyond the duration of the earlier approximately 2.5 GB
failure. Production activation was verified after the desktop application
restarted on October 30. The restored long-document demo rendered in the ordinary
editor, with no diagnostic driver, and reported `data-frame-transport` as
`host-compatibility` after a successful frame response. The loaded script's
SHA-256 matched the normal production build exactly. The panel showed Saved and
Connected; both the demo and the original user document retained their baseline
source revisions and had no unsaved edits.

Host resource caching had previously loaded an older diagnostic body into a
newly opened file tab: the loaded script still used the old test basename. A
versioned directory retaining that basename resolved the diagnostic mismatch.
Opening a new file or rebuilding dist alone therefore cannot prove that a panel
has loaded the intended code; verify its loaded script after reloading the
desktop application.

The ineffective resources/read experiment was removed from production source
and its dedicated tests archived privately. The isolated release tree, excluding
separate unpublished note-review changes, passed all 385 unit/protocol tests using:

```sh
node --no-maglev --test --test-concurrency=1 test/*.test.mjs
```

This command avoids the separately recorded Node 23 Maglev/test-concurrency
issues; no application runtime flags or test assertions were relaxed.
Regression coverage checks compatibility envelopes, failure preservation,
API-absence fallback, and real-frontend separation of frame reads from edits.
The production build passes and contains no diagnostic drivers.

The sections below retain the investigation history. Earlier candidate results
are historical and are superseded by the comparison above.

## Confirmed evidence

On October 28, 2026 at 11:22:23 America/Indiana/Indianapolis, Codex recorded
`mcp_app_sandbox.render_process_gone`, `reason=crashed`, `exitCode=5` for the LyX
panel. The matching Crashpad dump contains V8's
`MarkCompactCollector: young object promotion failed` message. The same panel
origin had another renderer crash on October 27. This is renderer memory
exhaustion, not merely a dropped native-editor connection. Private logs, dumps,
manuscripts, process identifiers and sandbox identifiers are not included here.

The installed `@modelcontextprotocol/ext-apps` 1.7.5 PostMessageTransport logs
complete incoming and outgoing messages with `console.debug`. Native frame
responses contain base64 PNGs. Console and host log collectors can retain those
message objects. An isolated test with the real installed transport confirmed
that all 100 baseline frame payloads reached the debug logger.

This identifies a concrete unnecessary retention path. It does **not** establish
that console logging was the only root retaining memory during the crash. A
stack stopped at `image.src` assignment identifies the failed allocation, not
necessarily the owner of the retained objects. Image updates and host sandbox
attribute handling remain hypotheses until a heap-retainer analysis is available.

## Change and automated verification

Both production browser bundles now use shared esbuild options which eliminate
`console.debug` calls during minification. No global console methods are replaced;
warnings and errors remain, and SDK message parsing/source validation/delivery
are unchanged. No SDK version or native engine change is required.

`test/browser-transport-logging.test.mjs` executes the real SDK transport in a
controlled window adapter. It delivers 1,000 distinct synthetic 256 KiB frame
payloads (250 MiB nominal payload volume), with zero debug calls in the production
build. This is a logging regression test, **not** a browser heap measurement.
Foreign-source messages stay rejected, malformed JSON-RPC still reports errors,
outgoing messages still arrive, and closing removes the listener. The MCP
integration test also checks the actual published HTML resources, so changing
the build to reintroduce raw payload logs fails verification.

Run `npm run build`, then
`node --test test/browser-transport-logging.test.mjs test/mcp.test.mjs`.
The complete local unit/protocol suite also passed (376 cases, including separate
in-progress note-review changes). The generated native and preview bundles each
contain zero `console.debug` calls and retain transport error reporting.

## Frame presentation

The first comparison changed logging only and left data-URI image presentation
intact. Its real-host memory samples continued to grow, so the candidate now
decodes PNG bytes with `createImageBitmap` and paints a persistent canvas for each
native surface. The decoded bitmap is closed after painting. Identical pixels
skip decoding; removed surfaces and document switches release canvas backing
stores. A late decode cannot repaint a surface after a document switch. The
frame loop awaits decoding and painting, preserving its single in-flight limit.
Failed decoding does not acknowledge the frame serial, so Retry can request it
again. Pointer, wheel and selection events target the same surface coordinates.

A blob-URL prototype was rejected by the real host's `img-src` policy. It was
replaced, not shipped as a fallback. Canvas presentation does not introduce URL
loads or change the host's security policy. Tests check decoded bytes, bitmap
closure over 1,000 updates, unchanged-frame reuse, removed surfaces, document
switches, late decode cancellation and error recovery.

## Host validation status

The logging-only build was verified in a real Codex panel: its loaded script
contained zero `console.debug` calls, and the synthetic 25-page document was
visible with Saved / Connected status. A five-minute run delivered 5,327 native
wheel inputs. Native frame captures advanced at approximately four per second;
the real panel was sampled during the run and its displayed PNG changed. Inputs
were sent through the existing local native broker, while the production panel
polled and displayed frames through the normal MCP relay. This does not exercise
the browser's active-input scheduling at its maximum frame rate.

The native source and disk file were unchanged, and no new renderer crash was
recorded during the run. One renderer process created around panel opening rose
from 303.7 to 625.8 MiB RSS. This is a correlation, not a verified mapping from
PID to panel. Other renderers also changed. RSS is not JavaScript live-heap size,
and the read-only browser interface did not expose heap-retainer measurements.
The run therefore does not establish stability or sole ownership of the leak.

The canvas build was then confirmed loaded in a real Codex panel: the loaded
script had zero debug calls, a canvas with a nonzero 876 x 851 backing store,
no image URL elements, no visible error, and Saved / Connected status. A second
five-minute run delivered 5,398 native wheel inputs. Native captures continued
at approximately four per second. Source and disk contents were unchanged, and
no new renderer crash was recorded in the host logs during the run.

This is functional sustained-load evidence, **not a verified memory-stability
result**. The second viewport was larger than the first (634 x 751), so the runs
were not identical workloads. A process created around the second panel opening
stayed near 164–168 MiB for the first 220 seconds, then disappeared from process
samples without a matching renderer-crash record. It cannot be used as a complete
five-minute panel memory trace. Other renderer processes were still growing,
and process-to-panel attribution was not established. Do not present the stable
partial sample as proof of leak removal. Later browser inspection and screenshot
requests timed out, so no post-run rendered screenshot or heap snapshot was
obtained. Canvas presentation was verified in the DOM before the run; native
buffer integrity and frame capture continued to be checked independently.

After testing, only the two saved, disposable pre-canvas test buffers were
closed, after checking their exact paths and unmodified state. The canvas demo
and user documents were preserved. New panel loads use the rebuilt resource;
already-loaded panels keep their prior JavaScript until reopened. The native
LyX engine does not need rebuilding for these frontend changes.

The confirmed logging and large-URL risks are mitigated; the original OOM's
retainer ownership remains unresolved. A reliable panel-specific heap or process
trace is required before claiming the leak is eliminated. Private process IDs,
document text, logs, dumps and sandbox IDs stay out of this report.

## Upstream issue review and teardown follow-up (October 28, 2026)

The repository itself had no public issues at the time of the check. The closest
SDK report is [ext-apps #786](https://github.com/modelcontextprotocol/ext-apps/issues/786):
transport logging includes full payloads and messages rejected by other views.
[PR #808](https://github.com/modelcontextprotocol/ext-apps/pull/808) and
[PR #803](https://github.com/modelcontextprotocol/ext-apps/pull/803) were still open,
not merged. Removing debug calls from this plugin's bundle does not alter a
separate transport inside the host. This explains why local log suppression
alone cannot rule out host-side retention; it does not prove which component
caused this incident.

[Codex #56868](https://github.com/openai/codex/issues/56868) reports retained view
resources, while [#21134](https://github.com/openai/codex/issues/21134) describes
large-message logging and long-thread pressure. These are comparison reports,
not verified diagnoses for this plugin. The resize-observer proposal
[ext-apps #814](https://github.com/modelcontextprotocol/ext-apps/pull/814) was closed
without merging; this native editor already disables SDK auto-resize. No
unmerged SDK patch, undocumented host configuration or application-bundle edit
was installed.

A separate plugin defect was reproduced: it did not handle the host's
`ui/resource-teardown` request. Four regression cases failed before the change.
The new handler stops frame and review polling, clears timers, releases canvases,
ignores late frames and attachment events, and finishes accepted edits and
native gesture cancellation before acknowledging disposal. It neither saves nor
closes native documents. All four regressions pass, together with the complete
380-test unit/protocol suite and the production build. This follow-up has not
been tested by requesting teardown in the live Codex host. Existing panels need
to be reopened to load the new lifecycle handler.

## Live validation result: memory stability failed (October 28, evening)

A disposable diagnostic build was loaded in the real Codex MCP App sandbox,
using a saved synthetic 25-page document. The production input queue, native
engine, MCP relay and canvas presentation were used. The driver generated
synthetic wheel and pointer input inside the panel; it did not exercise native
OS mouse capture. Bounded counters and 25 measurements were exposed in the
diagnostic panel. The normal production bundle was restored after testing.

The six-minute run started at 2026-10-29 02:04:54 UTC (October 28 locally). It
issued 6,887 input events and 35 drag gestures. Canvas dimensions were
1671 x 1211. The frame-RPC counter advanced by 7,305, the paint counter by 6,035,
and the clipboard-RPC counter reached 4,399. All samples reported Connected
and an unmodified document, and the driver recorded no operation error.
Native source comparison and a disk SHA-256 check independently confirmed
that the document was unchanged.

The sandbox exposed `performance.memory.usedJSHeapSize`; its reported usage
grew throughout the run:

| Elapsed seconds | Reported JS heap (decimal MB) |
| ---: | ---: |
| 0 | 31.1 |
| 60 | 429.9 |
| 120 | 848.6 |
| 180 | 1307.2 |
| 240 | 1731.6 |
| 300 | 2131.1 |
| 360 | 2518.3 |

The rolling 60-sample input-RPC p95 was 36.4 ms at 15 seconds and 167.1 ms
at 360 seconds; frame-RPC p95 was 49.2 ms and 172.7 ms respectively. These
measure RPC duration, not end-to-end visible interaction latency. The largest
observed timer delay above the intended 50 ms interval was 412 ms.

This is a failed memory-stability result for the current canvas/log-suppression
build. It is substantially stronger evidence than correlating an unverified
renderer PID with a panel, but `performance.memory` is still not a heap-retainer
snapshot or proof that all retained bytes belong to plugin code. There was no
forced-GC comparison. The diagnostic build itself also adds bounded counters,
samples and UI text. A retainer investigation or controlled transport/rendering
comparison remains necessary before assigning the remaining growth to the
plugin, SDK transport, or host sandbox. Clipboard refresh volume is another
measured optimization target; this test alone does not establish it as the
OOM cause.

Browser observation calls repeatedly timed out during and after load. The
results were recovered when the user reopened the test view, rather than
inferring success from those timeouts. A separate LyX-origin sandbox crash
with exit code 5 was logged at 02:15:53 UTC, after this six-minute load window.
The failed view has not been conclusively mapped to this test panel; do not
label it as this panel's crash or claim the whole observation period was
crash-free.

The diagnostic button then invoked the actual SDK's registered teardown
handler inside the real sandbox. The canvas backing stores were reset to zero
and the visible editor canvas was removed. In matched 30-second host-log
windows, one view's callMcp traffic fell from 119 calls to zero while the other
four streams continued at approximately 120 each. This supports successful
cleanup of the active panel's polling. The final five-second diagnostic DOM
read timed out, so the `cleanup.quiet` field was not retrieved and post-cleanup
heap reclamation was not measured. The test invoked the registered handler;
it did not verify that the host sends teardown when a user closes a tab.

Only the three saved disposable buffers created for this validation were
closed, after checking their paths, unmodified state and lack of pending input.
User documents, recovery files and other sessions were preserved. Diagnostic
controls are absent from the restored production HTML. Raw measurements, local
process samples and the diagnostic builders remain in the ignored `.native/`
folder. The original memory-exhaustion problem is not resolved.

## Standalone comparison and recovery (October 28, late evening)

The user subsequently reported an actual crash/reload prompt. The latest
matching host record remained the 22:15:53 local-time renderer crash. Its
new dump did not expose the explicit OOM text found in the earlier dump,
so exit code 5 alone is not treated as proof of the same failure mechanism.
The native editor serving pseudocode-demo.lyx was still ready and reported
no unsaved changes. Its complete live source was backed up privately before
further work; the original document was not overwritten.

A separate loopback-only diagnostic server and native test session ran the
same production frontend and synthetic 25-page input driver in an ordinary
Chromium page, outside the MCP App sandbox. It used the existing authenticated
standalone RPC path. At the same 1671 x 1211 canvas size, a 120-second run
completed 2,318 inputs, 12 drags and 5,002 additional frame calls. Reported JS
heap stayed between 12.4 and 21.3 decimal MB, ending at 15.7 MB, with no driver
errors. By comparison, the MCP App run reported 848.6 MB at 120 seconds.
The standalone cleanup result confirmed unchanged RPC counters over five
seconds, zero-size released canvases and a disposed panel. The synthetic
file was byte-for-byte unchanged. This narrows the investigation to the
MCP transport/sandbox integration as a combined path; these two variables
were not isolated from each other, and no heap-retainer ownership is proven.

A separate confirmed inefficiency was repaired: ordinary document scrolling
invalidated the selected content's MIME cache on every input even when the
selection stayed identical. Scroll state barriers and stale-frame protection
remain in place, but known plain scrolling inside the sole document viewport
now preserves the clipboard generation. Native selection identity changes,
editing, toolbar/dialog wheel events, zoom and active drags still trigger the
existing invalidation behavior. A regression reproduced 81 copies for the
initial selection plus 80 scroll events; after the fix there is one copy.
A content edit still forces a refresh even if plain text and positions stay
identical, and a changed native selection refreshes normally. Both added
cases and the complete 382-test unit/protocol suite passed; production builds
passed. This optimization is not claimed to fix the sandbox heap growth.

For immediate usability, a private local browser view was connected to the
existing pseudocode-demo.lyx native session, rather than starting a new editor
or discarding its undo history. Real mouse dragging selected the expected
phrase, and scrolling moved the displayed document while preserving that
selection. A source hash confirmed no content change. The temporary view
has Save and Review, but its Add to chat button is disabled. It is a recovery
workaround with limited test coverage, not a proven long-term remedy. The
independent stress server and its disposable engines were stopped; only the
user-facing recovery server remains active.

## Transport versus rendering isolation (October 29)

A bounded diagnostic resource ran inside the real Codex MCP sandbox. It used
one saved synthetic 25-page native buffer, the installed SDK with production
logging suppression, and the production canvas helper. Each phase performed
1,000 operations, with samples every 100 operations and a 500 MB phase cutoff.
No forced garbage collection was requested. Results were collected from the
diagnostic resource by appending a small JSON report to that disposable native
buffer, after measurement; the original disk document was not saved over.

The run began at 2026-10-29 18:09:19 UTC (14:09 locally):

| Phase | Operations | Seconds | Heap at start/end (MB) | Observed range (MB) |
| --- | ---: | ---: | ---: | ---: |
| State RPC only | 1,000 | 3.8 | 18.5 / 10.7 | 10.7–27.1 |
| Decode and paint one PNG, alternating base64 whitespace | 1,000 | 24.9 | 10.7 / 12.3 | 10.7–12.3 |
| Full frame RPC, no decode or paint | 1,000 | 20.6 | 10.7 / 213.7 | 10.7–228.6 |

The frame PNG was 339,576 base64 characters. In the final phase, heap grew
through approximately 600 responses and then fluctuated near 210–229 MB.
This is evidence of substantial retention/pressure in the large-message path,
but this run does not reproduce unlimited growth. Repeating only two encoded
strings does not rule out content-dependent retention when scrolling produces
many different images. A second run changes image content to distinguish that
case. The diagnostic build is temporary and must not ship as the editor.

The second isolation run started at 18:12:34 UTC. For each of its three phases,
1,000 operations completed without errors. Unique PNG encodings (counter bytes
appended after PNG IEND) were decoded and painted without further RPCs: heap
ended at 13.4 MB and fell to 9.7 MB after the idle interval. Scrolling between
full-frame replies, without painting, ended at 133.3 MB; combining scrolling,
frame replies and painting ended at 148.0 MB. In both message phases the heap
rose and fell rather than reproducing the earlier monotonic 2.5 GB growth.
This further limits the diagnosis: neither canvas decoding alone nor the
minimal transport-plus-canvas path reproduces the original failure.

A subsequent complete-frontend probe exposed an important validation hazard:
when its inline tool card became offscreen, the host reported a zero viewport.
Frame requests consequently stopped at 1,003 while input requests continued to
3,000. Its later low-heap samples are **not** sustained-rendering evidence.
The next comparison fixes the diagnostic viewport to 1671 x 1211 and records
canvas dimensions plus operation counters. Production visibility and sizing
behavior are unchanged by this diagnostic override.

## Rejected hypotheses and next rendering experiment

A fixed-size, complete-frontend run in an observed side panel reproduced the
problem: 1,000 frames increased reported heap from 25.2 MB to 355.8 MB in
40 seconds. A subsequent bare draw loop, with clipboard traffic unchanged,
grew from 320.9 MB to 781.6 MB after another 1,000 frames and stopped at its
safety threshold. This is not explained by repeated clipboard prefetch alone.

A stable-surface-ID cache experiment was tested and **reverted**. In the real
sandbox, all 100 queried canvas references equaled the first reference, and
the original cache retained exactly one frame. The candidate also retained one
frame while heap continued growing, reaching 523.9 MB after 109 seconds.
Disabling DOM performance statistics likewise did not stop growth, reaching
766.6 MB and its safety cutoff. The passing synthetic-wrapper regression tests
were not evidence that this was the actual defect; they were removed with the
rejected change.

Copying native replies through JSON before using them also failed: 1,500 frames
reached 406.2 MB after 86 seconds. A subsequent minimal draw loop returning the
RPC result directly, without that copy or the UI-capabilities spread, grew from
464.7 MB to 756.3 MB in 750 frames. These variants remain private experiments;
no JSON-copy workaround was added to production.

A new private renderer experiment decodes native RGB/RGBA PNG rows into a
reused ImageData buffer and uses putImageData, avoiding per-frame ImageBitmap
creation/drawing. A 1671 x 1211 native frame (2,023,581 pixels), plus RGB and
RGBA fixtures using Pillow's PNG encoder, matched independently decoded RGBA
bytes exactly. This is only pixel-fidelity evidence. Host memory stability and
performance are still unproven, and the experimental decoder is not installed
in production source.

The private pixel-path run started at 2026-10-29 18:50:14 UTC. At a fixed
1671 x 1211 canvas size it completed 4,294 input operations and 4,298 frame
calls, with 492 seconds of reported active time. Samples after warm-up stayed
near 132–137 MB; the 4,250-input sample temporarily reached 157.6 MB and the
last sample returned to 136.9 MB. This is a materially different result from
the monotonically growing ImageBitmap/drawImage runs, but the planned 8,000
frames did not finish: a native-service connection error stopped the driver.
Power-management logs confirm sleep/dark-wake events in that interval. Direct
authenticated checks afterward found both the broker and the same native test
session healthy, ready and unmodified; there was no corresponding new sandbox
renderer crash in the inspected records. The exact interrupted request was not
classified beyond that evidence. This is not recorded as a passed end-to-end run.

The production candidate now decodes the native encoder's RGB/RGBA PNG formats
into a reusable ImageData plus a JS-owned RGBA working buffer. One bulk copy
updates the host pixel buffer; individual pixel channels are not repeatedly
written through its DOM wrapper. CRCs, dimensions, decompression length and
row filters are checked. Uncommon PNG formats and color/transparency profiles
keep the browser decoder, preserving its color handling. Those fallback frames
still use the earlier bitmap path and have not been shown to share the native
format's memory improvement. The real native screenshot matched Pillow's RGBA
output byte-for-byte. Unit tests cover all five filters, split IDAT chunks,
RGB and alpha, malformed frames, bounded inflation, 1,000-frame buffer reuse,
resizing, pending-decode disposal and color-profile fallback.

## Completed inline validation and unresolved side-panel comparison

The optimized pixel candidate completed a fixed-size run in an inline Codex MCP
tool view from 20:29:38 to 20:45:34 UTC on October 29. Its 8,000 input operations
(80 synthetic drag sequences and 7,120 wheel inputs) produced 8,006 frame RPCs
in 957 seconds. Every sampled canvas reported 1671 x 1211 and the pixel-renderer
marker. Heap samples after 500 inputs ranged from 140.1 to 167.5 decimal MB,
ending at 145.8 MB. Later 250-input batches took 29–32 seconds, similar to the
earlier batches. No driver error or safety stop occurred. The live native source
hash matched its pre-test value, and the document remained unmodified.

This demonstrates sustained pixel rendering, **not a resolved OOM**. A subsequent
same-entrypoint bitmap control completed 3,000 inputs and 3,004 frame RPCs in
222 seconds, remaining near 102–105 MB after warm-up and ending at 104.7 MB.
It reported no errors and left the native source unchanged and unmodified.
The original growing runs used an expanded side
panel, while these two runs were inline tool views. Consequently, the stable
inline measurements cannot establish that the new renderer fixes the reported
side-panel failure. They also show a cost: the pixel path took about 30 seconds
per 250-input batch versus about 19 seconds for the bitmap control. Do not call
this a general scrolling-performance improvement.

The control page has a mode selector for a same-page bitmap/pixel comparison
after expansion into the real side panel. That expansion requires a user action
because the available MCP Apps browser interface only controls already-expanded
tabs. The pixel renderer remains a candidate pending this comparison.

Both diagnostic resources are private, path-gated and temporary. Normal
production HTML was rebuilt after each diagnostic resource loaded, so the
running test retains its instrumentation while subsequent editor loads receive
the production candidate. The complete 389-test suite passed. No diagnostic
driver, private native state or host log is included in the distributable build.

The expanded side-panel check subsequently **rejected the pixel candidate**.
On October 29 at 21:05:23 UTC it started at 133.6 MB. It reached 478.8 MB at
500 inputs, 606.0 MB at 1,000, and 764.7 MB at 1,500 inputs after 113 seconds,
then stopped at its safety threshold. All samples still identified the pixel
renderer at 1671 x 1211. A diagnostic status of `finished` with `safetyStop: true`
is a failed stability result, not a completed stress pass. The inline success
must not be used to claim this candidate fixes the reported panel failure.

The next private comparison separates browser Blob/DecompressionStream use
from the frame transport. It includes pure-JavaScript inflation, the existing
browser-stream inflation, bitmap decoding and transport without decoding.
Pure-JavaScript decoding matched the independently decoded 1671 x 1211 frame
and all RGB/RGBA filter fixtures; bounded output rejects undersized/oversized
data. This is correctness evidence only. No fflate dependency or alternative
inflater has been added to the production package pending real-panel evidence.

## Growth without image decoding; resource-channel experiment

On October 29 at 21:36:09 UTC, the expanded side panel ran its ordinary input,
frame RPC, state UI and clipboard paths, but replaced image decoding and painting
with a blank canvas. After 1,200 inputs and 51 seconds, reported heap rose from
32.1 to 437.8 MB and the test reached its relative safety limit. It never called
the image decoder in this phase. This establishes that decoding/painting is not
required for the observed growth; it does not separate MCP message retention
from every other frontend state-update operation or identify a heap retainer.
The proposed pure-JavaScript inflater therefore cannot fix the demonstrated
transport-only failure and is not being adopted. The rejected custom PNG decoder,
its pixel-buffer branch and their dedicated tests were removed from production;
private experiment copies remain available for diagnostic comparisons.

An experimental `lyx-native-frame://frame/{sessionId}/{width}/{height}/{serial}`
resource now exposes read-only frame snapshots through `resources/read`. It does
not list sessions, accept edit commands, or open/restart/close native processes.
It validates parameters, requests zero-TTL private caching, preserves native
errors, and forwards cancellation to the existing broker. The normal frontend
still uses the tool relay; the private `resource v3` diagnostic page can compare
resource and tool delivery, with or without image decoding. This is a candidate
transport change, **not a confirmed fix**. The running MCP service must reload
before it can serve the new resource, and the diagnostic page must also reload.

Three resource tests passed alongside the input-relay tests. The complete suite
with the rejected pixel code still present passed all 392 cases using
`node --no-maglev --test --test-concurrency=1 test/*.test.mjs`. A default Node
23.11.0 run had to be stopped after sampling an image-transfer test worker:
its main thread waited for task drainage while Maglev compilation workers waited
for garbage collection. That test passed separately in 77 ms. A parallel run
with Maglev disabled also hit an existing 450 ms startup-stage timing assertion;
the serial run passed. These test-runner observations are separate from the
Codex panel OOM and do not establish its cause. No application runtime flags or
test timing assertions were changed to obtain the serial result.
After removing the rejected decoder and its seven implementation-specific
cases, the resulting 385-test suite passed with the same serial command.

The resource channel was subsequently **rejected as a fix** in the expanded
side panel. The reloaded backend served it successfully on October 29 at
22:14:02 UTC. In 48 seconds, 1,100 input/frame cycles and 848 changed frames,
reported heap rose from 47.2 to 501.0 MB without decoding or painting. The run
stopped at its relative safety limit, with no operation errors. Both native
buffers remained ready, unmodified, and source-identical; the disposable file
also retained its disk hash. The normal frontend still uses tools/call.

Read-only inspection of the installed host's cached public sandbox adapter
(`adapter-The-z8hD.js`) found another full-message debug logger: its own
PostMessageTransport logs parsed and sent messages. The plugin's build-time
console.debug removal does not change this host-owned adapter. This is a
specific retention hypothesis, not yet a demonstrated heap retainer; numeric
host logs from the run did not contain PNG payloads. A private `bridge v4`
page can compare minimal state/input/frame reads, clearing the local developer
console, and the documented `window.openai.callTool` compatibility API. It does
not modify host files, security policy, or production transport routing.
The comparison must run in the expanded side panel; an inline result is not
sufficient evidence. No tests or production fixes are claimed for this new
private diagnostic alone.
