import { describe, expect, it } from "vitest";
import { PageGeometry, type ViewBox } from "../src/geometry";
import { DEFAULT_MARGIN, autoMargin, hiddenSides, intrinsicRotation, intrinsicWidth, mergeExtent, normalizeMargin, offPageExtent, screenSide } from "../src/margin/model";

const letter: ViewBox = [0, 0, 612, 792];

/** A PDF point `share` of the page width beyond the displayed right edge, half way down (intrinsic orientation). */
function rightOf(vb: ViewBox, rot: number, share: number): [number, number] {
	const g = new PageGeometry(vb, 1, rot);
	return g.toPdf(g.width * (1 + share), g.height / 2);
}

describe("margin convention: sides of the page as displayed with its own /Rotate (D-41)", () => {
	for (const rot of [0, 90, 180, 270]) {
		it(`a point right of the displayed page is right-margin content (page /Rotate ${rot})`, () => {
			const p = rightOf(letter, rot, 0.3);
			const e = offPageExtent(p, letter, rot);
			expect(e.right).toBeCloseTo(0.3, 9);
			expect(e.left).toBe(0);
			expect(e.top).toBe(0);
			expect(e.bottom).toBe(0);
		});
		it(`the reader's view rotation turns the margin with the page (page /Rotate ${rot})`, () => {
			// total rotation = page + view; the content stays right of the page in the page's own orientation
			for (const view of [0, 90, 180, 270]) {
				expect(intrinsicRotation(rot + view, view)).toBe(rot % 360);
				const g = new PageGeometry(letter, 1, rot + view);
				const [x, y] = rightOf(letter, rot, 0.3);
				const [vx, vy] = g.toView(x, y);
				const side = screenSide("right", view);
				if (side === "right") expect(vx).toBeGreaterThan(g.width);
				if (side === "bottom") expect(vy).toBeGreaterThan(g.height);
				if (side === "left") expect(vx).toBeLessThan(0);
				if (side === "top") expect(vy).toBeLessThan(0);
			}
		});
	}
	it("intrinsic width swaps for quarter turns", () => {
		expect(intrinsicWidth(letter, 0)).toBe(612);
		expect(intrinsicWidth(letter, 90)).toBe(792);
		expect(intrinsicWidth([36, 72, 576, 720], 270)).toBe(648);
	});
	it("maps margin sides to screen sides", () => {
		expect(screenSide("right", 0)).toBe("right");
		expect(screenSide("right", 90)).toBe("bottom");
		expect(screenSide("right", 180)).toBe("left");
		expect(screenSide("left", 90)).toBe("top");
		expect(screenSide("left", 270)).toBe("bottom");
	});
});

describe("opening a PDF with margin content", () => {
	it("turns the margin on, on the side with content, wide enough", () => {
		const e = offPageExtent([...rightOf(letter, 0, 0.8), ...rightOf(letter, 0, 0.2)], letter, 0);
		const m = autoMargin(e, DEFAULT_MARGIN);
		expect([m.on, m.side]).toEqual([true, "right"]);
		expect(m.ratio).toBeCloseTo(0.85, 9);
		const left = offPageExtent([-100, 400], letter, 0);
		expect(autoMargin(left, DEFAULT_MARGIN)).toEqual({ on: true, side: "left", ratio: 0.5 });
	});
	it("keeps the configured margin when there is none, or only a stroke grazing the edge", () => {
		expect(autoMargin(offPageExtent([300, 400], letter, 0), DEFAULT_MARGIN)).toEqual(DEFAULT_MARGIN);
		expect(autoMargin(offPageExtent([614, 400], letter, 0), DEFAULT_MARGIN)).toEqual(DEFAULT_MARGIN);
	});
	it("reports content hidden by a closed or narrow margin", () => {
		const e = mergeExtent(offPageExtent(rightOf(letter, 0, 0.7), letter, 0), offPageExtent([-50, 10], letter, 0));
		expect(hiddenSides(e, { on: false, side: "right", ratio: 0.5 })).toEqual(["left", "right"]);
		expect(hiddenSides(e, { on: true, side: "right", ratio: 0.5 })).toEqual(["left", "right"]);
		expect(hiddenSides(e, { on: true, side: "right", ratio: 1 })).toEqual(["left"]);
	});
	it("normalizes stored values", () => {
		expect(normalizeMargin({ on: true, side: "left", ratio: 0.75 })).toEqual({ on: true, side: "left", ratio: 0.75 });
		expect(normalizeMargin({ on: "x", side: "up", ratio: -1 })).toEqual(DEFAULT_MARGIN);
		expect(normalizeMargin({ ratio: 99 }).ratio).toBe(3);
	});
});
