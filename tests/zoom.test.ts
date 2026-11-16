import { describe, expect, it } from "vitest";
import { MAX_SCALE, MIN_SCALE, anchorIn, clampFactor, clampScale, clampTranslate, isContinuousWheel, projectPoint, scrollCorrection, transformCss, wheelZoomFactor, wheelPixels } from "../src/zoom/math";

describe("composite transform", () => {
	it("keeps the content under the starting centre under the moving centre", () => {
		// element at (100, 50) on screen; gesture started at screen (400, 300) → element coords (300, 250)
		const st = { originX: 300, originY: 250, tx: 0, ty: 0, factor: 2.5 };
		expect(projectPoint(st, 100, 50, 300, 250)).toEqual([400, 300]);
		// fingers moved by (+30, -20): that same content point follows them
		const moved = { ...st, tx: 30, ty: -20 };
		expect(projectPoint(moved, 100, 50, 300, 250)).toEqual([430, 280]);
		// another point scales away from the origin
		expect(projectPoint(st, 100, 50, 310, 250)).toEqual([425, 300]);
	});
	it("builds CSS with the origin and translate-then-scale order", () => {
		expect(transformCss({ originX: 12, originY: 34.5, tx: -3, ty: 4, factor: 1.25 })).toEqual({ origin: "12.00px 34.50px", transform: "translate(-3.00px, 4.00px) scale(1.25000)" });
	});
	it("clamps the gesture to the scale limits", () => {
		expect(clampScale(100)).toBe(MAX_SCALE);
		expect(clampScale(0.01)).toBe(MIN_SCALE);
		expect(clampFactor(1, 100)).toBeCloseTo(MAX_SCALE);
		expect(clampFactor(2, 0.001)).toBeCloseTo(MIN_SCALE / 2);
		expect(clampFactor(1, 1.5)).toBe(1.5);
		expect(clampFactor(0, 2)).toBe(1);
		expect(clampFactor(1, Number.NaN)).toBe(1);
	});
});

describe("reachable preview", () => {
	const view = { left: 0, top: 0, width: 800, height: 600 };
	it("leaves a reachable preview alone", () => {
		// long document scrolled to the middle, page wider than the view after zooming in
		const st = { originX: 400, originY: 5000, tx: 0, ty: 0, factor: 2 };
		expect(clampTranslate(st, { left: 0, top: -4700, height: 100000 }, { left: 50, width: 700 }, view)).toEqual({ tx: 0, ty: 0 });
	});
	it("centres a page that became narrower than the view", () => {
		// page 700 wide at x=50, zoomed out ×0.5 around x=600: it would sit at 325..675 → centred at 312.5..487.5
		const st = { originX: 600, originY: 5000, tx: 0, ty: 0, factor: 0.5 };
		const { tx } = clampTranslate(st, { left: 0, top: -4700, height: 100000 }, { left: 50, width: 700 }, view);
		expect(0 + 600 + 0.5 * (50 - 600) + tx).toBeCloseTo(400 - 175);
	});
	it("does not pull the document's top below the view's top", () => {
		// at the top of the document, zooming in around a point low on the screen
		const st = { originX: 400, originY: 100, tx: 0, ty: 40, factor: 1.5 };
		const { ty } = clampTranslate(st, { left: 0, top: 0, height: 100000 }, null, view);
		expect(0 + 100 * (1 - 1.5) + ty).toBeLessThanOrEqual(0);
		expect(ty).toBe(40); // the top is at −10, still reachable
		const st2 = { ...st, ty: 80 };
		expect(clampTranslate(st2, { left: 0, top: 0, height: 100000 }, null, view).ty).toBeCloseTo(50);
	});
	it("pins a document shorter than the view to its top", () => {
		const st = { originX: 400, originY: 300, tx: 0, ty: 0, factor: 0.5 };
		expect(clampTranslate(st, { left: 0, top: 0, height: 500 }, null, view).ty).toBeCloseTo(-150);
	});
});

describe("commit scroll correction", () => {
	it("puts the anchored point back under the centre after the page grew", () => {
		// before: page at (100, 0) 500×700, centre (350, 350) → anchor (0.5, 0.5)
		const a = anchorIn({ left: 100, top: 0, width: 500, height: 700 }, 350, 350);
		expect(a).toEqual({ fx: 0.5, fy: 0.5 });
		// after the scale change the page is 1000×1400 at (100, 0): scroll right/down so its centre is at (350, 350)
		const { dx, dy } = scrollCorrection(a, { left: 100, top: 0, width: 1000, height: 1400 }, 350, 350);
		expect(dx).toBe(250);
		expect(dy).toBe(350);
		// applying it (scrolling moves content up/left) lands the point on the centre
		expect(100 - dx + a.fx * 1000).toBe(350);
		expect(0 - dy + a.fy * 1400).toBe(350);
	});
	it("handles a zero-size rectangle", () => {
		expect(anchorIn({ left: 0, top: 0, width: 0, height: 0 }, 5, 5)).toEqual({ fx: 0, fy: 0 });
	});
});

describe("wheel", () => {
	it("converts delta modes to pixels", () => {
		expect(wheelPixels(3, 0)).toBe(3);
		expect(wheelPixels(1, 1)).toBe(30);
		expect(wheelPixels(1, 2)).toBe(800);
	});
	it("tells a trackpad pinch from a mouse notch", () => {
		expect(isContinuousWheel(-2.5, 0)).toBe(true);
		expect(isContinuousWheel(-100, 0)).toBe(false);
		expect(isContinuousWheel(-3, 1)).toBe(false);
	});
	it("zooms smoothly and symmetrically", () => {
		expect(wheelZoomFactor(-10, 0)).toBeGreaterThan(1);
		expect(wheelZoomFactor(10, 0)).toBeLessThan(1);
		expect(wheelZoomFactor(-10, 0) * wheelZoomFactor(10, 0)).toBeCloseTo(1);
		// 24 small trackpad events of 3 px: about −51 %, not 24 × 10 % steps
		const f = Array.from({ length: 24 }, () => wheelZoomFactor(3, 0)).reduce((a, b) => a * b, 1);
		expect(f).toBeCloseTo(Math.exp(-0.72), 5);
	});
});
