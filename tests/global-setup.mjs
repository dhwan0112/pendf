// Make sure the fixtures every test and the harness use exist (they are
// generated, not committed), and fail with the cause when generation fails.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Used by tests, the WebKit smoke and the desktop harness. */
export const REQUIRED = ["a4.pdf", "letter.pdf", "rotations.pdf", "cropbox.pdf", "areas.pdf", "two-column.pdf", "korean-cmap.pdf", "links.pdf", "long-300.pdf"];
/** Needs a Hangul font on the machine; may be skipped (not failed) without one. */
export const NEEDS_HANGUL_FONT = ["korean-embedded.pdf"];

export default function setup() {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const out = path.join(root, "fixtures", "out");
	const readManifest = () => {
		try {
			return JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
		} catch {
			return null;
		}
	};
	const before = readManifest();
	// a fixture the last run skipped on purpose (no Hangul font) does not trigger regeneration
	const missing = [...REQUIRED, ...NEEDS_HANGUL_FONT, "expected.json"].filter((f) => !existsSync(path.join(out, f)) && !before?.skipped?.[f]);
	if (missing.length || !before) {
		const r = spawnSync(process.execPath, [path.join(root, "scripts", "make-fixtures.mjs")], { encoding: "utf8" });
		process.stdout.write(r.stdout ?? "");
		process.stderr.write(r.stderr ?? "");
	}
	const manifest = readManifest() ?? { skipped: {}, failed: {} };
	const problems = [];
	for (const f of [...REQUIRED, "expected.json"]) {
		if (!existsSync(path.join(out, f))) problems.push(`${f}: ${manifest.failed?.[f] ?? "not generated"}`);
	}
	for (const f of NEEDS_HANGUL_FONT) {
		if (existsSync(path.join(out, f))) continue;
		if (manifest.skipped?.[f]) console.warn(`[fixtures] ${f} skipped — ${manifest.skipped[f]}`);
		else problems.push(`${f}: ${manifest.failed?.[f] ?? "not generated"}`);
	}
	if (problems.length) throw new Error("fixture generation failed (scripts/make-fixtures.mjs):\n  " + problems.join("\n  "));
}
