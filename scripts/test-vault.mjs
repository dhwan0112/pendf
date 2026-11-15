// The dedicated test vault and the guard that keeps dev tools out of real vaults.
//
// Every tool that writes into a vault (install-dev, the Obsidian harness)
// refuses to run unless the vault root contains the marker file below. Create
// a test vault with:  node scripts/make-test-vault.mjs [<path>]
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER = ".pendf-test-vault";
export const DEFAULT_VAULT_NAME = "pendf-testvault";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Default location: next to the repository, never inside it. */
export const DEFAULT_VAULT_PATH = path.resolve(root, "..", DEFAULT_VAULT_NAME);

/** Exit with an explanation unless `vaultPath` is a marked penDF test vault. */
export function assertTestVault(vaultPath, tool) {
	const p = vaultPath ? path.resolve(vaultPath) : "";
	if (!p || !existsSync(path.join(p, MARKER))) {
		console.error(
			`${tool}: refusing to touch ${p || "(no path given)"} — it is not a penDF test vault (no ${MARKER} file at its root).\n` +
				`Create one with:  node scripts/make-test-vault.mjs "${DEFAULT_VAULT_PATH}"\n` +
				`then open that folder in Obsidian once ("Open folder as vault").`,
		);
		process.exit(2);
	}
	return p;
}
