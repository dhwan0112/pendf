# PDF+++ sidecar format, schema v1

PDF+++ never modifies your PDFs. Annotations live in a JSON *sidecar* next to
the PDF, so they survive without the plugin and can be read by any tool.

```
Papers/attention.pdf
Papers/attention.pdf.ppp.json   ← sidecar
```

The name is always `<pdf file name>.ppp.json`, in the same folder. When the PDF
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

## Annotation types

### `highlight` (Phase 2, implemented)

| Field | Type | Meaning |
| --- | --- | --- |
| `quads` | `number[8][]` | one quad per highlighted line segment |
| `color` | string | CSS color, `#rrggbb` |
| `text` | string | the selected text, whitespace-normalized |
| `groupId` | string, optional | shared by the per-page pieces of a selection that crosses pages |

### `note` (Phase 3, reserved)

| Field | Type | Meaning |
| --- | --- | --- |
| `body` | string | Markdown |
| `target` | object | `{ "kind": "highlight", "highlightId": "<id>" }` or `{ "kind": "point", "x": <pt>, "y": <pt> }` |

### `bookmark` (Phase 5, reserved)

| Field | Type | Meaning |
| --- | --- | --- |
| `y` | number | PDF user-space y of the bookmarked position |
| `title` | string | display name |
| `order` | number | sort key (fractional values allowed) |

### `ink` (Phase 6, reserved)

| Field | Type | Meaning |
| --- | --- | --- |
| `tool` | string | `"pen"` or `"highlighter"` |
| `color` | string | CSS color |
| `width` | number > 0 | stroke width in points |
| `points` | number[] | one stroke, flattened `[x0, y0, x1, y1, …]` |

## Merging (sync conflicts)

When the file changed on disk since PDF+++ last read it (another device, a sync
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
