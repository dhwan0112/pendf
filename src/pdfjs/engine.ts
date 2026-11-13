// Load-time engine check. The bundled pdf.js is the *modern* build: a few
// very new built-ins are routed through module-local ponyfills at build time
// (scripts/pdfjs-ponyfill.mjs), everything else must exist natively. Nothing
// is polyfilled globally, so on an engine that lacks one of these we report
// it (log + banner) instead of failing somewhere inside a render.

export interface EngineReport {
	ok: boolean;
	missing: string[];
	/** informational: new built-ins we ponyfill, present natively or not */
	ponyfilled: Record<string, boolean>;
}

type Probe = [name: string, test: () => boolean];

const has = (o: unknown, k: string): boolean => {
	try {
		return typeof (o as Record<string, unknown>)?.[k] === "function";
	} catch {
		return false;
	}
};
const g = globalThis as unknown as Record<string, unknown>;
const proto = (name: string): unknown => (g[name] as { prototype?: unknown } | undefined)?.prototype;
const iterProto = (): unknown => {
	const it = g.Iterator as { prototype?: unknown } | undefined;
	return it?.prototype ?? Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
};

/** Required natively by pdf.js 6.5 (modern) or by PDF+++ itself. */
const REQUIRED: Probe[] = [
	["Promise.withResolvers", () => has(Promise, "withResolvers")],
	["Iterator helpers (filter/map/toArray…)", () => ["map", "filter", "toArray", "flatMap", "some", "every", "find", "forEach"].every((k) => has(iterProto(), k))],
	["Set#intersection", () => has(proto("Set"), "intersection")],
	["Array#findLast / #at", () => has(Array.prototype, "findLast") && has(Array.prototype, "at")],
	["Object.hasOwn / structuredClone", () => has(Object, "hasOwn") && typeof structuredClone === "function"],
	["AbortSignal.any", () => has(AbortSignal, "any")],
	["DecompressionStream (gzip)", () => typeof g.DecompressionStream === "function"],
	["Worker", () => typeof g.Worker === "function"],
	["Path2D / DOMMatrix", () => typeof g.Path2D === "function" && typeof g.DOMMatrix === "function"],
];

const PONYFILLED: Probe[] = [
	["Map#getOrInsertComputed", () => has(proto("Map"), "getOrInsertComputed")],
	["Math.sumPrecise", () => has(Math, "sumPrecise")],
	["Uint8Array#toBase64 / fromBase64 / toHex", () => has(proto("Uint8Array"), "toBase64") && has(g.Uint8Array, "fromBase64") && has(proto("Uint8Array"), "toHex")],
	["Promise.try", () => has(Promise, "try")],
	["RegExp.escape", () => has(RegExp, "escape")],
	["URL.parse", () => has(URL, "parse")],
];

export function checkEngine(): EngineReport {
	const missing = REQUIRED.filter(([, t]) => {
		try {
			return !t();
		} catch {
			return true;
		}
	}).map(([n]) => n);
	const ponyfilled: Record<string, boolean> = {};
	for (const [n, t] of PONYFILLED) {
		try {
			ponyfilled[n] = t();
		} catch {
			ponyfilled[n] = false;
		}
	}
	return { ok: missing.length === 0, missing, ponyfilled };
}
