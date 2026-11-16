# Changelog

All releases are on GitHub (tag = version, no "v"); each release's `main.js`, `manifest.json` and
`styles.css` carry build-provenance attestations from 0.1.1 on. Decisions are in
[docs/DECISIONS.md](docs/DECISIONS.md) (D-numbers below).

## 0.8.1 — 2026-11-17

- **Fix (0.8.0 regression):** text under a highlight looked washed out. The margin's clipping made the
  annotation layer an isolated group, so highlights no longer blended (multiply) with the page. The
  clip now sits on the layer SVGs; a new harness check compares screen pixels under a highlight.
- **Fit width with a margin:** one scale change instead of two; a margin above or below the page
  (view rotated a quarter turn) no longer narrows the fit; the fit uses the page that was current
  before the layout shifted; width drags (window, Split View, panel edge) refit once they stop.
- Toolbar: a long press that ends without a click no longer swallows the next tap.
- Tests: 0.7.3's own sidecar store (load → edit → save → external merge) keeps 0.8.0 areas and notes;
  harness `highlight-blend`, `margin-rotated`, and an independent pixel-based area measurement
  (≤ 0.39 pt).

## 0.8.0 — 2026-11-17

- **Panel inside the view:** Outline, Pages, Search, Bookmarks and Annotations now open inside the
  penDF view — docked beside the pages when the view is wide enough (≥ panel + 560 px), over them
  otherwise (tap outside to close). Resizable; open tab, width and pin are remembered per view. The
  reading position is kept when it opens, closes or resizes (fit width refits). Setting *Panel
  location* keeps the old sidebar. Outline marks the current section and remembers folding; Pages
  follows the current page and counts against the canvas memory budget (D-42).
- **Toolbar:** every button named (tooltip; press and hold on iPad), grouped, and less used buttons
  move into a *More* menu when narrow (D-43).
- **Margin space (Phase 7a):** room beside each page for handwriting and point notes, as part of the
  page box (pdf.js layers unchanged; highlight ground truth ≤ 0.89 pt with a 75 % margin). Content is
  stored as off-page PDF points, side follows the page's own /Rotate; opens by itself for PDFs with
  margin content; hidden-content marks; notes can be moved (D-41, SCHEMA "Off-page coordinates").
- **Area excerpts (Phase 7b):** new annotation `area`; Pencil/finger/mouse drag; colour, note, link,
  copy / save image (rendered from the PDF on demand, within the canvas budget); thumbnails in the
  panel. Notes can target any annotation (`{ kind: "annotation", id }`). 0.7.x keeps what it does not
  know and 0.8.0 takes it back — tested against the 0.7.3 parser; schema stays v1 (D-44).
- **Vault annotation index (Phase 8 groundwork):** fingerprint → current paths, id → summary,
  `{ fp, id }` resolver that survives renames; lazy sliced build with a cache in the plugin folder,
  incremental updates; command *Search annotations in vault* (D-45). 500 sidecars / 50,000
  annotations: build 94 ms, longest main-thread slice 12.6 ms.
- **Fix:** a Web Worker whose start-up handshake failed, or that was still starting when penDF was
  unloaded, was never terminated; every worker penDF starts is now tracked and terminated.
- Harness 44 checks (new: in-view-panel, toolbar-labels, margin-ink, margin-ground-truth,
  margin-note, margin-with-panel, area-ground-truth, area-image, area-link, index-rename,
  index-perf); fixture `areas.pdf`; WebKit smoke renders area excerpts.

## 0.7.3 — 2026-11-16

- **Fix (0.7.2):** with a canvas budget smaller than what is on screen, the page pdf.js renders ahead
  of the visible ones was freed and rendered again in an endless loop (likely on an iPad with
  *Memory saver*). The budget no longer frees the pages right before and after the visible range (D-39).
- **Fix:** in dark reading mode, pages without a canvas yet showed white paper; they now show inverted
  (dark) paper like rendered pages.
- **Diagnostic preset "0.7.1 canvas cap":** Zoom rendering can bring back 0.7.1's canvas sizes (2^23 px on
  mobile, no memory budget, nothing freed on a zoom commit) with every other zoom fix in place, to tell on an
  iPad whether the black flash came from iOS canvas memory (DEVICE_CHECKLIST 7-9, D-40). Not for everyday use.
- Harness: new check `zoom-extras` — highlight ground truth after a zoom commit (all four rotations),
  no render loop with a 2 MB budget, switching the preset in settings, page background in dark mode.
  Unit tests for layers during a gesture (frozen, restored after a pdf.js reset).
- Harness: `scripts/harness-batches.mjs` runs the full harness in small resumable batches, reopening the
  test vault window between batches and logging Obsidian / system memory; harness races fixed (D-37).
  Full harness 33/33.

## 0.7.2 — 2026-11-16

- **Pinch zoom without re-rendering:** while two fingers (or a trackpad pinch) move, the pages are only
  composited with a CSS transform — pdf.js is not touched, no layout is read, annotation layers stay put.
  When the fingers lift, the new scale is applied once and the view is scrolled so the content under the
  fingers stays there. Two-finger pans move with the fingers too (D-38).
- **No empty pages during re-rendering:** a page keeps its old (blurry) canvas until the sharp one is
  ready, now also when a second zoom cancels the first re-render (build-time pdf.js rule). A paper-coloured
  background sits under every canvas, so an unpainted canvas never shows the dark view background.
- **Canvas memory:** new setting *Diagnostics → Zoom rendering* with presets Default / Memory saver /
  No detail canvas / pdf.js defaults. Default uses pdf.js's own iOS canvas limit (0.7.1 used a larger one),
  frees off-screen canvases when a zoom is applied and keeps rendered pages under a memory budget (D-39,
  provisional until measured on an iPad).
- **Desktop:** Ctrl/⌘ + trackpad pinch zooms continuously on the same path; a mouse-wheel notch still
  zooms one 10 % step, now anchored under the pointer.
- **Diagnostics:** the debug overlay shows canvas memory, the preset and the last zoom gesture; command
  *Export last zoom timeline to vault* writes the last gesture's frame gaps, renders, canvas memory and
  anchor error as JSON.
- Harness: new `zoom-gesture` check (9 scenarios, per-frame sampling, `--zoom-profile ipad`); WebKit
  smoke checks the kept canvas at device pixel ratio 2. Before/after numbers in docs/REPORT.md.

## 0.7.1 — 2026-11-16

- **Shared-page names (B-06):** penDF's pdf.js now names its documents `pendf_d0…` instead of `d0…`, so
  its font families and SVG filter ids no longer collide with Obsidian's own pdf.js in the same
  window. `--viewer-container-height` is set on penDF's container instead of `<html>` (penDF was
  overwriting the value Obsidian's viewer uses). Build fails if either transform stops matching;
  `check-standalone` verifies the built `main.js` (D-32, INVESTIGATION §12).
- **Fonts:** for standard fonts a PDF does not embed, no `url(embedded://…)` source any more — WebKit
  logged failed requests for it (D-33).
- **Fixtures:** font collections (`.ttc`, e.g. Ubuntu's NotoSansCJK) work — the Korean face is picked;
  one fixture failing no longer stops the others; `manifest.json` records made / skipped / failed and the
  test setup reports the cause. CI runs with and without CJK fonts.
- **WebKit smoke:** `pnpm smoke:webkit` runs penDF's PDF engine in Playwright WebKit and Chromium outside
  Obsidian (render every fixture page, worker, text layer, search, errors, built-ins, highlight math) and
  the B-06 scenarios; also in CI.
- **Test vault:** the desktop harness and `install-dev` only run in a vault marked with
  `.pendf-test-vault` (`scripts/make-test-vault.mjs`); default `pendf-testvault` (D-34).
- Harness: new checks `shared-namespace`, `ground-truth-after-core`, `ground-truth-after-embed`,
  `ground-truth-same-pdf-embed`; sidebars are restored after a run. All 31 checks pass in the test vault.
  B-06 did not reproduce there with either the old or the new build (kept open for SciWiki-only causes).

## 0.7.0 — 2026-11-15

- Side panel tabs **Pages** (page thumbnails, only visible ones drawn) and **Search** (every match in
  the document with context; tap to jump and flash). Commands *Show page thumbnails*, *Search the
  whole PDF* (D-31).
- Pen probe: stroke numbers update immediately again (0.5.1 delayed them by 0.3 s).

## 0.6.0 — 2026-11-15

- **Apple Pencil always writes** (setting, on by default): the Pencil writes with the last tool as soon
  as it touches a page; fingers keep scrolling and selecting. The toolbar pen button opens the tool bar
  (D-30).

## 0.5.2 — 2026-11-15

- Opening the side panel no longer uses `revealLeaf` (its 1.7.2 signature tripped the community
  scanner); flash rectangle built with the shared SVG helper (D-29).

## 0.5.1 — 2026-11-15

- Pen probe v3 counts iPadOS pointer cancels separately and re-checks scrolling 300 ms after pen-up.
- Eraser 10× cheaper per move on crowded pages; autosave waits while you draw (D-28).

## 0.5.0 — 2026-11-15

- **Phase 6, handwriting:** uniform-width pen, highlighter, stroke eraser, undo; Apple Pencil writes,
  fingers scroll (setting "Pencil and finger"); pen ink follows dark mode. Sidecar coordinate arrays on
  one line (D-27).

## 0.4.0 — 2026-11-15

- **Phase 5, bookmarks:** the PDF's outline, your own bookmarks (add, rename, reorder, copy link, delete),
  tabbed side panel (D-26).

## 0.3.0 — 2026-11-15

- **Phase 4, links:** copy links to highlights, notes, selections and pages; clicking one in a note opens
  penDF at that spot; without penDF the link still opens the right page in Obsidian's viewer (D-25).

## 0.2.0 — 2026-11-15

- **Phase 3, notes:** notes on highlights or page points, Markdown popover, annotations panel; deleting
  a highlight deletes its notes in one undo step (D-24).

## 0.1.5 — 2026-11-14

- **Open PDFs in penDF** (setting, on by default) through the public leaf API; "Open in Obsidian's PDF
  viewer" in the file menu (D-23).

## 0.1.4, 0.1.3, 0.1.2 — 2026-11-14

- Community scanner findings: Obsidian lint rules in `pnpm lint`, `minAppVersion` 1.5.7, declarative
  settings tab, no OS sniffing via `navigator` (D-22).

## 0.1.1 — 2026-11-14

- Release assets carry build-provenance attestations; CI on every push; `versions.json` (D-21).

## 0.1.0 — 2026-11-14

- First release. **Phase 1, viewer** (bundled modern pdf.js without global changes, continuous scroll,
  zoom, search, links, position memory, dark pages) and **Phase 2, highlights** (multi-line, multi-column,
  cross-page, recolor, undo). Named penDF (D-18, D-19, D-20).
