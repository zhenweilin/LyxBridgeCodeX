# Long-document interaction demo

Open `interaction-demo-25-pages.lyx` in the native editor. The accompanying PDF
has exactly 25 A4 pages. All text is synthetic; the document contains editable
native formulas, headings, lists and explicit page breaks.

Scroll down and back for at least 30 seconds, then drag-select several paragraphs
in both directions. Hold the pointer below the editor's lower edge to grow a
selection across sections. Release it and check that scrolling stops promptly.
Repeat with the Review sidebar open. After release, copying or annotating should
use the complete final selection.

LyX uses a continuous editing view; the PDF's page breaks do not make the editor
look like a paginated PDF. Use the numbered section headings to compare locations.

From the repository root, regenerate the LyX source with:

```sh
node scripts/generate-long-document-demo.mjs
```

Export through the isolated desktop-LyX wrapper, then compile the generated TeX:

```sh
node scripts/export-lyx.mjs --binary /Applications/LyX.app/Contents/MacOS/lyx --output "$PWD/demo/long-document/interaction-demo-25-pages.tex" "$PWD/demo/long-document/interaction-demo-25-pages.lyx"
pdflatex -interaction=nonstopmode -halt-on-error -output-directory demo/long-document demo/long-document/interaction-demo-25-pages.tex
```

`node scripts/benchmark-sustained-selection.mjs` holds a growing selection for
40 seconds in an isolated copy and records five-second latency/memory buckets.
It also checks source preservation and that releasing the pointer stops selection
growth. See [performance verification](../../docs/scroll-performance.md) for the
separate 3,000-paragraph comparison and browser testing scope.
