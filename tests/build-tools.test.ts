import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import postcss from "postcss";
// @ts-expect-error -- plain .mjs build scripts without type declarations
import { runChecks } from "../scripts/check-standalone.mjs";
// @ts-expect-error -- plain .mjs build scripts without type declarations
import { transform } from "../scripts/pdfjs-transform.mjs";
// @ts-expect-error -- plain .mjs build scripts without type declarations
import { scopeCss, scopeSelector } from "../scripts/scope-css.mjs";

const require = createRequire(import.meta.url);
const pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));

type Violation = { rule: string; file: string };

function project(files: Record<string, string>): string {
	const dir = mkdtempSync(path.join(tmpdir(), "pendf-check-"));
	for (const [rel, content] of Object.entries(files)) {
		const p = path.join(dir, rel);
		mkdirSync(path.dirname(p), { recursive: true });
		writeFileSync(p, content);
	}
	return dir;
}

const GOOD_PKG = JSON.stringify({ dependencies: { "pdfjs-dist": "6.5.438" } });
// incompressible padding so the literal is long enough to look like an embedded asset
const workerLiteral = (src: string) => JSON.stringify(gzipSync(Buffer.from(src + "/*" + randomBytes(300).toString("hex") + "*/")).toString("base64"));
// a representative clean bundle: embedded worker + the namespace transforms applied (B-06)
const NS_MAIN = 'class T{docId=`pendf_d${T.#d++}`;static #d=0;u(h){this.container.style.setProperty("--viewer-container-height",`${h}px`)}}';
const NS_WORKER = 'function f(p){if(p&&!String(p).startsWith("embedded:"))return 1}';
const GOOD_MAIN = `var W=${workerLiteral("class WorkerMessageHandler{}export{WorkerMessageHandler};" + NS_WORKER)};${NS_MAIN}`;

describe("check-standalone", () => {
	it("fails a bundle whose pdf.js document ids lost penDF's prefix (B-06)", () => {
		const stock = GOOD_MAIN.replace("pendf_d", "d").replace("this.container.style.setProperty", "docStyle.setProperty");
		const dir = project({ "src/a.ts": "export const x = 1;\n", "package.json": GOOD_PKG, "main.js": stock });
		const rules = runChecks({ root: dir }).map((v: { rule: string }) => v.rule);
		expect(rules).toContain("namespace-docid");
		expect(rules).toContain("namespace-docid-original");
		expect(rules).toContain("namespace-html-var");
	});
	it("passes a clean project", () => {
		const dir = project({ "src/a.ts": "export const x = 1;\n", "package.json": GOOD_PKG, "main.js": GOOD_MAIN });
		expect(runChecks({ root: dir })).toEqual([]);
	});

	const bad: [string, string][] = [
		["private-app", "const p = this.app.plugins.getPlugin('x');"],
		["private-app", "app.internalPlugins.getPluginById('page-preview');"],
		["as-any", "(this.app as any).viewRegistry;"],
		["monkey-around", "import { around } from 'monkey-around';"],
		["prototype-patch", "WorkspaceLeaf.prototype.openFile = function () {};"],
		["obsidian-pdfjs", "const lib = await loadPdfJs();"],
		["obsidian-pdfjs", "window.pdfjsLib.getDocument(x);"],
		["core-pdf-view", "app.workspace.getLeavesOfType('pdf');"],
		["register-pdf-ext", "this.registerExtensions(['pdf'], 'x');"],
		["pdfjs-import", "import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';"],
		["ts-suppress", "// @ts-ignore\nfoo();"],
	];
	for (const [rule, code] of bad) {
		it(`flags ${rule}: ${code.split("\n").pop()}`, () => {
			const dir = project({ "src/bad.ts": code + "\n", "package.json": GOOD_PKG, "main.js": GOOD_MAIN });
			const v = runChecks({ root: dir }) as Violation[];
			expect(v.map((x) => x.rule)).toContain(rule);
		});
	}

	it("ignores forbidden words inside comments", () => {
		const dir = project({ "src/a.ts": "// never use app.plugins or window.pdfjsLib\n/* loadPdfJs */\nexport {};\n", "package.json": GOOD_PKG, "main.js": GOOD_MAIN });
		expect(runChecks({ root: dir })).toEqual([]);
	});

	it("requires exactly one exact-version runtime dependency", () => {
		const v1 = runChecks({ root: project({ "package.json": JSON.stringify({ dependencies: { "pdfjs-dist": "^6.5.438" } }), "main.js": GOOD_MAIN }) }) as Violation[];
		expect(v1.map((x) => x.rule)).toContain("exact-version");
		const v2 = runChecks({ root: project({ "package.json": JSON.stringify({ dependencies: { "pdfjs-dist": "6.5.438", "monkey-around": "3.0.0" } }), "main.js": GOOD_MAIN }) }) as Violation[];
		expect(v2.map((x) => x.rule)).toContain("runtime-deps");
	});

	it("fails (does not skip) when main.js is missing", () => {
		const v = runChecks({ root: project({ "package.json": GOOD_PKG }) }) as Violation[];
		expect(v.map((x) => x.rule)).toContain("missing-build");
	});

	it("flags pdf.js globals in the bundle and inside the gzipped worker", () => {
		const leakyMain = `globalThis.pdfjsLib={};var W=${workerLiteral("class WorkerMessageHandler{};globalThis.pdfjsWorker={WorkerMessageHandler};")};`;
		const v = runChecks({ root: project({ "package.json": GOOD_PKG, "main.js": leakyMain }) }) as Violation[];
		const files = v.filter((x) => x.rule === "pdfjs-global").map((x) => x.file);
		expect(files.some((f) => f.endsWith("main.js"))).toBe(true);
		expect(files.some((f) => f.includes("[embedded worker]"))).toBe(true);
	});

	it("flags a bundle without an embedded worker", () => {
		const v = runChecks({ root: project({ "package.json": GOOD_PKG, "main.js": "var x=1;" }) }) as Violation[];
		expect(v.map((x) => x.rule)).toContain("worker-not-found");
	});
});

describe("pdfjs-transform on the real pdf.js 6.5.438 sources", () => {
	const files: [string, string][] = [
		["pdf.mjs", "build/pdf.mjs"],
		["pdf_viewer.mjs", "web/pdf_viewer.mjs"],
		["pdf.worker.mjs", "build/pdf.worker.mjs"],
		["pdf.worker.min.mjs", "build/pdf.worker.min.mjs"],
	];
	for (const [key, rel] of files) {
		it(`${key}: no pdfjs global remains`, () => {
			const out = transform(key, readFileSync(path.join(pdfjsRoot, rel), "utf8")) as string;
			expect(out).not.toMatch(/globalThis\.pdfjs(Lib|Viewer|Worker)\b/);
			expect(out).not.toMatch(/_pdfjsTestingUtils/);
		});
	}
	it("fails loudly when the source shape changes", () => {
		expect(() => transform("pdf.mjs", "nothing to see here")).toThrow(/expected 1 match/);
	});
	it("gives pdf.js documents a penDF-unique id prefix (shared font / filter names, B-06)", () => {
		const out = transform("pdf.mjs", readFileSync(path.join(pdfjsRoot, "build/pdf.mjs"), "utf8")) as string;
		expect(out).toContain("docId = `pendf_d${PDFDocumentLoadingTask.#docId++}`;");
		expect(out).not.toMatch(/docId = `d\$\{/);
	});
	it("sets --viewer-container-height on the container, not <html>", () => {
		const out = transform("pdf_viewer.mjs", readFileSync(path.join(pdfjsRoot, "web/pdf_viewer.mjs"), "utf8")) as string;
		expect(out).toContain('this.container.style.setProperty("--viewer-container-height"');
		expect(out).not.toMatch(/docStyle\.setProperty\("--viewer-container-height"/);
	});
	it("worker skips url() font sources for embedded:// standard fonts", () => {
		const out = transform("pdf.worker.mjs", readFileSync(path.join(pdfjsRoot, "build/pdf.worker.mjs"), "utf8")) as string;
		expect(out).toContain('!String(localFontPath).startsWith("embedded:")');
	});
	it("viewer reads the bundled module instead of the global", () => {
		const out = transform("pdf_viewer.mjs", readFileSync(path.join(pdfjsRoot, "web/pdf_viewer.mjs"), "utf8")) as string;
		expect(out.startsWith('import * as __pendfPdfjs from "pdfjs-dist/build/pdf.mjs";')).toBe(true);
		expect(out).toContain("} = __pendfPdfjs;");
	});
});

describe("scope-css", () => {
	it("prefixes selectors and maps :root to the scope", () => {
		expect(scopeSelector(".textLayer span", ".s")).toBe(".s .textLayer span");
		expect(scopeSelector(":root", ".s")).toBe(".s");
		expect(scopeSelector(":root:not(.x)", ".s")).toBe(".s:not(.x)");
	});
	it("scopes the real pdf_viewer.css: no unscoped rule, no image urls", () => {
		const css = scopeCss(readFileSync(path.join(pdfjsRoot, "web/pdf_viewer.css"), "utf8"), ".pendf-root") as string;
		expect(css).not.toMatch(/url\(\s*["']?images\//);
		// every rule outside @keyframes starts with the scope
		const selectors: string[] = [];
		const nested: string[] = [];
		postcss.parse(css).walkRules((rule) => {
			let insideRule = false;
			for (let p = rule.parent as { type: string; name?: string; parent?: unknown } | undefined; p && p.type !== "root"; p = p.parent as typeof p) {
				if (p.type === "rule") insideRule = true;
				if (p.type === "atrule" && /keyframes$/.test(p.name ?? "")) return;
			}
			(insideRule ? nested : selectors).push(...rule.selectors);
		});
		expect(selectors.length).toBeGreaterThan(100);
		expect(selectors.filter((s) => !s.startsWith(".pendf-root"))).toEqual([]);
		// pdf.js 6 uses native CSS nesting: nested rules stay relative to their parent
		expect(nested.length).toBeGreaterThan(10);
		expect(nested.filter((s) => s.includes(".pendf-root"))).toEqual([]);
		expect(css).toMatch(/\.pendf-root \.textLayer\s*\{[\s\S]*?> :not\(\.markedContent\)/);
	});
});
