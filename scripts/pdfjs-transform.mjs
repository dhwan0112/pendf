// Source transforms that make the bundled pdf.js self-contained.
//
// The stock pdf.js builds talk to each other (and to the page) through
// globals: `pdf.mjs` writes `globalThis.pdfjsLib`, `pdf_viewer.mjs` reads it,
// and the worker writes `globalThis.pdfjsWorker`. Obsidian core exposes its own
// pdf.js as `window.pdfjsLib`, so every one of these would either clobber the
// core copy or silently pick up the wrong version. We rewrite them at build
// time so that our copy never reads or writes a pdfjs* global.
//
// Each rule must match exactly the expected number of times. If a pdf.js
// upgrade changes the source shape, the build fails loudly instead of
// shipping a bundle that leaks into the global scope.

/** @typedef {{ name: string, find: RegExp, replace: string, count: number }} Rule */

/** @type {Record<string, Rule[]>} */
export const RULES = {
  "pdf.mjs": [
    {
      name: "drop testing-utils global",
      find: /\{\s*globalThis\._pdfjsTestingUtils = \{[\s\S]*?\};\s*\}/g,
      replace: "",
      count: 1,
    },
    {
      name: "drop globalThis.pdfjsLib write",
      find: /globalThis\.pdfjsLib = \{[\s\S]*?\};/g,
      replace: "",
      count: 1,
    },
    {
      name: "never read globalThis.pdfjsWorker (fake-worker shortcut)",
      find: /globalThis\.pdfjsWorker\?\.WorkerMessageHandler/g,
      replace: "null",
      count: 1,
    },
    {
      // Every pdf.js copy numbers its documents d0, d1, … from zero, and the
      // document id prefixes names it puts into the *shared* page: font
      // families in document.fonts (g_d0_f1…) and SVG filter ids
      // (g_d0_transfer_map_…). Obsidian's own pdf.js would use the same names
      // for different fonts (B-06, INVESTIGATION §12). The worker builds its
      // names from the id it receives, so this one place covers both sides.
      name: "penDF-unique document id prefix (shared font / filter names)",
      find: /docId = `d\$\{PDFDocumentLoadingTask\.#docId\+\+\}`;/g,
      replace: "docId = `pendf_d${PDFDocumentLoadingTask.#docId++}`;",
      count: 1,
    },
  ],
  "pdf_viewer.mjs": [
    {
      name: "read pdf.js API from the bundled module, not globalThis.pdfjsLib",
      find: /\} = globalThis\.pdfjsLib;/g,
      replace: "} = __pendfPdfjs;",
      count: 1,
    },
    {
      name: "drop globalThis.pdfjsViewer write",
      find: /globalThis\.pdfjsViewer = \{[\s\S]*?\};/g,
      replace: "",
      count: 1,
    },
    {
      // PDFViewer writes --viewer-container-height on <html>, which Obsidian's
      // viewer reads too; penDF's scoped CSS resets it on .pendf-root anyway.
      // Write it on our own scroll container instead (INVESTIGATION §12).
      name: "--viewer-container-height on the viewer container, not <html>",
      find: /docStyle\.setProperty\("--viewer-container-height", `\$\{height\}px`\);/g,
      replace: "this.container.style.setProperty(\"--viewer-container-height\", `${height}px`);",
      count: 1,
    },
    {
      // A page re-rendered at a new scale keeps its old canvas on screen
      // (CSS-scaled) until the new one is complete. But when that render is
      // cancelled — the page is updated again before it finished, e.g. a second
      // pinch right after the first — pdf.js drops the old canvas too, and the
      // page shows nothing until the next render completes (0.7.2, D-38).
      // Keep the old canvas instead; the next render replaces it as usual.
      // Runs synchronously inside RenderTask.cancel(), before any new draw().
      name: "keep the old page canvas when a re-render is cancelled",
      find: /\(\) => \{\n(\s*)if \(prevCanvas\) \{\n\s*prevCanvas\.remove\(\);\n\s*prevCanvas\.width = prevCanvas\.height = 0;\n\s*\}\n\s*this\._resetCanvas\(\);\n(\s*)\}, renderTask => \{/g,
      replace:
        "() => {\n$1if (prevCanvas?.isConnected && !canvas.isConnected) {\n$1  this.pendfKeptCanvas = (this.pendfKeptCanvas ?? 0) + 1;\n$1  canvas.width = canvas.height = 0;\n$1  this.canvas = prevCanvas;\n$1  return;\n$1}\n$1if (prevCanvas) {\n$1  prevCanvas.remove();\n$1  prevCanvas.width = prevCanvas.height = 0;\n$1}\n$1this._resetCanvas();\n$2}, renderTask => {",
      count: 1,
    },
  ],
  "pdf.worker.mjs": [
    {
      name: "drop globalThis.pdfjsWorker write in worker",
      find: /globalThis\.pdfjsWorker = \{\s*WorkerMessageHandler: WorkerMessageHandler\s*\};/g,
      replace: "",
      count: 1,
    },
    {
      // For standard fonts the PDF does not embed, pdf.js builds a CSS font
      // source "local(<system font>), …, url(<standardFontDataUrl><file>)".
      // penDF's standardFontDataUrl is the internal "embedded://" address served
      // by its BinaryDataFactory, which a browser cannot fetch: WebKit logs a
      // failed request whenever no local font matches (WebKit smoke, D-33).
      // Keep the local() sources, skip the unfetchable url().
      name: "no url() font source for penDF's embedded:// standard fonts",
      find: /if \(usePath && path && localFontPath\) \{/g,
      replace: 'if (usePath && path && localFontPath && !String(localFontPath).startsWith("embedded:")) {',
      count: 1,
    },
  ],
  "pdf.worker.min.mjs": [
    {
      name: "drop globalThis.pdfjsWorker write in worker",
      find: /globalThis\.pdfjsWorker=\{WorkerMessageHandler:?[A-Za-z_$]*\}[;,]?/g,
      replace: "",
      count: 1,
    },
  ],
};

export const VIEWER_PRELUDE = 'import * as __pendfPdfjs from "pdfjs-dist/build/pdf.mjs";\n';

/**
 * Apply the rules for `key` to `src`. Throws if any rule matches a different
 * number of times than expected.
 * @param {string} key
 * @param {string} src
 */
export function transform(key, src, { skip = [] } = {}) {
  const rules = RULES[key];
  if (!rules) throw new Error(`no pdfjs transform rules for ${key}`);
  let out = src;
  // `skip` exists only for evidence builds (scripts/webkit: "before the fix" bundles)
  for (const rule of rules.filter((r) => !skip.includes(r.name))) {
    const hits = out.match(rule.find)?.length ?? 0;
    if (hits !== rule.count) {
      throw new Error(
        `pdfjs-transform[${key}] "${rule.name}": expected ${rule.count} match(es), found ${hits}. ` +
          "The pdf.js source shape changed; update scripts/pdfjs-transform.mjs.",
      );
    }
    out = out.replace(rule.find, rule.replace);
  }
  if (key === "pdf_viewer.mjs") out = VIEWER_PRELUDE + out;
  return out;
}
