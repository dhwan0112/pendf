#!/usr/bin/env node
// Create (or refresh) the dedicated penDF test vault.
//
//   node scripts/make-test-vault.mjs [<path>]      default: ../pendf-testvault
//
// Makes the folder, the marker file (.pendf-test-vault) that the harness and
// install-dev require, a minimal .obsidian/ folder, the fixtures
// (pendf-fixtures/) and the current build (.obsidian/plugins/pendf/).
// It does NOT register the vault with Obsidian (that would mean editing
// Obsidian's own settings): open the folder once in Obsidian with
// "Open folder as vault", trust it, and the harness can drive it.
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_VAULT_NAME, DEFAULT_VAULT_PATH, MARKER } from "./test-vault.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vault = path.resolve(process.argv[2] ?? DEFAULT_VAULT_PATH);
if (vault === root || vault.startsWith(root + path.sep)) {
	console.error(`make-test-vault: the test vault must live outside the repository (${root})`);
	process.exit(2);
}
if (existsSync(vault) && !existsSync(path.join(vault, MARKER)) && readdirSync(vault).length > 0) {
	console.error(`make-test-vault: ${vault} exists, is not empty and has no ${MARKER}; refusing to turn an existing folder into a test vault`);
	process.exit(2);
}
for (const f of ["main.js", "manifest.json", "styles.css"]) {
	if (!existsSync(path.join(root, f))) {
		console.error(`make-test-vault: ${f} missing — run pnpm build first`);
		process.exit(2);
	}
}
const fixtures = path.join(root, "fixtures", "out");
if (!existsSync(path.join(fixtures, "rotations.pdf"))) {
	console.error("make-test-vault: fixtures missing — run pnpm fixtures first");
	process.exit(2);
}

mkdirSync(path.join(vault, ".obsidian", "plugins", "pendf"), { recursive: true });
writeFileSync(
	path.join(vault, MARKER),
	`This folder is the penDF test vault (${DEFAULT_VAULT_NAME}).\n` +
		"The penDF dev tools (scripts/obsidian-harness.mjs, scripts/install-dev.mjs) only run in a vault\n" +
		"that has this file at its root. They create and delete files here freely.\n",
);
writeFileSync(path.join(vault, "README.md"), "# penDF test vault\n\nUsed by penDF's automated desktop checks. Anything here may be overwritten or deleted.\n");
for (const f of ["main.js", "manifest.json", "styles.css"]) cpSync(path.join(root, f), path.join(vault, ".obsidian", "plugins", "pendf", f));
const out = path.join(vault, "pendf-fixtures");
mkdirSync(out, { recursive: true });
let n = 0;
for (const f of readdirSync(fixtures).filter((x) => x.endsWith(".pdf"))) {
	cpSync(path.join(fixtures, f), path.join(out, f));
	n++;
}
console.log(`test vault ready: ${vault}`);
console.log(`  ${MARKER}, plugin build, ${n} fixtures`);
console.log(`next: in Obsidian, "Open folder as vault" → ${vault} (once), trust the author / turn on community plugins.`);
console.log(`then: node scripts/obsidian-harness.mjs --vault ${path.basename(vault)} --path "${vault}"`);
