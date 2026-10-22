# Scroll performance verification

Verified on October 22, 2026 in local editors 0.2.13 and 0.2.15. These changes are included in the 0.3.0 source candidate. Packaged releases remain paused.

## Second optimization round: 0.2.15

The user reported noticeably smoother scrolling in 0.2.13, but some stutter remained. This round reduces changed-frame encoding time and combines input acknowledgement with its subsequent state read into one Codex MCP request. Native input and state operations remain ordered; a failed state read never retries the input. Older servers retain the separate-state fallback.

The PNG fast path uses a fixed None scanline filter and level-1 zlib compression for ordinary 8-bit widget images. It preserves full resolution, straight-alpha pixels and pixel density. Images with color profiles, text metadata, offsets or unsupported formats use the existing Qt encoder. The encoded image remains lossless.

Fifty samples per operation, with the same disposable 150-paragraph fixture, empty profile and 1100 × 750 viewport used for both engines:

| Operation | Before median / p95 | After median / p95 |
| --- | --- | --- |
| Changed frame | 24.13 / 27.68 ms | 14.33 / 15.17 ms |
| Unchanged frame | 5.57 / 5.97 ms | 4.68 / 5.25 ms |
| Input acknowledgement | 0.35 / 0.51 ms | 0.28 / 0.31 ms |
| Post-input state | 2.14 / 2.34 ms | 1.92 / 2.04 ms |

Changed-frame median time fell by about 41%. The sampled final PNG shrank from 285,444 to 253,812 bytes. These times measure native socket request/response only, excluding the Codex MCP relay and browser presentation; they do not establish a host frame rate or complete input-to-display latency.

Validation: 191 development unit/protocol tests and seven native integration cases passed. The unpublished overlay passed all 192 unit/protocol tests, its frontend and native builds, and two native smoke cases for the combined MCP relay and shortcut sequences. Native coverage includes frame cache/resize/dialog lifecycle, forward/reverse drag, wheel behavior at speeds 1 and 2, IME, shortcut sequences, and the real stdio MCP input/state relay. The relay test checks that returned selection state immediately supports guarded copying. A separate Qt encoder harness passed 88 pixel, alpha, image-format, metadata and PNG CRC cases, including actual native frame captures and fallback formats.

Reproduce a native-only comparison with `node scripts/benchmark-scroll.mjs`; `LYX_CODEX_BINARY` can select a saved older engine. Use the same fixture header for both runs. Encoder parity is checked by `node scripts/test-native-frame-png.mjs`, optionally followed by local PNG paths. These commands create isolated test processes and leave existing editing sessions running.

The panel now exposes bounded timing summaries in DOM attributes on `#surfaces`: `data-rpc-timings` contains the last 60 samples per operation, and `data-input-state-combined` confirms whether the current MCP server supports the combined response. They contain no document text, paths or credentials. A new panel and native engine are required for the complete update; installing the plugin does not replace existing engines. The actual Codex panel was verified at frontend 0.2.15 with the test-copy filename, Saved and Connected to this chat. Its combined-input-state diagnostic was true, confirming activation of the new MCP response path. After continuous vertical scrolling, the user reported “更流畅了” (“smoother”). This confirms an improvement in this test, rather than complete elimination of stutter or a verified frame rate.

## First optimization round: 0.2.13

## Changes

- Accumulate adjacent waiting pixel-wheel events in the same direction and native document viewport. Preserve their total distance. In-flight events, reversals, pointer position changes, typing, chat snapshots and document switches remain ordering barriers. Zoom, line/page wheels, menus, dialogs and older engines without viewport metadata retain individual event delivery.
- Cache each visible native surface's pixels and encoded PNG. Unchanged pixels reuse the PNG; changed pixels use fast lossless compression. Cache entries are discarded when their surfaces disappear. Frame identity includes surface geometry and menu metadata.
- Request active frames at a 16 ms minimum interval, with only one frame in flight; retain 250 ms idle polling. This is a scheduling limit, not a claim of 60 fps.

Qt 5.15 maps PNG compression values from 0–100 to zlib levels 0–9; the bridge uses 11 for level 1. PNG pixels remain lossless and native pixel density is retained. See the [upstream PNG implementation](https://raw.githubusercontent.com/qt/qtbase/5.15/src/gui/image/qpnghandler.cpp).

## Measurements

Fifty samples per operation, sequential before/after runs with the same disposable 150-paragraph fixture, empty test profile and 1100 × 750 viewport. Times include the local native socket request/response; they exclude Codex's MCP relay and browser presentation.

| Operation | Before median / p95 | After median / p95 |
| --- | --- | --- |
| Changed frame | 36.14 / 37.84 ms | 22.37 / 23.30 ms |
| Unchanged frame | 33.56 / 35.14 ms | 4.82 / 5.45 ms |
| Input acknowledgement | 0.30 / 0.54 ms | 0.26 / 0.35 ms |
| Post-input state | 1.97 / 2.28 ms | 1.86 / 2.05 ms |

These frame reductions are approximately 38% and 86%. They do not measure complete input-to-display latency. In a blocked-input regression, 120 waiting fractional wheel events produce one input request while preserving their total distance. A native integration case confirms that 320 events of 0.125 pixels render the same final position as one 40-pixel scroll at both tested wheel-speed settings.

## Validation

- Development checkout: 179 unit/protocol tests passed.
- Unpublished overlay: 180 unit/protocol tests passed, including its upstream revision guard; frontend build passed.
- Five targeted native cases passed together: frame cache/resize/dialog lifecycle, drag endpoint parity, stdio MCP relay, and wheel behavior at native speeds 1 and 2. Wheel coverage includes fractional distance, reversals, zoom, line/page units, dialog isolation and source preservation.
- The first native regression run failed its pre-existing drag coordinate assumption. The same failure reproduced with the old binary. The fixture now sets a known zoom and uses actual caret geometry; the final combined run passed.
- The actual Codex panel showed frontend 0.2.13, the test-copy filename, Saved, and Connected to this chat. The user tested continuous vertical scrolling and reported “明显更流畅” (“noticeably smoother”).

Original unsaved document sessions were neither restarted nor overwritten. Existing engine processes retain their previous native code; reloading frontend resources alone does not replace a running engine. This validation used a fresh native session containing a copy of the user's live document.

No GitHub push, tag, release or new distribution archive was made. Longer editing sessions and other documents remain useful follow-up testing before publication.
