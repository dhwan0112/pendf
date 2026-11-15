# Changelog

All releases are on GitHub (tag = version, no "v"); each release's `main.js`, `manifest.json` and
`styles.css` carry build-provenance attestations from 0.1.1 on. Decisions are in
[docs/DECISIONS.md](docs/DECISIONS.md) (D-numbers below).

## 0.7.1 — unreleased

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
  `ground-truth-same-pdf-embed`; sidebars are restored after a run.

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
