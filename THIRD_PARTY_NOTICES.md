# Third-party notices

`main.js` and `styles.css` bundle the following, unmodified except for the
build-time transforms in `scripts/pdfjs-transform.mjs` (removal of global
variable writes/reads) and `scripts/scope-css.mjs` (CSS scoping):

| Component | Version | License | Included as |
| --- | --- | --- | --- |
| [PDF.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`, legacy build) | 6.5.438 | Apache-2.0 | display layer, viewer components, worker, viewer CSS |
| PDF.js CMaps (Adobe) | from pdfjs-dist 6.5.438 | BSD-3-Clause (Adobe) | `cmaps/*.bcmap`, embedded gzip+base64 |
| Foxit standard fonts | from pdfjs-dist 6.5.438 | BSD-style (see `LICENSE_FOXIT`) | `standard_fonts/*.pfb`, embedded |
| Liberation Sans | from pdfjs-dist 6.5.438 | SIL OFL 1.1 | `standard_fonts/*.ttf`, embedded |
| OpenJPEG decoder (wasm) | from pdfjs-dist 6.5.438 | BSD-2-Clause | `wasm/openjpeg.wasm`, embedded |
| JBIG2 decoder (wasm, pdf.js-jbig2) | from pdfjs-dist 6.5.438 | Apache-2.0 / see `LICENSE_JBIG2` | `wasm/jbig2.wasm`, embedded |
| core-js polyfills (inside the PDF.js legacy build) | as shipped | MIT | part of the PDF.js legacy build |

Full license texts are in `node_modules/pdfjs-dist/` (`LICENSE`,
`standard_fonts/LICENSE_*`, `wasm/LICENSE_*`) and are reproduced in release
notes.
