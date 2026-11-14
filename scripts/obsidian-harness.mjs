#!/usr/bin/env node
// Desktop verification in a real Obsidian instance via the Obsidian CLI
// (`obsidian vault=<name> eval code=…`). Dev tool only — this file and
// scripts/harness/ are NOT part of the plugin and are not scanned by
// check-standalone (they deliberately use app.plugins etc. to load/unload it).
//
//   node scripts/obsidian-harness.mjs --vault SciWiki --path "<vault dir>" [--only a,b]
//
// What it does:
//   1. copies main.js/manifest.json/styles.css + fixtures into the vault
//   2. in the page: installs test shims (rAF→setTimeout because a background
//      Obsidian window pauses rAF; a Worker wrapper to observe termination;
//      window.open capture), reloads the plugin, runs scripts/harness/checks.js
//   3. ALWAYS restores: closes every leaf it opened, removes shims, disables
//      the plugin again, deletes the test sidecars/renamed copies
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { transform } from "./pdfjs-transform.mjs";
import { ponyfill } from "./pdfjs-ponyfill.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => {
	const i = process.argv.indexOf(k);
	return i >= 0 ? process.argv[i + 1] : d;
};
const vaultName = arg("--vault", "SciWiki");
const vaultPath = arg("--path");
const only = arg("--only", "");
const outFile = arg("--out", path.join(root, "harness-result.json"));
const OBSIDIAN = process.platform === "win32" ? "C:/Program Files/Obsidian/obsidian" : "obsidian";
if (!vaultPath || !existsSync(path.join(vaultPath, ".obsidian"))) {
	console.error("usage: node scripts/obsidian-harness.mjs --vault <name> --path <vault dir> [--only check1,check2]");
	process.exit(2);
}

function evalInObsidian(code) {
	const out = execFileSync(OBSIDIAN, [`vault=${vaultName}`, "eval", `code=${code}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	const line = out.split(/\r?\n/).find((l) => l.startsWith("=> "));
	return line ? line.slice(3) : "";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- pdf.js-only probe bundle + worker for the clean-realm footprint check.
// Same transforms as main.js (global stripping + ponyfills, modern build).
async function buildPdfjsProbe() {
	const dir = path.join(root, "node_modules", ".cache", "pendf");
	mkdirSync(dir, { recursive: true });
	const bundle = path.join(dir, "pdfjs-probe.js");
	const worker = path.join(dir, "pdfjs-probe-worker.js");
	const pdfjsRoot = path.dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
	const src = (key, file) => ponyfill(transform(key, readFileSync(file, "utf8")), key).code;
	await esbuild.build({
		entryPoints: [path.join(root, "scripts", "harness", "probe-entry.js")],
		bundle: true,
		format: "iife",
		platform: "browser",
		target: "es2022",
		outfile: bundle,
		logLevel: "silent",
		logOverride: { "empty-import-meta": "silent" },
		plugins: [
			{
				name: "pdfjs",
				setup(b) {
					b.onResolve({ filter: /^pdfjs-dist(\/build\/pdf\.mjs)?$/ }, () => ({ path: path.join(pdfjsRoot, "build", "pdf.mjs") }));
					b.onLoad({ filter: /[\\/]pdfjs-dist[\\/]build[\\/]pdf\.mjs$/ }, (a) => ({ contents: src("pdf.mjs", a.path), loader: "js", resolveDir: path.dirname(a.path) }));
				},
			},
		],
	});
	const w = esbuild.transformSync(src("pdf.worker.mjs", path.join(pdfjsRoot, "build", "pdf.worker.mjs")), { loader: "js", format: "esm", target: "es2022", minify: true, logLevel: "silent" });
	writeFileSync(worker, w.code);
	return { bundle, worker };
}

const checksPath = path.join(root, "scripts", "harness", "checks.js");
const fwd = (p) => p.replace(/\\/g, "/");

async function main() {
	execFileSync(process.execPath, [path.join(root, "scripts", "install-dev.mjs"), vaultPath, "--fixtures"], { stdio: "inherit" });
	const probe = await buildPdfjsProbe();
	const cfg = {
		only: only ? only.split(",") : null,
		expected: JSON.parse(readFileSync(path.join(root, "fixtures", "out", "expected.json"), "utf8")),
		probeBundle: fwd(probe.bundle),
		probeWorker: fwd(probe.worker),
		fixturesDir: fwd(path.join(root, "fixtures", "out")),
		ourVersion: JSON.parse(readFileSync(path.join(root, "node_modules", "pdfjs-dist", "package.json"), "utf8")).version,
	};
	writeFileSync(path.join(root, "node_modules", ".cache", "pendf", "cfg.json"), JSON.stringify(cfg));
	const cfgPath = fwd(path.join(root, "node_modules", ".cache", "pendf", "cfg.json"));
	const start = `(()=>{ const fs = require("fs"); const src = fs.readFileSync(${JSON.stringify(fwd(checksPath))}, "utf8"); const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(cfgPath)}, "utf8")); const harness = (0, eval)(src); harness.start(cfg); return "started"; })()`;
	console.log("harness:", evalInObsidian(start));
	const t0 = Date.now();
	let state = "";
	try {
		for (;;) {
			await sleep(1500);
			state = evalInObsidian(`JSON.stringify({done: !!window.__pendfH?.done, step: window.__pendfH?.step})`);
			const s = JSON.parse(state || "{}");
			process.stdout.write(`\r  … ${s.step ?? ""}`.padEnd(70));
			if (s.done) break;
			if (Date.now() - t0 > 15 * 60_000) throw new Error("harness timed out");
		}
		process.stdout.write("\n");
		const result = evalInObsidian(`JSON.stringify(window.__pendfH.result ?? {error: window.__pendfH.error})`);
		writeFileSync(outFile, JSON.stringify(JSON.parse(result), null, 2) + "\n");
		const r = JSON.parse(result);
		let fails = 0;
		for (const [name, v] of Object.entries(r.checks ?? {})) {
			const ok = v && v.ok;
			if (!ok) fails++;
			console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && v?.error ? "  — " + v.error.split("\n")[0] : ""}`);
		}
		if (r.error) console.log("ERROR", r.error);
		console.log(`result → ${outFile}`);
		process.exitCode = fails || r.error ? 1 : 0;
	} finally {
		// the page restores itself when the run ends; this is the safety net
		try {
			console.log("teardown:", evalInObsidian(`(()=>{ try { window.__pendfH?.teardown?.(); return "ok"; } catch (e) { return String(e); } })()`));
		} catch (e) {
			console.error("teardown eval failed", e);
		}
	}
}

for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		try {
			evalInObsidian(`(()=>{ window.__pendfH?.teardown?.(); return "ok"; })()`);
		} finally {
			process.exit(130);
		}
	});
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
