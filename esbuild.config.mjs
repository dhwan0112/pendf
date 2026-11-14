// Build: main.js (plugin + bundled pdf.js + embedded worker/assets) and styles.css.
import esbuild from "esbuild";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "./scripts/pdfjs-transform.mjs";
import { ponyfill } from "./scripts/pdfjs-ponyfill.mjs";
import { scopeCss } from "./scripts/scope-css.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
const prod = process.argv[2] === "production";

// Modern pdf.js build + call-site ponyfills (scripts/pdfjs-ponyfill.mjs).
// The legacy build's core-js polyfills would add to — and in Chromium 138
// replace — built-ins on the window every plugin shares. docs/INVESTIGATION.md §10.
const PDF = path.join(pdfjsRoot, "build", "pdf.mjs");
const VIEWER = path.join(pdfjsRoot, "web", "pdf_viewer.mjs");
const WORKER = path.join(pdfjsRoot, "build", "pdf.worker.mjs");
const CSS = path.join(pdfjsRoot, "web", "pdf_viewer.css");
const TARGET = "es2022";

// Binary assets the worker asks the main thread for (useWorkerFetch: false).
// Keyed by "<factory kind>/<filename>" — see src/pdfjs/assets.ts.
const ASSET_DIRS = [
	{ kind: "cMapUrl", dir: "cmaps", filter: (f) => f.endsWith(".bcmap") },
	{ kind: "standardFontDataUrl", dir: "standard_fonts", filter: (f) => /\.(pfb|ttf)$/.test(f) },
	{ kind: "wasmUrl", dir: "wasm", filter: (f) => f === "openjpeg.wasm" || f === "jbig2.wasm" },
];

const gzB64 = (buf) => gzipSync(buf, { level: 9 }).toString("base64");
const ponyfillStats = {};

/** global-stripping transform + ponyfill rewrite of one pdf.js module */
function pdfjsSource(key, file) {
	const { code, stats } = ponyfill(transform(key, readFileSync(file, "utf8")), key);
	ponyfillStats[key] = stats;
	return code;
}

function buildWorkerSource() {
	const res = esbuild.transformSync(pdfjsSource("pdf.worker.mjs", WORKER), {
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

function buildAssetsModule() {
	const workerSrc = buildWorkerSource();
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

let assetSizes = null;

/** @type {esbuild.Plugin} */
const pdfjsStandalone = {
	name: "pdfjs-standalone",
	setup(build) {
		build.onResolve({ filter: /^pdfjs-dist(\/.*)?$/ }, (args) => {
			if (args.path === "pdfjs-dist" || args.path === "pdfjs-dist/build/pdf.mjs") return { path: PDF };
			if (args.path === "pdfjs-dist/web/pdf_viewer.mjs") return { path: VIEWER };
			return { errors: [{ text: `import of ${args.path} is not allowed; use "pdfjs-dist" or "pdfjs-dist/web/pdf_viewer.mjs"` }] };
		});
		build.onLoad({ filter: /[\\/]pdfjs-dist[\\/](build[\\/]pdf|web[\\/]pdf_viewer)\.mjs$/ }, (args) => {
			const key = args.path.endsWith("pdf_viewer.mjs") ? "pdf_viewer.mjs" : "pdf.mjs";
			return { contents: pdfjsSource(key, args.path), loader: "js", resolveDir: path.dirname(args.path) };
		});
		build.onResolve({ filter: /^pendf:assets$/ }, () => ({ path: "pendf:assets", namespace: "pendf-assets" }));
		build.onLoad({ filter: /.*/, namespace: "pendf-assets" }, () => {
			const { code, sizes } = buildAssetsModule();
			assetSizes = sizes;
			return { contents: code, loader: "js" };
		});
	},
};

function buildCss() {
	const pdfCss = scopeCss(readFileSync(CSS, "utf8"), ".pendf-root");
	const own = readFileSync(path.join(root, "src", "styles.css"), "utf8");
	const header = "/* penDF styles. The pdf.js viewer CSS below is scoped to .pendf-root (Apache-2.0, Mozilla Foundation). */\n";
	writeFileSync(path.join(root, "styles.css"), header + own + "\n/* ---- pdf.js viewer (scoped) ---- */\n" + pdfCss);
}

const ctx = await esbuild.context({
	entryPoints: [path.join(root, "src", "main.ts")],
	bundle: true,
	external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
	format: "cjs",
	target: TARGET,
	platform: "browser",
	logLevel: "info",
	logOverride: { "empty-import-meta": "silent" },
	sourcemap: prod ? false : "inline",
	minify: prod,
	treeShaking: true,
	legalComments: "none",
	banner: { js: "/* penDF — bundles pdf.js (Apache-2.0, Mozilla Foundation). See LICENSE and THIRD_PARTY_NOTICES.md. */" },
	outfile: path.join(root, "main.js"),
	plugins: [pdfjsStandalone],
});

if (prod) {
	await ctx.rebuild();
	await ctx.dispose();
	buildCss();
	const mainSize = statSync(path.join(root, "main.js")).size;
	const cssSize = statSync(path.join(root, "styles.css")).size;
	const report = { mainJs: mainSize, stylesCss: cssSize, assets: assetSizes, ponyfills: ponyfillStats, limit: 5 * 1024 * 1024 };
	writeFileSync(path.join(root, "build-size.json"), JSON.stringify(report, null, 2) + "\n");
	const mb = (n) => (n / 1024 / 1024).toFixed(2) + " MB";
	console.log(`main.js ${mb(mainSize)}  styles.css ${(cssSize / 1024).toFixed(0)} KB`);
	if (mainSize >= report.limit) {
		console.error(`main.js is ${mb(mainSize)}, over the 5 MB Obsidian Sync Standard limit`);
		process.exit(1);
	}
} else {
	buildCss();
	await ctx.watch();
}
