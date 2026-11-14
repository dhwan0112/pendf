// Schema migrations. Each step takes the raw JSON of version N and returns
// version N+1. v1 is the first published version, so the table is empty; the
// skeleton exists so the first real migration is a one-line addition.

import { SCHEMA_VERSION } from "./schema";

type Raw = Record<string, unknown>;
type Step = (raw: Raw) => Raw;

/** MIGRATIONS[n] upgrades version n → n+1. */
export const MIGRATIONS: Record<number, Step> = {
	// 1: (raw) => ({ ...raw, schemaVersion: 2, ... }),
};

export class NewerSchemaError extends Error {
	constructor(readonly found: number) {
		super(`sidecar schemaVersion ${found} is newer than this plugin supports (${SCHEMA_VERSION}); update penDF`);
		this.name = "NewerSchemaError";
	}
}

/**
 * Bring a parsed sidecar JSON up to SCHEMA_VERSION. Throws NewerSchemaError
 * when the file was written by a newer plugin — callers must then refuse to
 * write so they don't clobber data they can't represent.
 */
export function migrate(input: unknown, migrations: Record<number, Step> = MIGRATIONS, target = SCHEMA_VERSION): Raw {
	if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("sidecar is not a JSON object");
	let raw = input as Raw;
	let v = typeof raw.schemaVersion === "number" ? raw.schemaVersion : 0;
	if (!Number.isInteger(v) || v < 0) throw new Error(`invalid schemaVersion ${String(raw.schemaVersion)}`);
	if (v > target) throw new NewerSchemaError(v);
	if (v === 0) {
		// Pre-release files had no version field; their shape equals v1.
		raw = { ...raw, schemaVersion: 1 };
		v = 1;
	}
	while (v < target) {
		const step = migrations[v];
		if (!step) throw new Error(`no migration from schemaVersion ${v}`);
		raw = step(raw);
		const next = raw.schemaVersion;
		if (next !== v + 1) throw new Error(`migration ${v} produced schemaVersion ${String(next)}`);
		v = next as number;
	}
	return raw;
}
