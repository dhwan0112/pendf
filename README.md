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

Phases 1–3 (viewer, highlights, notes) of six. See [docs/REPORT.md](docs/REPORT.md).

| Phase | Feature | State |
| --- | --- | --- |
| 1 | Viewer: continuous scroll, virtualized pages, pinch/⌘-wheel zoom, fit width, rotation, text selection, search, internal/external links, per-file position memory, dark (inverted) pages | done (desktop-verified, iPad checklist pending) |
| 2 | Highlights: 4 colors, multi-line / multi-column / cross-page, tap to recolor / copy / delete, undo/redo | done (desktop-verified, iPad checklist pending) |
| 3 | Notes: on a highlight or a point of the page, Markdown (links, lists, tasks…), annotations panel by page | done (desktop-verified, iPad checklist pending) |
| 4–6 | Links, bookmarks, handwriting | schema reserved, not implemented |

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
- Limits: PDFs embedded in notes and hover previews still use Obsidian's viewer, and a
  link to a page (`[[file.pdf#page=3]]`) opens penDF at your last position, not that page.
- Select text → pick a color from the palette that appears. Tap a highlight to
  recolor, copy or delete it. ⌘/Ctrl+Z / ⌘/Ctrl+Shift+Z undo/redo.
- Notes: tap a highlight → note button, or toolbar **Add note** then tap the page. Tap a
  note marker to read it (Markdown), edit or delete it. Deleting a highlight deletes its notes
  too (undo brings both back).
- Toolbar **Annotations** (or command **penDF: Show annotations panel**) lists the highlights
  and notes of the open PDF page by page; tap one to jump there.
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
