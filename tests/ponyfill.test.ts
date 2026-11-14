import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
// @ts-expect-error -- plain .mjs build script
import { HELPERS, ponyfill, assertNoTargets } from "../scripts/pdfjs-ponyfill.mjs";
// @ts-expect-error -- plain .mjs build script
import { transform } from "../scripts/pdfjs-transform.mjs";

const require = createRequire(import.meta.url);
const pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));

/** Run code in a fresh realm whose built-ins lack the new methods (forced). */
function runFresh(code: string, strip = true): Record<string, unknown> {
	const ctx = vm.createContext({ atob, btoa, URL });
	if (strip) {
		vm.runInContext(
			`delete Map.prototype.getOrInsertComputed; delete Map.prototype.getOrInsert;
			 delete WeakMap.prototype.getOrInsertComputed; delete WeakMap.prototype.getOrInsert;
			 delete Math.sumPrecise; delete Promise.try; delete RegExp.escape;
			 delete Uint8Array.fromBase64; delete Uint8Array.prototype.toBase64; delete Uint8Array.prototype.toHex;
			 delete Uint8Array.prototype.setFromBase64; delete Uint8Array.prototype.setFromHex;`,
			ctx,
		);
	}
	vm.runInContext(code + "\n;globalThis.__out = out;", ctx);
	return ctx.__out as Record<string, unknown>;
}

const transformed = (src: string) => ponyfill(src, "test").code as string;

describe("ponyfill helpers (fallback paths, no native support)", () => {
	it("getOrInsert / getOrInsertComputed", () => {
		const out = runFresh(
			HELPERS +
				`const m = new Map(); let calls = 0;
				 const a = __pendf_getOrInsertComputed(m, "k", (k) => (calls++, k + "!"));
				 const b = __pendf_getOrInsertComputed(m, "k", () => (calls++, "x"));
				 const c = __pendf_getOrInsert(m, "z", 5); const d = __pendf_getOrInsert(m, "z", 6);
				 const w = new WeakMap(); const key = {}; const e = __pendf_getOrInsertComputed(w, key, () => 7);
				 const out = { a, b, c, d, e, calls, size: m.size };`,
		);
		expect(out).toEqual({ a: "k!", b: "k!", c: 5, d: 5, e: 7, calls: 1, size: 2 });
	});

	it("sumPrecise beats naive summation", () => {
		const out = runFresh(HELPERS + `const out = { s: __pendf_sumPrecise([1e20, 0.1, -1e20]), e: __pendf_sumPrecise([]), n: __pendf_sumPrecise([1, 2, 3.5]) };`);
		expect(out.s).toBeCloseTo(0.1, 12);
		expect(Object.is(out.e, -0)).toBe(true);
		expect(out.n).toBe(6.5);
	});

	it("base64 / hex round trips", () => {
		const out = runFresh(
			HELPERS +
				`const u = new Uint8Array([0, 1, 2, 250, 251, 255, 62, 63]);
				 const b64 = __pendf_toBase64(u);
				 const url = __pendf_toBase64(u, { alphabet: "base64url", omitPadding: true });
				 const back = Array.from(__pendf_fromBase64(b64));
				 const backUrl = Array.from(__pendf_fromBase64(url, { alphabet: "base64url" }));
				 const hex = __pendf_toHex(u);
				 const t = new Uint8Array(3); const r = __pendf_setFromHex(t, "0aff10");
				 const t2 = new Uint8Array(8); const r2 = __pendf_setFromBase64(t2, b64);
				 const out = { b64, url, back, backUrl, hex, t: Array.from(t), r, t2: Array.from(t2), r2w: r2.written };`,
		);
		expect(out.b64).toBe(Buffer.from([0, 1, 2, 250, 251, 255, 62, 63]).toString("base64"));
		expect(out.url).toBe(Buffer.from([0, 1, 2, 250, 251, 255, 62, 63]).toString("base64url"));
		expect(out.back).toEqual([0, 1, 2, 250, 251, 255, 62, 63]);
		expect(out.backUrl).toEqual([0, 1, 2, 250, 251, 255, 62, 63]);
		expect(out.hex).toBe("000102fafbff3e3f");
		expect(out.t).toEqual([10, 255, 16]);
		expect(out.r).toEqual({ read: 6, written: 3 });
		expect(out.t2).toEqual([0, 1, 2, 250, 251, 255, 62, 63]);
		expect(out.r2w).toBe(8);
	});

	it("Promise.try, RegExp.escape, URL.parse, join on iterators", async () => {
		const out = runFresh(
			HELPERS +
				`const p = __pendf_promiseTry((a, b) => a + b, 2, 3);
				 const q = __pendf_promiseTry(() => { throw new Error("boom"); });
				 q.catch(() => {});
				 const re = new RegExp(__pendf_regExpEscape("a.b*c(1)"));
				 const out = { p, q, ok: re.test("xa.b*c(1)y"), no: re.test("aXb*c(1)"), url: __pendf_urlParse("https://x.test/a")?.host, bad: __pendf_urlParse("::nope"),
				   joinIter: __pendf_join(new Set([1, 2, 3]).values(), "-"), joinArr: __pendf_join([1, 2], "+") };`,
		);
		expect(await out.p).toBe(5);
		await expect(out.q as Promise<unknown>).rejects.toThrow("boom");
		expect(out.ok).toBe(true);
		expect(out.no).toBe(false);
		expect(out.url).toBe("x.test");
		expect(out.bad).toBeNull();
		expect(out.joinIter).toBe("1-2-3");
		expect(out.joinArr).toBe("1+2");
	});
});

describe("ponyfill call-site rewriting", () => {
	it("rewrites method calls, statics, parenthesized and optional receivers", () => {
		const code = transformed(
			`let cache = null;
			 const m = new Map();
			 const a = m.getOrInsertComputed("k", () => 1);
			 const b = (cache ??= new Map()).getOrInsert("z", 2);
			 const h = null, u = new Uint8Array([171]);
			 const c = h?.toHex() ?? "none";
			 const d = u.toHex();
			 const e = [..."abc"].join("-");
			 const f = Math.sumPrecise([0.1, 0.2]);
			 const out = { a, b, c, d, e, f };`,
		);
		expect(code).not.toMatch(/\.getOrInsertComputed\("k"/);
		const out = runFresh(code);
		expect(out).toEqual({ a: 1, b: 2, c: "none", d: "ab", e: "a-b-c", f: 0.30000000000000004 });
	});

	it("refuses shapes it cannot rewrite safely", () => {
		expect(() => transformed(`const f = m.getOrInsertComputed;`)).toThrow(/used as a value/);
		expect(() => transformed(`const n = x?.toHex().length;`)).toThrow(/optional chain continues/);
		expect(() => transformed(`const n = foo()?.toHex();`)).toThrow(/complex receiver/);
	});

	it("leaves non-call .join properties alone (XFA attribute)", () => {
		expect(() => transformed(`this.join = getStringOption(a); const j = attrs.join;`)).not.toThrow();
	});

	it("removes pdf.js's global Iterator.prototype.join polyfill", () => {
		const src = `if (typeof Iterator.prototype.join !== "function") {\n  Iterator.prototype.join = function (separator) {\n    return [...this].join(separator);\n  };\n}\nconst out = 1;`;
		const code = transformed(src);
		expect(code).not.toMatch(/Iterator\.prototype\.join\s*=/);
	});

	it("assertNoTargets catches leftovers and builtin assignments", () => {
		expect(() => assertNoTargets(`x.getOrInsert(1, 2);`, "t")).toThrow();
		expect(() => assertNoTargets(`Math.sumPrecise([]);`, "t")).toThrow();
		expect(() => assertNoTargets(`Map.prototype.foo = 1;`, "t")).toThrow();
		expect(() => assertNoTargets(`a.join;`, "t")).not.toThrow();
	});

	for (const [key, rel] of [
		["pdf.mjs", "build/pdf.mjs"],
		["pdf_viewer.mjs", "web/pdf_viewer.mjs"],
		["pdf.worker.mjs", "build/pdf.worker.mjs"],
	] as const) {
		it(`the real ${rel} transforms cleanly`, () => {
			const { code, stats } = ponyfill(transform(key, readFileSync(path.join(pdfjsRoot, rel), "utf8")), key) as { code: string; stats: Record<string, number> };
			expect(Object.values(stats).reduce((a, b) => a + b, 0)).toBeGreaterThan(10);
			expect(code).not.toMatch(/Iterator\.prototype\.join\s*=/);
		});
	}
});
