# penDF sidecar format, schema v1

penDF never modifies your PDFs. Annotations live in a JSON *sidecar* next to
the PDF, so they survive without the plugin and can be read by any tool.

```
Papers/attention.pdf
Papers/attention.pdf.pendf.json   ← sidecar
```

The name is always `<pdf file name>.pendf.json`, in the same folder. When the PDF
is renamed or moved inside Obsidian, the plugin moves the sidecar with it. When
the PDF is deleted, the sidecar is kept.

> **Obsidian Sync users:** `.json` files are "other file types". Enable
> *Settings → Sync → Sync all other types* so sidecars sync between devices.

## Top level

```json
{
  "schemaVersion": 1,
  "pdfFingerprint": "50aba7a1184b3bd858f8a121abc4e624",
  "annotations": [ … ],
  "unknown": [ … ]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | integer | `1`. A plugin that finds a higher number treats the file as read-only and never rewrites it. |
| `pdfFingerprint` | string | PDF.js `fingerprints[0]` of the PDF: derived from the first entry of the trailer `/ID`, or a hash of the file start when there is no `/ID`. If it does not match the PDF, annotations are hidden and the file is left untouched (it probably belongs to another PDF). |
| `annotations` | array | Annotation objects, see below. Order carries no meaning. |
| `unknown` | array, optional | Entries this version could not validate (from a newer plugin, or hand-edited). Kept and written back verbatim, never dropped. |

## Common annotation fields

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | UUID v4, unique within the file |
| `type` | string | `"highlight"`, `"note"`, `"bookmark"` or `"ink"` |
| `page` | integer ≥ 1 | page number (1-based) |
| `createdAt` | number | ms since the Unix epoch |
| `updatedAt` | number | ms since the Unix epoch; the newer copy wins a merge |
| `deleted` | boolean | tombstone. Deleted annotations stay in the file so deletions sync. |

## Coordinates

All coordinates are **PDF user space of the page**, in points (1/72 inch), with
the origin at the bottom-left of the page's coordinate system and y pointing up.
That is the space of the page's MediaBox. A CropBox with a non-zero origin is
*not* subtracted, and the page's `/Rotate` is *not* applied. These are the
coordinates a PDF annotation's `/Rect` or `/QuadPoints` would use, so they are
independent of zoom, view rotation and screen resolution, and can be exported
to standard PDF annotations unchanged.

Quads use the Acrobat `/QuadPoints` order **relative to the displayed text**:
upper-left, upper-right, lower-left, lower-right, flattened as
`[x1, y1, x2, y2, x3, y3, x4, y4]`.

### Off-page coordinates (margin, 0.8.0)

Points may lie **outside the page box**. penDF's margin (D-41) stores the handwriting and notes
written beside a page as ordinary points of that page's PDF user space, just beyond its box. Readers
must not clip or reject them.

- **Which side is "right":** the side of the page as it is displayed with the page's own `/Rotate`
  applied (its intrinsic orientation), not the side of the screen. A point right of the page on a
  page with `/Rotate 90` is therefore beyond the page box in the direction that `/Rotate 90` turns to
  the right. When the reader rotates the view, the margin turns with the page: the content stays next
  to the same edge of the page.
- **Extent:** a margin is as wide as `ratio × page width` (the width of the page box in its intrinsic
  orientation); penDF opens a margin automatically, wide enough for the content it finds (up to 3×
  the page width).
- The margin's visibility and width are a *view* setting kept in the plugin's data per PDF, never in
  the sidecar: a sidecar only has the points.
- Writing such annotations into the PDF (Phase 11) needs a MediaBox / CropBox enlarged to contain them.

## Annotation types

### `highlight` (Phase 2, implemented)

| Field | Type | Meaning |
| --- | --- | --- |
| `quads` | `number[8][]` | one quad per highlighted line segment |
| `color` | string | CSS color, `#rrggbb` |
| `text` | string | the selected text, whitespace-normalized |
| `groupId` | string, optional | shared by the per-page pieces of a selection that crosses pages |

### `note` (Phase 3)

| Field | Type | Meaning |
| --- | --- | --- |
| `body` | string | Markdown |
| `target` | object | `{ "kind": "annotation", "id": "<id>" }`, `{ "kind": "highlight", "highlightId": "<id>" }` or `{ "kind": "point", "x": <pt>, "y": <pt> }` |

`annotation` (0.8.0) attaches the note to any annotation by id — penDF writes it for area excerpts.
`highlight` is the older form for the same thing; penDF still writes it for notes on highlights, so
0.7.x shows those notes, and reads both forms everywhere. 0.7.x keeps an `annotation` note it cannot
read in `unknown` and writes it back unchanged.

A note on a highlight is drawn at the top-right corner of the highlight's first quad (its `UR` point),
a note on an area at the area's `UR` corner; `page` is that annotation's page. A point note is drawn at `(x, y)` in PDF user space. Deleting a
highlight in penDF also tombstones its notes. A note whose highlight no longer exists (for
example after a merge) is kept and listed in the annotations panel, but has no marker on the page.

### `bookmark` (Phase 5)

| Field | Type | Meaning |
| --- | --- | --- |
| `y` | number | PDF user-space y of the bookmarked position |
| `title` | string | display name |
| `order` | number | sort key (fractional values allowed) |

Bookmarks are listed by `order`, then `createdAt`. Moving one sets its `order` between its new
neighbours; when that gap gets too small, all bookmarks are renumbered 1, 2, 3…. The PDF's own
outline is only read, never written.

### `ink` (Phase 6)

| Field | Type | Meaning |
| --- | --- | --- |
| `tool` | string | `"pen"` or `"highlighter"` |
| `color` | string | CSS color |
| `width` | number > 0 | stroke width in points |
| `points` | number[] | one stroke, flattened `[x0, y0, x1, y1, …]` |
| `opacity` | number, optional | highlighter only: 0 < opacity ≤ 1; absent = 0.35 (D-46) |

Points are in PDF user space, rounded to 0.01 pt and simplified (Ramer–Douglas–Peucker, 0.08 pt for
the pen, 0.3 pt for the highlighter). A single point is a dot. The pen draws with a uniform width
(no pressure). The highlighter is drawn at its `opacity` (default 35 %), blended with the page like text highlights.
Versions without `opacity` keep the field and draw the stroke at 35 %.

penDF writes coordinate arrays (`points`, `quads`, `quad`) on one line each; the file is still plain JSON.

### `area` (Phase 7b, 0.8.0)

| Field | Type | Meaning |
| --- | --- | --- |
| `quad` | number[8] | the excerpt, PDF user space, same order as a highlight quad (UL, UR, LL, LR as displayed) |
| `color` | string | CSS color |
| `text` | string | text of the page's text layer inside the area (items whose centre lies inside), `""` if none |
| `label` | string, optional | caption |

Only coordinates are stored. The image is rendered from the PDF when it is copied, saved or shown in
the panel. penDF 0.7.x does not know this type: it keeps such entries in `unknown` and writes them
back unchanged; 0.8.0 reads them back out of `unknown` (the usual merge rules decide if the same id
is also in `annotations`). The schema version stays 1 (D-44).

## Links (Phase 4)

penDF links are ordinary Obsidian links to the PDF with a subpath, created with
Obsidian's own link settings (wikilink or Markdown, shortest or full path):

```
[[paper.pdf#page=5&pendf=<annotation id>|quoted text]]      a highlight or a note
[[paper.pdf#page=12&pendf-rect=72,500,300,520|quoted text]]  a text selection (x0,y0,x1,y1 in PDF points)
[[paper.pdf#page=3|paper, p. 3]]                             a page
```

`page` is Obsidian's own parameter: without penDF, Obsidian's PDF viewer opens the PDF on that
page and ignores the `pendf…` parameters. With penDF, the link opens penDF, scrolls to the
annotation or rectangle and flashes it (a note also opens its popover). If the annotation no
longer exists, the page is shown.

## Merging (sync conflicts)

When the file changed on disk since penDF last read it (another device, a sync
client), the two versions are merged per annotation `id`:

1. union of all ids
2. a deleted copy wins over a live one
3. otherwise the copy with the larger `updatedAt` wins
4. exact ties are broken deterministically, so all devices converge

The same rules apply to duplicate ids inside one file.

## Writing

The plugin writes `<sidecar>.tmp` and renames it over the sidecar. If it is
interrupted, the `.tmp` file is used on the next load.

## Example

```json
{
  "schemaVersion": 1,
  "pdfFingerprint": "6d3dada6806c176373a41ec3a8790640",
  "annotations": [
    {
      "id": "2f0c5d0e-8a1b-4b7e-9f55-0f9a3a0d6c11",
      "type": "highlight",
      "page": 1,
      "createdAt": 1794460000000,
      "updatedAt": 1794460000000,
      "deleted": false,
      "quads": [[56.01, 752.27, 357.96, 752.27, 56.01, 734.75, 357.96, 734.75]],
      "color": "#ffd400",
      "text": "This line is near the top-left corner of the unrotated page."
    }
  ]
}
```
