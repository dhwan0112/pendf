import { describe, expect, it } from "vitest";
import { pagesOverBudget } from "../src/zoom/budget";
import { PDFJS_MOBILE_MAX_PIXELS, ZOOM_PRESETS, isZoomPreset, renderConfig } from "../src/zoom/presets";

const MB = 1048576;

describe("canvas budget", () => {
	it("frees nothing under budget", () => {
		expect(pagesOverBudget([{ id: 1, bytes: 10 * MB }], new Set([1]), 20 * MB)).toEqual([]);
	});
	it("frees the pages farthest from the view first, never a visible one", () => {
		const pages = [1, 2, 3, 4, 5, 9].map((id) => ({ id, bytes: 20 * MB }));
		// visible 4–5; total 120 MB, budget 70 MB → free 9 (dist 4), 1 (dist 3), 2 (dist 2)
		expect(pagesOverBudget(pages, new Set([4, 5]), 70 * MB)).toEqual([9, 1, 2]);
	});
	it("stops when only visible pages are left", () => {
		const pages = [3, 4].map((id) => ({ id, bytes: 50 * MB }));
		expect(pagesOverBudget(pages, new Set([3, 4]), 10 * MB)).toEqual([]);
	});
});

describe("zoom rendering presets", () => {
	it("default keeps pdf.js's own iOS canvas limit on mobile (0.7.1 used 2^23)", () => {
		const m = renderConfig("default", true);
		expect(m.maxCanvasPixels).toBe(PDFJS_MOBILE_MAX_PIXELS);
		expect(m.maxCanvasPixels).toBeLessThan(2 ** 23);
		expect(m.enableDetailCanvas).toBe(true);
		expect(m.releaseOffscreen).toBe(true);
		expect(renderConfig("default", false).maxCanvasPixels).toBe(2 ** 25);
	});
	it("memory saver is smaller everywhere", () => {
		for (const mobile of [true, false]) {
			const d = renderConfig("default", mobile);
			const s = renderConfig("low-memory", mobile);
			expect(s.maxCanvasPixels!).toBeLessThan(d.maxCanvasPixels!);
			expect(s.budgetMB!).toBeLessThan(d.budgetMB!);
		}
	});
	it("no-detail turns the detail canvas off; pdf.js defaults passes nothing", () => {
		expect(renderConfig("no-detail", true).enableDetailCanvas).toBe(false);
		const p = renderConfig("pdfjs", true);
		expect(p.maxCanvasPixels).toBeUndefined();
		expect(p.enableDetailCanvas).toBeUndefined();
		expect(p.budgetMB).toBeNull();
		expect(p.releaseOffscreen).toBe(false);
	});
	it("validates stored values", () => {
		for (const k of Object.keys(ZOOM_PRESETS)) expect(isZoomPreset(k)).toBe(true);
		expect(isZoomPreset("huge")).toBe(false);
		expect(isZoomPreset(undefined)).toBe(false);
		expect(renderConfig("nonsense" as never, true).preset).toBe("default");
	});
});
