// Shared build pieces: the pdf.js plugin (transforms + ponyfills + embedded
// worker and assets) and the scoped CSS. Used by esbuild.config.mjs (main.js)
// and scripts/webkit (engine bundle for the WebKit smoke test).
import esbuild from "esbuild";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "./pdfjs-transform.mjs";
import { ponyfill } from "./pdfjs-ponyfill.mjs";
import { scopeCss } from "./scope-css.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));

// Modern pdf.js build + call-site ponyfills (scripts/pdfjs-ponyfill.mjs).
// The legacy build's core-js polyfills would add to — and in Chromium 138
// replace — built-ins on the window every plugin shares. docs/INVESTIGATION.md §10.
const PDF = path.join(pdfjsRoot, "build", "pdf.mjs");
const VIEWER = path.join(pdfjsRoot, "web", "pdf_viewer.mjs");
const WORKER = path.join(pdfjsRoot, "build", "pdf.worker.mjs");
const CSS = path.join(pdfjsRoot, "web", "pdf_viewer.css");
export const TARGET = "es2022";

// Binary assets the worker asks the main thread for (useWorkerFetch: false).
// Keyed by "<factory kind>/<filename>" — see src/pdfjs/assets.ts.
const ASSET_DIRS = [
	{ kind: "cMapUrl", dir: "cmaps", filter: (f) => f.endsWith(".bcmap") },
	{ kind: "standardFontDataUrl", dir: "standard_fonts", filter: (f) => /\.(pfb|ttf)$/.test(f) },
	{ kind: "wasmUrl", dir: "wasm", filter: (f) => f === "openjpeg.wasm" || f === "jbig2.wasm" },
];

const gzB64 = (buf) => gzipSync(buf, { level: 9 }).toString("base64");
export const ponyfillStats = {};

/** global-stripping transform + ponyfill rewrite of one pdf.js module */
function pdfjsSource(key, file, skip = []) {
	const { code, stats } = ponyfill(transform(key, readFileSync(file, "utf8"), { skip }), key);
	ponyfillStats[key] = stats;
	return code;
}

function buildWorkerSource(skip) {
	const res = esbuild.transformSync(pdfjsSource("pdf.worker.mjs", WORKER, skip), {
		loader: "js",
		format: "esm",
		target: TARGET,
		minify: true,
		legalComments: "none",
		logLevel: "silent",
	});
	if (res.warnings.length) throw new Error("worker transform warnings:\n" + res.warnings.map((w) => w.text).join("\n"));
	return res.code;
}

function buildAssetsModule(skip) {
	const workerSrc = buildWorkerSource(skip);
	const assets = {};
	const sizes = { worker: { raw: Buffer.byteLength(workerSrc), embedded: 0 } };
	for (const { kind, dir, filter } of ASSET_DIRS) {
		let raw = 0;
		let embedded = 0;
		for (const f of readdirSync(path.join(pdfjsRoot, dir)).filter(filter).sort()) {
			const buf = readFileSync(path.join(pdfjsRoot, dir, f));
			const enc = gzB64(buf);
			assets[`${kind}/${f}`] = enc;
			raw += buf.length;
			embedded += enc.length;
		}
		sizes[kind] = { raw, embedded };
	}
	const worker = gzB64(Buffer.from(workerSrc, "utf8"));
	sizes.worker.embedded = worker.length;
	const code = `export const WORKER_GZ = ${JSON.stringify(worker)};\n` + `export const ASSETS_GZ = ${JSON.stringify(assets)};\n`;
	return { code, sizes };
}

export const buildInfo = { assetSizes: null };

/**
 * esbuild plugin: maps "pdfjs-dist" imports to the transformed modern build
 * and provides the virtual "pendf:assets" module (gzipped worker + assets).
 * @param {{ skipRules?: string[] }} [opts] transform rules to leave out (evidence builds only)
 * @returns {esbuild.Plugin}
 */
export function pdfjsPlugin({ skipRules = [] } = {}) {
	return {
	name: "pdfjs-standalone",
	setup(build) {
		build.onResolve({ filter: /^pdfjs-dist(\/.*)?$/ }, (args) => {
			if (args.path === "pdfjs-dist" || args.path === "pdfjs-dist/build/pdf.mjs") return { path: PDF };
			if (args.path === "pdfjs-dist/web/pdf_viewer.mjs") return { path: VIEWER };
			return { errors: [{ text: `import of ${args.path} is not allowed; use "pdfjs-dist" or "pdfjs-dist/web/pdf_viewer.mjs"` }] };
		});
		build.onLoad({ filter: /[\\/]pdfjs-dist[\\/](build[\\/]pdf|web[\\/]pdf_viewer)\.mjs$/ }, (args) => {
			const key = args.path.endsWith("pdf_viewer.mjs") ? "pdf_viewer.mjs" : "pdf.mjs";
			return { contents: pdfjsSource(key, args.path, skipRules), loader: "js", resolveDir: path.dirname(args.path) };
		});
		build.onResolve({ filter: /^pendf:assets$/ }, () => ({ path: "pendf:assets", namespace: "pendf-assets" }));
		build.onLoad({ filter: /.*/, namespace: "pendf-assets" }, () => {
			const { code, sizes } = buildAssetsModule(skipRules);
			buildInfo.assetSizes = sizes;
			return { contents: code, loader: "js" };
		});
	},
	};
}

export function buildCss() {
	const pdfCss = scopeCss(readFileSync(CSS, "utf8"), ".pendf-root");
	const own = readFileSync(path.join(root, "src", "styles.css"), "utf8");
	const header = "/* penDF styles. The pdf.js viewer CSS below is scoped to .pendf-root (Apache-2.0, Mozilla Foundation). */\n";
	writeFileSync(path.join(root, "styles.css"), header + own + "\n/* ---- pdf.js viewer (scoped) ---- */\n" + pdfCss);
}

