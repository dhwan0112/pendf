#!/usr/bin/env node
// Browser smoke test of penDF's PDF engine outside Obsidian, in WebKit (the
// iPad's engine family) and Chromium (Obsidian desktop's), via Playwright.
//
//   node scripts/webkit/smoke.mjs [--browsers webkit,chromium] [--b06] [--out file.json]
//
// Checks (per browser): the Blob worker starts; every page of every fixture
// renders and yields text; the viewer builds a text layer; search finds
// matches; no page errors, console errors or unhandled rejections; built-ins
// are unchanged after rendering; the highlight math (selection → quads) hits
// the fixtures' ground truth, and Chromium and WebKit agree.
// --b06 also runs the shared-namespace scenarios (INVESTIGATION §12): a
// stand-in for Obsidian's pdf.js (pdfjs-dist 5.3.31) opens a PDF first, then
// penDF — with the namespace fix and without it.
//
// Limits: Playwright's WebKit is not iOS WKWebView (different OS integration,
// memory limits, touch/Pencil input, Obsidian's app shell). This catches
// syntax / built-in / worker / rendering problems, not device behaviour.

import esbuild from "esbuild";
import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { chromium, webkit } from "playwright";
import { TARGET, buildCss, pdfjsPlugin, root } from "../build-lib.mjs";

const args = process.argv.slice(2);
const arg = (k, d) => {
	const i = args.indexOf(k);
	return i >= 0 ? args[i + 1] : d;
};
const browsers = arg("--browsers", "webkit,chromium").split(",");
const withB06 = args.includes("--b06");
// scenarios only use fixtures that exist (korean-embedded.pdf needs a Hangul font on the machine)
const haveFixture = (f) => existsSync(path.join(root, "fixtures", "out", f));
const coreFiles = arg("--core-files", "a4.pdf,korean-embedded.pdf").split(",").filter(haveFixture);
const outFile = path.resolve(arg("--out", path.join(root, "scripts", "webkit", "out", "result.json")));
const outDir = path.join(root, "scripts", "webkit", "out");
mkdirSync(outDir, { recursive: true });

const NAMESPACE_RULES = ["penDF-unique document id prefix (shared font / filter names)", "--viewer-container-height on the viewer container, not <html>"];

// ------------------------------------------------------------------ build
async function bundle(file, skipRules) {
	await esbuild.build({
		entryPoints: [path.join(root, "scripts", "webkit", "engine-entry.ts")],
		bundle: true,
		format: "iife",
		platform: "browser",
		target: TARGET,
		outfile: path.join(outDir, file),
		logLevel: "warning",
		logOverride: { "empty-import-meta": "silent" },
		minify: true,
		plugins: [pdfjsPlugin({ skipRules })],
	});
}
await bundle("engine.js", []);
if (withB06) await bundle("engine-before.js", NAMESPACE_RULES);
if (!existsSync(path.join(root, "styles.css"))) buildCss();
const fixturesDir = path.join(root, "fixtures", "out");
const fixtures = readdirSync(fixturesDir).filter((f) => f.endsWith(".pdf")).sort();
const expected = JSON.parse(readFileSync(path.join(fixturesDir, "expected.json"), "utf8"));
if (fixtures.length === 0) throw new Error("no fixtures; run pnpm fixtures");

// ----------------------------------------------------------------- server
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".pdf": "application/pdf", ".json": "application/json", ".map": "application/json", ".bcmap": "application/octet-stream", ".pfb": "application/octet-stream", ".ttf": "font/ttf", ".wasm": "application/wasm" };
const server = http.createServer((req, res) => {
	const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
	const file = path.resolve(root, "." + url);
	if (!file.startsWith(root + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
		res.writeHead(404).end();
		return;
	}
	res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
	res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------------------------- run
const engines = { webkit, chromium };
const result = { at: new Date().toISOString(), node: process.version, fixtures, browsers: {}, b06: [] };
let failures = [];

async function openPage(browser) {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	const problems = [];
	page.on("pageerror", (e) => problems.push("pageerror: " + String(e.stack || e).slice(0, 300)));
	page.on("console", (m) => {
		if (m.type() === "error") problems.push("console.error: " + m.text().slice(0, 300) + (m.location()?.url ? ` @ ${m.location().url.slice(0, 120)}` : ""));
	});
	page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url().slice(0, 120)} (${r.failure()?.errorText ?? "?"})`));
	await page.goto(base + "/scripts/webkit/page.html");
	await page.addScriptTag({ url: "/scripts/webkit/page-tests.js" });
	return { page, problems };
}

for (const name of browsers) {
	const browser = await engines[name].launch();
	try {
		const { page, problems } = await openPage(browser);
		await page.evaluate(() => window.__tests.snapshot());
		await page.addScriptTag({ url: "/scripts/webkit/out/engine.js" });
		const smoke = await page.evaluate((cfg) => window.__tests.smoke(cfg), { fixtures, expected });
		const builtins = await page.evaluate(() => window.__tests.diff(["__pendf"]));
		const inPage = await page.evaluate(() => window.__tests.errors());
		const errors = [...problems, ...inPage];
		result.browsers[name] = { version: browser.version(), ...smoke, builtins, errors };
		const fail = (m) => failures.push(`${name}: ${m}`);
		for (const [f, r] of Object.entries(smoke.fixtures)) if (r.rendered !== r.pages) fail(`${f}: rendered ${r.rendered}/${r.pages}`);
		if (smoke.workerMode !== "web-worker") fail(`worker mode ${smoke.workerMode}`);
		if (!(smoke.viewer.textLayerSpans > 0)) fail("no text layer spans");
		if (!(smoke.viewer.searchMatches > 0)) fail("search found nothing");
		if (errors.length) fail(`${errors.length} error(s): ${errors[0]}`);
		for (const k of ["added", "replaced", "removed"]) if (builtins[k].length) fail(`built-ins ${k}: ${builtins[k].join(", ")}`);
		for (const g of smoke.groundTruth) if (g.quads !== 1 || Math.abs(g.dxStart) >= 2.5 || Math.abs(g.dxEnd) >= 3) fail(`ground truth ${g.file} p${g.page}: quads ${g.quads} dxStart ${g.dxStart} dxEnd ${g.dxEnd}`);
		await page.close();

		if (withB06) {
			// [coreFirst, core PDF, penDF PDF]; the last pair has two *different embedded* fonts at g_d0_f1
			const collide = "/scripts/webkit/out/collide-embedded.pdf";
			const scenarios = [[false, null, "rotations.pdf"], ...coreFiles.map((f) => [true, f, "rotations.pdf"])];
			if (existsSync(path.join(outDir, "collide-embedded.pdf"))) {
				scenarios.push([false, null, collide]);
				if (haveFixture("korean-embedded.pdf")) scenarios.push([true, "korean-embedded.pdf", collide]);
				else console.log("B-06: korean-embedded.pdf missing (no Hangul font) — skipping the embedded-vs-embedded collision scenario");
			}
			for (const variant of ["before", "after"]) {
				for (const [coreFirst, coreFile, penFile] of scenarios) {
					const { page: p, problems: pp } = await openPage(browser);
					await p.addScriptTag({ url: `/scripts/webkit/out/${variant === "before" ? "engine-before.js" : "engine.js"}` });
					const r = await p.evaluate((cfg) => window.__tests.b06(cfg), { coreFirst, coreFile, penFile, variant, expected });
					r.browser = name;
					r.errors = [...pp, ...(await p.evaluate(() => window.__tests.errors()))];
					result.b06.push(r);
					if (variant === "after") {
						if (r.fontCollisions.length) fail(`b06 after, coreFirst=${coreFirst}: font name collisions ${r.fontCollisions.join(",")}`);
						if (r.duplicateIds.length) fail(`b06 after, coreFirst=${coreFirst}: duplicate ids ${r.duplicateIds.join(",")}`);
						if (coreFirst && r.rootVarAfterPenDF !== r.rootVarAfterCore) fail("b06 after: penDF changed <html> --viewer-container-height");
						for (const g of r.groundTruth) if (Math.abs(g.dxEnd) >= 3) fail(`b06 after, coreFirst=${coreFirst}: dxEnd ${g.dxEnd} on p${g.page}`);
					}
					await p.close();
				}
			}
		}
	} finally {
		await browser.close();
	}
}
server.close();

// Chromium vs WebKit: same selection → same quads?
if (result.browsers.webkit && result.browsers.chromium) {
	let maxDiff = 0;
	const a = result.browsers.webkit.groundTruth;
	const b = result.browsers.chromium.groundTruth;
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		const qa = a[i].quadsRounded.flat();
		const qb = b[i].quadsRounded.flat();
		for (let j = 0; j < Math.min(qa.length, qb.length); j++) maxDiff = Math.max(maxDiff, Math.abs(qa[j] - qb[j]));
	}
	result.webkitVsChromiumMaxQuadDiffPt = +maxDiff.toFixed(2);
}
result.failures = failures;
writeFileSync(outFile, JSON.stringify(result, null, 1) + "\n");

// summary
for (const [n, r] of Object.entries(result.browsers)) {
	const pages = Object.values(r.fixtures).reduce((s, f) => s + f.rendered, 0);
	console.log(`${n} ${r.version}: ${Object.keys(r.fixtures).length} fixtures, ${pages} pages rendered, worker ${r.workerMode}, text spans ${r.viewer.textLayerSpans}, search ${r.viewer.searchMatches}, errors ${r.errors.length}, built-ins +${r.builtins.added.length}/~${r.builtins.replaced.length}/-${r.builtins.removed.length}, ground-truth dxEnd ${r.groundTruth.map((g) => g.dxEnd).join(" ")}`);
}
if (result.webkitVsChromiumMaxQuadDiffPt !== undefined) console.log(`WebKit vs Chromium quads: max difference ${result.webkitVsChromiumMaxQuadDiffPt} pt`);
for (const r of result.b06) console.log(`B-06 ${r.browser} ${r.variant.padEnd(6)} core=${(r.coreFile ?? "-").padEnd(19)} pen=${path.basename(r.penFile).padEnd(20)} page1 ${r.page1?.hash}/${r.page1?.ink} font collisions ${r.fontCollisions.length}, duplicate ids ${r.duplicateIds.length}, <html> var ${JSON.stringify(r.rootVarAfterCore ?? "")}→${JSON.stringify(r.rootVarAfterPenDF)}, dxEnd ${r.groundTruth.map((g) => g.dxEnd).join(" ")}`);
console.log(`result → ${path.relative(root, outFile)}`);
if (failures.length) {
	console.error("FAILED:\n  " + failures.join("\n  "));
	process.exit(1);
}
console.log("smoke: OK");
