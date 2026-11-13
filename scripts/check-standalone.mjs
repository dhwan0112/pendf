#!/usr/bin/env node
// Enforce the standalone principle (docs/DECISIONS.md, spec §1):
//   - no other plugin, no Obsidian private API, no prototype patching
//   - never Obsidian's pdf.js (loadPdfJs / window.pdfjsLib) and no pdfjs* globals
//   - no access to the core PDF viewer or its DOM
//   - exactly one runtime dependency: pdfjs-dist at an exact version
// Scans src/**, package.json, the built main.js and — because the worker is
// stored gzip+base64 inside main.js — the decompressed embedded worker source.
// Exits non-zero on any violation. A missing main.js is a failure, not a skip.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {{ id: string, re: RegExp, why: string, raw?: boolean }} Rule */

/** @type {Rule[]} */
export const SOURCE_RULES = [
	{ id: "private-app", re: /\bapp\s*\.\s*(viewRegistry|plugins|internalPlugins|embedRegistry|commands|setting|customCss|hotkeyManager|dragManager|metadataTypeManager|statusBar|foldManager)\b/, why: "Obsidian private API on App" },
	{ id: "private-vault", re: /\bvault\s*\.\s*(getConfig|setConfig|config)\b/, why: "Obsidian private API on Vault" },
	{ id: "private-workspace", re: /\bworkspace\s*\.\s*(floatingSplit|leftSplit\.collapse\b|editorSuggest|getDropLocation|pushUndoHistory)\b/, why: "Obsidian private API on Workspace" },
	{ id: "as-any", re: /\bas\s+any\b|<any>/, why: "`as any` can hide private API access" },
	{ id: "ts-suppress", re: /@ts-(ignore|nocheck|expect-error)/, why: "type checks must not be suppressed", raw: true },
	{ id: "monkey-around", re: /monkey-around|\baround\s*\(/, why: "prototype patching (monkey-around)" },
	{ id: "prototype-patch", re: /\.prototype\s*\.\s*[A-Za-z_$][\w$]*\s*=(?!=)|Object\.defineProperty\s*\(\s*[\w$.]+\.prototype\b|Object\.setPrototypeOf\s*\(/, why: "prototype patching" },
	{ id: "obsidian-pdfjs", re: /\bloadPdfJs\b|\bpdfjsLib\b|\bpdfjsViewer\b|\bpdfjsWorker\b/, why: "Obsidian's pdf.js / pdf.js globals" },
	{ id: "core-pdf-view", re: /getLeavesOfType\s*\(\s*["'`]pdf["'`]|data-type\s*=\s*\\?["']pdf\\?["']|\.pdf-(viewer|container|toolbar|embed|content)\b|["'`]pdf-viewer["'`]/, why: "touching the core PDF viewer or its DOM" },
	{ id: "register-pdf-ext", re: /registerExtensions\s*\(/, why: "taking over file extensions (core PDF)" },
	{ id: "other-plugin", re: /\b(enabledPlugins|getPlugin)\b|["'`](obsidian-pdf-plus|pdf-plus|dataview|excalidraw)["'`]/, why: "detecting or depending on other plugins" },
	{ id: "pdfjs-modern", re: /from\s+["']pdfjs-dist(?!\/legacy\/(build\/pdf\.mjs|web\/pdf_viewer\.mjs)["'])/, why: "only the transformed legacy pdf.js build may be imported" },
	{ id: "electron-remote", re: /@electron\/remote|require\s*\(\s*["']electron["']\s*\)/, why: "Electron internals" },
];

/** Applied to the built main.js and the embedded worker source. */
export const BUILD_RULES = [
	{ id: "pdfjs-global", re: /\bpdfjsLib\b|\bpdfjsViewer\b|\bpdfjsWorker\b|\b_pdfjsTestingUtils\b/, why: "pdf.js global read/write left in bundle" },
	{ id: "obsidian-pdfjs", re: /\bloadPdfJs\b/, why: "Obsidian's pdf.js loader" },
	{ id: "private-app", re: /\b(viewRegistry|internalPlugins|embedRegistry)\b/, why: "Obsidian private API" },
	{ id: "monkey-around", re: /monkey-around/, why: "prototype patching library" },
];

function walk(dir) {
	const out = [];
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		const p = path.join(dir, name);
		if (statSync(p).isDirectory()) out.push(...walk(p));
		else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) out.push(p);
	}
	return out;
}

function stripComments(src) {
	// keep line numbers: replace comment bodies with spaces
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/(^|[^:"'`\\])\/\/.*$/gm, (m, pre) => pre + " ".repeat(m.length - pre.length));
}

function scanText(text, rules, file, out) {
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		for (const r of rules) {
			const m = lines[i].match(r.re);
			if (m) out.push({ file, line: i + 1, rule: r.id, why: r.why, match: m[0].slice(0, 80) });
		}
	}
}

/** Find gzip+base64 string literals in a bundle and return decompressed texts. */
export function embeddedTexts(bundle) {
	const out = [];
	const re = /["'](H4sI[A-Za-z0-9+/=]{200,})["']/g;
	for (let m = re.exec(bundle); m; m = re.exec(bundle)) {
		try {
			const buf = gunzipSync(Buffer.from(m[1], "base64"));
			const text = buf.toString("utf8");
			if (text.includes("WorkerMessageHandler")) out.push({ kind: "worker", text });
		} catch {
			// binary asset or not gzip — ignore
		}
	}
	return out;
}

/**
 * @param {{ root: string, srcDir?: string, mainJs?: string, packageJson?: string, requireBuild?: boolean }} opts
 */
export function runChecks(opts) {
	const root = opts.root;
	const srcDir = opts.srcDir ?? path.join(root, "src");
	const mainJs = opts.mainJs ?? path.join(root, "main.js");
	const pkgPath = opts.packageJson ?? path.join(root, "package.json");
	const violations = [];

	for (const f of walk(srcDir)) {
		const raw = readFileSync(f, "utf8");
		const rel = path.relative(root, f);
		// most rules ignore comments; suppression directives live in comments
		scanText(stripComments(raw), SOURCE_RULES.filter((r) => !r.raw), rel, violations);
		scanText(raw, SOURCE_RULES.filter((r) => r.raw), rel, violations);
	}

	if (existsSync(pkgPath)) {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		const deps = pkg.dependencies ?? {};
		const names = Object.keys(deps);
		if (names.length !== 1 || names[0] !== "pdfjs-dist") violations.push({ file: "package.json", line: 0, rule: "runtime-deps", why: "runtime dependencies must be exactly [pdfjs-dist]", match: names.join(",") });
		for (const [n, v] of Object.entries(deps)) {
			if (!/^\d+\.\d+\.\d+$/.test(v)) violations.push({ file: "package.json", line: 0, rule: "exact-version", why: "runtime dependency versions must be exact (no ^ ~ ranges)", match: `${n}@${v}` });
		}
	} else violations.push({ file: "package.json", line: 0, rule: "missing", why: "package.json not found", match: "" });

	if (opts.requireBuild !== false) {
		if (!existsSync(mainJs)) {
			violations.push({ file: path.relative(root, mainJs), line: 0, rule: "missing-build", why: "main.js not found — run `pnpm build` first", match: "" });
		} else {
			const bundle = readFileSync(mainJs, "utf8");
			scanText(bundle, BUILD_RULES, path.relative(root, mainJs), violations);
			const embedded = embeddedTexts(bundle);
			if (embedded.length !== 1) violations.push({ file: path.relative(root, mainJs), line: 0, rule: "worker-not-found", why: `expected exactly one embedded worker, found ${embedded.length}`, match: "" });
			for (const e of embedded) scanText(e.text, BUILD_RULES, path.relative(root, mainJs) + " [embedded worker]", violations);
		}
	}
	return violations;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const v = runChecks({ root });
	if (v.length) {
		console.error(`check-standalone: ${v.length} violation(s)`);
		for (const x of v) console.error(`  ${x.file}:${x.line}  [${x.rule}] ${x.why}  → ${x.match}`);
		process.exit(1);
	}
	console.log("check-standalone: OK (source, package.json, main.js, embedded worker)");
}
