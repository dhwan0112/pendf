#!/usr/bin/env node
// Full Obsidian harness in small, resumable batches (dev tool, 0.7.3).
//
//   node scripts/harness-batches.mjs [--max-batches N] [--fresh] [--evidence docs/evidence/x.json]
//
// - Runs scripts/obsidian-harness.mjs once per batch (2–3 checks each).
// - Before each batch, closes and reopens ONLY the test vault's Obsidian window
//   (other vault windows are left alone) so its renderer starts with fresh memory.
// - Records Obsidian's process memory (all Obsidian.exe processes: working set,
//   private bytes) and the system's free memory before and after each batch.
// - Saves the state after every batch (node_modules/.cache/pendf/harness-batches.json):
//   if the run is stopped (low memory, timeout), the next invocation skips the
//   batches that already passed and runs only the rest. --fresh starts over.
// - When every batch has passed, writes the merged result (+ memory log) to --evidence.
//
// Windows only for the window/memory handling (PowerShell); the harness itself
// needs the test vault (scripts/test-vault.mjs guard).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_VAULT_NAME, DEFAULT_VAULT_PATH, assertTestVault } from "./test-vault.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (k, d) => {
	const i = args.indexOf(k);
	return i >= 0 ? args[i + 1] : d;
};
const vaultName = arg("--vault", DEFAULT_VAULT_NAME);
const vaultPath = assertTestVault(arg("--path", DEFAULT_VAULT_PATH), "harness-batches");
const maxBatches = Number(arg("--max-batches", "999"));
const evidence = arg("--evidence", "");
const cacheDir = path.join(root, "node_modules", ".cache", "pendf");
const stateFile = path.join(cacheDir, "harness-batches.json");
const OBSIDIAN = "C:/Program Files/Obsidian/obsidian";

// fallback-main-thread is not first in its batch, and pdfjs-footprint does not run before it in the same
// batch (D-37); every check appears exactly once
const BATCHES = [
	["fixtures-render", "search", "links"],
	["open-by-default", "state-restore", "coexistence-core-first"],
	["coexistence-pendf-first", "css-inward", "highlight-ground-truth"],
	["shared-namespace", "ground-truth-after-core", "ground-truth-after-embed"],
	["ground-truth-same-pdf-embed", "highlight-multiline-columns", "highlight-korean"],
	["highlight-cross-page", "smoke-ui", "rename-while-open"],
	["highlight-palette", "highlight-menu-undo", "notes"],
	["pdf-links", "bookmarks", "ink"],
	["pages-search", "zoom-gesture"],
	["zoom-extras", "persist-restart-rename"],
	["in-view-panel", "toolbar-labels"],
	["margin-ink", "margin-ground-truth"],
	["margin-note", "margin-with-panel"],
	["area-ground-truth", "area-image", "area-link"],
	["index-rename", "index-perf"],
	["long-300-memory", "pdfjs-footprint"],
	["fingerprint-mismatch", "fallback-main-thread", "unload-cleanup"],
];

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ps = (cmd) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8" }).trim();

function memory() {
	let procs = [];
	try {
		const out = ps("Get-Process Obsidian -ErrorAction SilentlyContinue | Select-Object Id, MainWindowTitle, WorkingSet64, PrivateMemorySize64 | ConvertTo-Json -Compress");
		procs = out ? [].concat(JSON.parse(out)) : [];
	} catch {
		procs = [];
	}
	const mb = (b) => Math.round(b / 1048576);
	return {
		at: new Date().toISOString(),
		systemFreeMB: mb(os.freemem()),
		systemTotalMB: mb(os.totalmem()),
		obsidianWorkingSetMB: mb(procs.reduce((a, p) => a + (p.WorkingSet64 ?? 0), 0)),
		obsidianPrivateMB: mb(procs.reduce((a, p) => a + (p.PrivateMemorySize64 ?? 0), 0)),
		processes: procs.map((p) => ({ id: p.Id, title: p.MainWindowTitle || "", workingSetMB: mb(p.WorkingSet64 ?? 0), privateMB: mb(p.PrivateMemorySize64 ?? 0) })),
	};
}

function cliBasePath() {
	try {
		const out = execFileSync(OBSIDIAN, [`vault=${vaultName}`, "eval", "code=String(app.vault.adapter.basePath)"], { encoding: "utf8", timeout: 30_000 });
		return out.split(/\r?\n/).find((l) => l.startsWith("=> "))?.slice(3) ?? "";
	} catch {
		return "";
	}
}

/** Close only the test vault's window, reopen it, wait until the CLI answers from it. */
function reopenTestVaultWindow() {
	const title = `- ${vaultName} - Obsidian`;
	try {
		ps(`Get-Process Obsidian -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${title}*' } | ForEach-Object { $_.CloseMainWindow() | Out-Null }`);
	} catch {}
	for (let i = 0; i < 30; i++) {
		sleepSync(500);
		let open = "";
		try {
			open = ps(`(Get-Process Obsidian -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*${title}*' } | Measure-Object).Count`);
		} catch {}
		if (open === "0" || open === "") break;
	}
	sleepSync(1500);
	spawnSync("cmd.exe", ["/c", "start", "", `obsidian://open?vault=${encodeURIComponent(vaultName)}`], { stdio: "ignore" });
	const want = path.resolve(vaultPath).toLowerCase();
	for (let i = 0; i < 40; i++) {
		sleepSync(1500);
		const got = cliBasePath();
		if (got && path.resolve(got).toLowerCase() === want) {
			sleepSync(3000); // let the workspace settle
			return true;
		}
	}
	return false;
}

function loadState() {
	if (args.includes("--fresh") || !existsSync(stateFile)) return { startedAt: new Date().toISOString(), batches: {} };
	return JSON.parse(readFileSync(stateFile, "utf8"));
}

function saveState(st) {
	mkdirSync(cacheDir, { recursive: true });
	writeFileSync(stateFile, JSON.stringify(st, null, 1) + "\n");
}

const st = loadState();
let ran = 0;
for (const [i, checks] of BATCHES.entries()) {
	const key = String(i + 1);
	const prev = st.batches[key];
	if (prev?.passed && prev.checks.join(",") === checks.join(",")) {
		console.log(`batch ${key}: already passed (${checks.join(", ")})`);
		continue;
	}
	if (ran >= maxBatches) break;
	ran++;
	const entry = { checks, attempts: (prev?.attempts ?? 0) + 1 };
	console.log(`batch ${key}: reopening the test vault window…`);
	entry.windowReopened = reopenTestVaultWindow();
	entry.memBefore = memory();
	console.log(`batch ${key}: ${checks.join(", ")}  (Obsidian ${entry.memBefore.obsidianWorkingSetMB} MB working set, system free ${entry.memBefore.systemFreeMB} MB)`);
	const out = path.join(cacheDir, `harness-batch-${key}.json`);
	const r = spawnSync(process.execPath, [path.join(root, "scripts", "obsidian-harness.mjs"), "--vault", vaultName, "--path", vaultPath, "--only", checks.join(","), "--out", out], { encoding: "utf8", timeout: 15 * 60_000 });
	process.stdout.write((r.stdout ?? "").split(/\r?\n/).filter((l) => /^(PASS|FAIL)|ERROR|Refusing/.test(l)).map((l) => `  ${l}\n`).join(""));
	entry.memAfter = memory();
	let result = null;
	try {
		result = JSON.parse(readFileSync(out, "utf8"));
	} catch {}
	entry.result = result;
	entry.passed = !!result && !result.error && checks.every((c) => result.checks?.[c]?.ok === true);
	entry.finishedAt = new Date().toISOString();
	st.batches[key] = entry;
	saveState(st);
	console.log(`batch ${key}: ${entry.passed ? "passed" : "FAILED"}  (after: Obsidian ${entry.memAfter.obsidianWorkingSetMB} MB, system free ${entry.memAfter.systemFreeMB} MB)`);
}

const done = BATCHES.map((c, i) => st.batches[String(i + 1)]);
const passed = done.filter((b) => b?.passed).length;
console.log(`\n${passed}/${BATCHES.length} batches passed; state → ${path.relative(root, stateFile)}`);
if (passed === BATCHES.length && evidence) {
	const checks = {};
	for (const b of done) Object.assign(checks, b.result.checks);
	const n = Object.keys(checks).length;
	const merged = {
		at: new Date().toISOString(),
		vault: vaultName,
		summary: `${Object.values(checks).filter((c) => c.ok).length}/${n}`,
		batches: done.map((b, i) => ({ batch: i + 1, checks: b.checks, attempts: b.attempts, windowReopened: b.windowReopened, memBefore: { ...b.memBefore, processes: undefined }, memAfter: { ...b.memAfter, processes: undefined }, processesBefore: b.memBefore.processes, processesAfter: b.memAfter.processes })),
		checks,
	};
	writeFileSync(path.resolve(root, evidence), JSON.stringify(merged, null, 1) + "\n");
	console.log(`evidence → ${evidence} (${merged.summary})`);
}
process.exitCode = passed === BATCHES.length ? 0 : 1;
