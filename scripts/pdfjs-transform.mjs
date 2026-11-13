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
  ],
  "pdf_viewer.mjs": [
    {
      name: "read pdf.js API from the bundled module, not globalThis.pdfjsLib",
      find: /\} = globalThis\.pdfjsLib;/g,
      replace: "} = __pppPdfjs;",
      count: 1,
    },
    {
      name: "drop globalThis.pdfjsViewer write",
      find: /globalThis\.pdfjsViewer = \{[\s\S]*?\};/g,
      replace: "",
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

export const VIEWER_PRELUDE = 'import * as __pppPdfjs from "pdfjs-dist/build/pdf.mjs";\n';

/**
 * Apply the rules for `key` to `src`. Throws if any rule matches a different
 * number of times than expected.
 * @param {string} key
 * @param {string} src
 */
export function transform(key, src) {
  const rules = RULES[key];
  if (!rules) throw new Error(`no pdfjs transform rules for ${key}`);
  let out = src;
  for (const rule of rules) {
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
