import { describe, expect, it } from "vitest";
import { MIN_READING_WIDTH, PANEL_MAX, PANEL_MIN, clampPanelWidth, panelLayout, scrollToTopAnchor, topAnchor } from "../src/panel/layout";
import { currentOutlineKey, outlineKey } from "../src/panel/outline";

describe("in-view panel placement (D-42)", () => {
	it("docks when the view keeps the reading width beside it", () => {
		expect(panelLayout(1180, 280)).toEqual({ mode: "docked", width: 280 }); // iPad landscape
		expect(panelLayout(280 + MIN_READING_WIDTH, 280).mode).toBe("docked");
	});
	it("overlays on narrow views (iPad portrait, Split View)", () => {
		expect(panelLayout(834, 280)).toEqual({ mode: "overlay", width: 280 });
		expect(panelLayout(320, 280)).toEqual({ mode: "overlay", width: 272 });
		expect(panelLayout(150, 280).width).toBe(150);
	});
	it("can be forced over the pages", () => {
		expect(panelLayout(1600, 300, "overlay")).toEqual({ mode: "overlay", width: 300 });
	});
	it("clamps the remembered width", () => {
		expect(panelLayout(2000, 9999).width).toBe(PANEL_MAX);
		expect(panelLayout(2000, 10).width).toBe(PANEL_MIN);
		expect(panelLayout(2000, Number.NaN).width).toBe(280);
		expect(clampPanelWidth(700, 1000)).toBe(1000 - MIN_READING_WIDTH);
		expect(clampPanelWidth(100, 1600)).toBe(PANEL_MIN);
	});
});

describe("keeping the reading position", () => {
	it("restores the content at the top edge after the page grew", () => {
		// container top at 100; page 7 starts 300 px above it, 1000 px tall → 30 % down
		const a = topAnchor(7, -200, 1000, 100);
		expect(a).toEqual({ page: 7, fy: 0.3 });
		// after a refit the page is 1400 tall and starts at 50: scroll by 50 + 420 − 100 = 370
		expect(scrollToTopAnchor(a, 50, 1400, 100)).toBe(370);
	});
	it("is a no-op when nothing moved", () => {
		const a = topAnchor(2, -40, 800, 0);
		expect(scrollToTopAnchor(a, -40, 800, 0)).toBeCloseTo(0);
	});
});

describe("outline position", () => {
	const tree = [
		{ page: 1, items: [] },
		{ page: 5, items: [{ page: 5, items: [] }, { page: 9, items: [{ page: 12, items: [] }] }] },
		{ page: 20, items: [] },
		{ page: null, items: [] },
	];
	it("finds the section the reader is in, deepest on ties", () => {
		expect(currentOutlineKey(tree, 1)).toBe("0");
		expect(currentOutlineKey(tree, 6)).toBe("1.0");
		expect(currentOutlineKey(tree, 11)).toBe("1.1");
		expect(currentOutlineKey(tree, 15)).toBe("1.1.0");
		expect(currentOutlineKey(tree, 99)).toBe("2");
		expect(currentOutlineKey([{ page: 3, items: [] }], 1)).toBeNull();
	});
	it("keys nodes by position", () => {
		expect(outlineKey([1, 0, 2])).toBe("1.0.2");
	});
});
