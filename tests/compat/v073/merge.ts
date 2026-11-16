// Merging two copies of a sidecar (e.g. this device's in-memory state and a
// version that arrived through sync). Rules, per annotation id:
//   1. union of ids
//   2. a deleted copy wins over a live one (deletions are never resurrected)
//   3. otherwise the newer updatedAt wins
//   4. exact ties are broken deterministically so every device converges
// The same rules dedupe repeated ids inside a single file.

import type { Annotation, Sidecar } from "./schema";

export function pickWinner(a: Annotation, b: Annotation): Annotation {
	if (a.deleted !== b.deleted) return a.deleted ? a : b;
	if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
	// deterministic tie-break
	const sa = stableStringify(a);
	const sb = stableStringify(b);
	return sa >= sb ? a : b;
}

export function mergeAnnotations(...lists: Annotation[][]): Annotation[] {
	const byId = new Map<string, Annotation>();
	const order: string[] = [];
	for (const list of lists) {
		for (const a of list) {
			const prev = byId.get(a.id);
			if (!prev) {
				byId.set(a.id, a);
				order.push(a.id);
			} else byId.set(a.id, pickWinner(prev, a));
		}
	}
	return order.map((id) => byId.get(id)!);
}

export function dedupe(list: Annotation[]): Annotation[] {
	return mergeAnnotations(list);
}

/** Merge `remote` into `local`. Fingerprints must already match. */
export function mergeSidecars(local: Sidecar, remote: Sidecar): Sidecar {
	const out: Sidecar = {
		schemaVersion: local.schemaVersion,
		pdfFingerprint: local.pdfFingerprint,
		annotations: mergeAnnotations(local.annotations, remote.annotations),
	};
	const unknown = mergeUnknown(local.unknown, remote.unknown);
	if (unknown.length) out.unknown = unknown;
	return out;
}

function mergeUnknown(a: unknown[] = [], b: unknown[] = []): unknown[] {
	const seen = new Set<string>();
	const out: unknown[] = [];
	for (const x of [...a, ...b]) {
		const k = stableStringify(x);
		if (!seen.has(k)) {
			seen.add(k);
			out.push(x);
		}
	}
	return out;
}

export function sameAnnotations(a: Annotation[], b: Annotation[]): boolean {
	if (a.length !== b.length) return false;
	const m = new Map(a.map((x) => [x.id, stableStringify(x)]));
	return b.every((x) => m.get(x.id) === stableStringify(x));
}

export function stableStringify(v: unknown): string {
	if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
	if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
	const o = v as Record<string, unknown>;
	return (
		"{" +
		Object.keys(o)
			.filter((k) => o[k] !== undefined)
			.sort()
			.map((k) => JSON.stringify(k) + ":" + stableStringify(o[k]))
			.join(",") +
		"}"
	);
}
