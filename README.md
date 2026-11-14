# penDF

A standalone, iPad-first PDF viewer and annotator for Obsidian.

- **No other plugins required.** It does not use, detect or patch Obsidian's
  built-in PDF viewer or any other plugin; it bundles its own copy of
  [PDF.js](https://mozilla.github.io/pdf.js/) and uses only Obsidian's public API.
- **Your PDFs are never modified.** Annotations are stored next to each PDF in
  `<name>.pdf.pendf.json` — a documented format (see [docs/SCHEMA.md](docs/SCHEMA.md)).
- Works offline: the PDF.js worker, CMaps (CJK), standard fonts and image
  decoders are embedded in `main.js`; nothing is fetched from the network.

## Status

All six phases: viewer, highlights, notes, links, bookmarks and handwriting. See [docs/REPORT.md](docs/REPORT.md).

| Phase | Feature | State |
| --- | --- | --- |
| 1 | Viewer: continuous scroll, virtualized pages, pinch/⌘-wheel zoom, fit width, rotation, text selection, search, internal/external links, per-file position memory, dark (inverted) pages | done (desktop-verified, iPad checklist pending) |
| 2 | Highlights: 4 colors, multi-line / multi-column / cross-page, tap to recolor / copy / delete, undo/redo | done (desktop-verified, iPad checklist pending) |
| 3 | Notes: on a highlight or a point of the page, Markdown (links, lists, tasks…), annotations panel by page | done (desktop-verified, iPad checklist pending) |
| 4 | Links: copy a link to a highlight, note, selection or page; clicking it in a note opens penDF there (and the page in Obsidian's viewer without penDF) | done (desktop-verified, iPad checklist pending) |
| 5 | Bookmarks: the PDF's outline, your own bookmarks (add, rename, reorder, copy link, delete) | done (desktop-verified, iPad checklist pending) |
| 6 | Handwriting: uniform-width pen, highlighter, stroke eraser, undo; Apple Pencil writes, fingers scroll and select | done (desktop-verified with synthetic pen input; Pencil latency and palm behaviour need an iPad) |

## Install

Not in the community plugin list yet. With [BRAT](https://github.com/TfTHacker/obsidian42-brat):
add `dhwan0112/pendf`. Or copy `main.js`, `manifest.json` and `styles.css`
from a [release](https://github.com/dhwan0112/pendf/releases) into
`<vault>/.obsidian/plugins/pendf/`.

## Use

- Just open a PDF: with **Settings → penDF → Open PDFs in penDF** (on by default) every PDF
  you open goes to penDF. The file menu offers **Open in Obsidian's PDF viewer** when you
  need the built-in one; with the setting off it offers **Open in penDF** instead.
- Command palette → **penDF: Open current PDF** / **Open a PDF…**
- Limits: PDFs embedded in notes and hover previews still use Obsidian's viewer.
- Select text → pick a color from the palette that appears. Tap a highlight to
  recolor, copy or delete it. ⌘/Ctrl+Z / ⌘/Ctrl+Shift+Z undo/redo.
- Notes: tap a highlight → note button, or toolbar **Add note** then tap the page. Tap a
  note marker to read it (Markdown), edit or delete it. Deleting a highlight deletes its notes
  too (undo brings both back).
- Toolbar **Annotations** (or command **penDF: Show annotations panel**) lists the highlights
  and notes of the open PDF page by page; tap one to jump there.
- Links: the link button in a highlight's menu, a note's popover, the selection palette or the
  toolbar (current page) copies an Obsidian link; paste it into any note. Clicking it opens penDF
  at that spot. Commands: **Copy link to current page**, **Copy link to selection**.
- Side panel (toolbar list button): **Outline** (the PDF's own table of contents), **Bookmarks**
  (yours: the toolbar bookmark button or **Bookmark this spot** marks the top of the view;
  rename, move up/down, copy link, delete) and **Annotations**.
- Handwriting: toolbar pen button (or **Toggle handwriting**) shows the ink bar: pen, highlighter,
  stroke eraser, colors, widths, **Done**. With the Apple Pencil you write while fingers still
  scroll and select text. If on your device the Pencil scrolls the page instead, set
  **Settings → penDF → Pencil and finger → Everything writes**. Undo/redo cover strokes too.
- ⌘/Ctrl+F searches.

> Obsidian Sync users: enable *Settings → Sync → Sync all other types* so the
> `.pendf.json` sidecars sync.

## Develop

```sh
pnpm install
pnpm build        # main.js + styles.css, fails above 5 MB
pnpm test         # vitest
pnpm lint         # tsc + scripts/check-standalone.mjs
pnpm fixtures     # deterministic test PDFs → fixtures/out/
node scripts/install-dev.mjs "<vault path>" --fixtures
node scripts/obsidian-harness.mjs --vault <name> --path "<vault path>"   # desktop end-to-end checks
```

Docs: [INVESTIGATION](docs/INVESTIGATION.md) · [DECISIONS](docs/DECISIONS.md) ·
[BLOCKERS](docs/BLOCKERS.md) · [DEVICE_CHECKLIST](docs/DEVICE_CHECKLIST.md) ·
[SCHEMA](docs/SCHEMA.md) · [REPORT](docs/REPORT.md)

## License

MIT. Bundles PDF.js and its data files under their own licenses — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
