#!/usr/bin/env node
// Copy the built plugin (and optionally the fixtures) into a test vault.
//   node scripts/install-dev.mjs <vault path> [--fixtures]
import { cpSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vault = process.argv[2];
if (!vault || !existsSync(path.join(vault, ".obsidian"))) {
	console.error("usage: node scripts/install-dev.mjs <vault path> [--fixtures]");
	process.exit(2);
}
const dest = path.join(vault, ".obsidian", "plugins", "pendf");
mkdirSync(dest, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) cpSync(path.join(root, f), path.join(dest, f));
console.log(`plugin → ${dest}`);
if (process.argv.includes("--fixtures")) {
	const src = path.join(root, "fixtures", "out");
	const out = path.join(vault, "pendf-fixtures");
	mkdirSync(out, { recursive: true });
	for (const f of readdirSync(src).filter((f) => f.endsWith(".pdf"))) cpSync(path.join(src, f), path.join(out, f));
	console.log(`fixtures → ${out}`);
}
