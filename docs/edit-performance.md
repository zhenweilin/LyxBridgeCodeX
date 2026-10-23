# Editing performance and CLI

The CLI and MCP tools share `lib/native-editor.mjs`, including input validation,
revision checks, tracked-edit defaults and uncertain-write recovery. The CLI
connects to the existing authenticated broker and edits the live native buffer.
It does not rewrite `.lyx` files on disk, save automatically, or restart an editor.

## Using the CLI

From the installation directory:

```sh
node scripts/lyxctl.mjs open /absolute/path/paper.lyx
node scripts/lyxctl.mjs selection --session SESSION_ID
node scripts/lyxctl.mjs replace --session SESSION_ID --snapshot SNAPSHOT_ID --text-file revised.txt
```

`open` returns the session ID. A selection capture returns its snapshot ID and
replacement format. Supply `--format math` for a selected math cell. Reuse an
already attached snapshot directly when available. Revision tracking is enabled
by default; `--direct` explicitly requests an untracked edit (the document's own
tracking preference still applies). Results are JSON, with nonzero exit status
on failure. `read` explicitly requests the full unsaved document.

For multiple operations, keep one worker alive:

```sh
node scripts/lyxctl.mjs serve
```

Write one JSON object per line to its stdin; read one result line before preparing
the next dependent request. For example:

```json
{"id":"capture","command":"selection","args":{"sessionId":"SESSION_ID"}}
```

Then use the returned snapshot ID:

```json
{"id":"edit","command":"replace","args":{"sessionId":"SESSION_ID","snapshotId":"RETURNED_UUID","replacement":{"format":"text","text":"Revised sentence."}}}
```

The worker processes requests in order and retains its HTTP connection and verified
engine capabilities. Each line reports its own success or failure. Later requests
are independent; inspect the error before issuing dependent work. EOF exits the
worker. A request is limited to 1 MiB. `request --request-file request.json` accepts
the same format for a single operation, including `review` with the existing
`review_native_lyx` arguments.

## Merge multiple text edits

For a selected plain paragraph, an edits file can contain:

```json
[
  {"find":"the old term","replace":"the new term"},
  {"find":"another unique phrase","replace":"a clearer phrase"}
]
```

```sh
node scripts/lyxctl.mjs apply --session SESSION_ID --edits-file edits.json
```

All matches refer to the original selection. Missing, ambiguous or overlapping
matches are rejected. The CLI captures once and submits one guarded native edit,
with one undo step and one tracked replacement for the complete selected passage.
It supports up to 128 exact edits. It requires a current native engine and a single
paragraph with uniform formatting and no formulas, insets or existing revisions.
This restriction prevents a whole-string replacement from flattening document
structure. Ordinary snapshot replacement continues to support text and math cells.

If the document changes after capture, the native engine rejects the operation.
An unknown outcome contains `retryRequest`; replay only that exact request to
recover the original receipt. Do not repeat `apply` with a fresh capture after an
unknown result. Separate snapshots are not an atomic multi-range transaction:
applying one changes the document revision and can invalidate other snapshots.

## Implemented optimizations

- Reuse positively verified tracking capability per native session, including
  captures made by the plugin panel. The normal capture-and-edit sequence uses
  one capture RPC and one mutation RPC, without an intervening state query.
  Unknown or legacy sessions retain the capability check and cannot silently
  fall back to untracked editing. The cache is bounded to 128 sessions.
- Model selection captures request a compact native response with one copy of
  the selection and no full source. Older engines ignore this optional response
  flag and remain compatible.
- Native snapshot writes store and return only their receipt, including the exact
  revision and replay status, instead of a redundant cursor/review snapshot.
- Full native source reads reuse one serialized byte string for UTF-8 output and
  hashing, avoiding a second `ostringstream` copy.
- CLI JSON returns the structured result once. MCP retains its existing text and
  structured result contract. A persistent CLI worker amortizes process startup.
- Text edit merging reduces native edits and model/tool interactions; it does not
  weaken document revision checks. Every actual edit still validates the complete
  source, because a dirty flag or unchanged cursor cannot establish equivalence.

Existing MCP processes must reload to use the new JavaScript handlers. New native
sessions use the rebuilt engine; already open native sessions retain their current
engine and unsaved work. Standard CLI reads and snapshot edits also work with older
snapshot-capable sessions; merged `apply` requires the new eligibility check.

## Measurements and verification

Run `node scripts/benchmark-edits.mjs --samples 25 --output results.json`.
The benchmark creates independent 20- and 2,000-paragraph documents and an isolated
broker. Each edit is checked against the real native source, undone in one step,
and verified not to save to disk. It does not replace the production registry.
Three warmup operations precede every group of samples.

Times include the native engine and local transports. They exclude model thinking,
Codex desktop tool scheduling and browser presentation. The cold CLI measurement
uses the same worker implementation through an isolated test launcher, including
process startup and shutdown; it excludes command-line file parsing. It is not a
claim about time saved across a complete conversation.

The baseline server and native binary were saved before editing. The benchmark's
`--baseline` switch is a developer comparison against that local ignored backup;
ordinary reproductions need only the current command above.

Measured on October 23, 2026, Node 23.11.0, macOS ARM64, LyX 2.5.3; 25 samples per operation.

| Median latency | 20 paragraphs | 2,000 paragraphs |
| --- | ---: | ---: |
| Previous MCP tracked edit | 1.92 ms | 19.92 ms |
| Optimized MCP tracked edit | 1.83 ms | 16.08 ms |
| Persistent CLI tracked edit | 1.59 ms | 15.76 ms |
| Cold CLI worker tracked edit | 114.11 ms | 128.92 ms |
| CLI capture + merge two edits | 2.26 ms | 24.20 ms |

The long-document MCP edit improved by approximately 19%; the short-document change
was about 5% and small relative to timing variation. Compact reads did not materially
improve latency in this run. Full serialization remains the dominant long-document
cost. The merged-edit measurement includes capture plus a single mutation; the
single-edit rows time the mutation after capture, so those rows are not a direct
speedup comparison. CLI receipts were 450–452 bytes versus 988–992 bytes for MCP,
roughly 54% smaller because JSON is emitted once. Cold process startup dominates
small edits; using a fresh CLI process for every operation is not recommended.

[Raw measurements, including p95 and payload sizes](benchmarks/edit-performance-2026-10-23.json).

Verification passed: 348 unit/protocol tests, four native integration scenarios,
the native engine build and the frontend build. Coverage includes CLI streaming and merged
text editing, existing MCP snapshot and legacy editing, math replacements, native
review and color preservation. It includes stale revisions, cursor movement,
input-method composition, lost-reply recovery, idempotent retries after undo,
formatting rejection and unchanged backing files/production registry.

One full-suite run under Node 23.11.0 stalled in the unchanged image-transfer test.
A macOS process sample showed V8's main thread waiting for Maglev compilation while
the compiler waited for garbage collection. Only that disposable test worker was
terminated. The full suite then passed with `node --no-maglev --test test/*.test.mjs`.
No runtime flag is imposed on the shipped CLI or plugin.
