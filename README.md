# PDF+++ (working name)

A standalone, iPad-first PDF viewer and annotator for Obsidian.

- **No other plugins required.** It does not use, detect or patch Obsidian's
  built-in PDF viewer or any other plugin; it bundles its own copy of
  [PDF.js](https://mozilla.github.io/pdf.js/) and uses only Obsidian's public API.
- **Your PDFs are never modified.** Annotations are stored next to each PDF in
  `<name>.pdf.ppp.json` — a documented format (see [docs/SCHEMA.md](docs/SCHEMA.md)).
- Works offline: the PDF.js worker, CMaps (CJK), standard fonts and image
  decoders are embedded in `main.js`; nothing is fetched from the network.

## Status

Phase 1 (viewer) and Phase 2 (highlights) of six. See [docs/REPORT.md](docs/REPORT.md).

| Phase | Feature | State |
| --- | --- | --- |
| 1 | Viewer: continuous scroll, virtualized pages, pinch/⌘-wheel zoom, fit width, rotation, text selection, search, internal/external links, per-file position memory, dark (inverted) pages | done (desktop-verified, iPad checklist pending) |
| 2 | Highlights: 4 colors, multi-line / multi-column / cross-page, tap to recolor / copy / delete, undo/redo | done (desktop-verified, iPad checklist pending) |
| 3–6 | Notes, links, bookmarks, handwriting | schema reserved, not implemented |

## Use

- File menu on a PDF → **Open in PDF+++**
- Command palette → **PDF+++: Open current PDF in PDF+++** / **Open a PDF…**
- Select text → pick a color from the palette that appears. Tap a highlight to
  recolor, copy or delete it. ⌘/Ctrl+Z / ⌘/Ctrl+Shift+Z undo/redo.
- ⌘/Ctrl+F searches.

> Obsidian Sync users: enable *Settings → Sync → Sync all other types* so the
> `.ppp.json` sidecars sync.

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
