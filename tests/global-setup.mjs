// Make sure fixtures exist (they are generated, not committed).
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default function setup() {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	if (!existsSync(path.join(root, "fixtures", "out", "rotations.pdf"))) {
		execFileSync(process.execPath, [path.join(root, "scripts", "make-fixtures.mjs")], { stdio: "inherit" });
	}
}
