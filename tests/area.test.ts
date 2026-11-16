import { describe, expect, it } from "vitest";
import { PageGeometry, type Quad, type ViewBox } from "../src/geometry";
import { MIN_AREA_PX, areaRenderPlan, dragRect, pixelsPerPoint, quadBox, textInBox, type TextItem } from "../src/area/model";

const letter: ViewBox = [0, 0, 612, 792];

describe("drawing an area", () => {
	it("normalizes a drag in any direction and clamps it to the page", () => {
		expect(dragRect(300, 200, 100, 50, 600, 800)).toEqual({ x: 100, y: 50, w: 200, h: 150 });
		expect(dragRect(-20, 700, 650, 900, 600, 800)).toEqual({ x: 0, y: 700, w: 600, h: 100 });
		expect(MIN_AREA_PX).toBeGreaterThan(2);
	});
	for (const rot of [0, 90, 180, 270]) {
		it(`a dragged rectangle becomes the PDF box it covers (rotation ${rot})`, () => {
			// a known PDF box, shown at 1.37× and rotated: drawing over its view rect gives it back
			const g = new PageGeometry(letter, 1.37, rot);
			const box: [number, number, number, number] = [100, 500, 250, 600];
			const q: Quad = [box[0], box[3], box[2], box[3], box[0], box[1], box[2], box[1]];
			const vr = g.quadToViewRect(q);
			const r = dragRect(vr.x + vr.w, vr.y + vr.h, vr.x, vr.y, g.width, g.height);
			const back = quadBox(g.viewRectToQuad(r));
			back.forEach((v, i) => expect(v).toBeCloseTo(box[i], 9));
		});
	}
});

describe("text inside an area", () => {
	const joined = "Title line one Body text here Footnote";
	const items: TextItem[] = [
		{ x: 72, y: 700, w: 120, h: 14, start: 0, len: 14 }, // "Title line one"
		{ x: 72, y: 650, w: 110, h: 11, start: 15, len: 14 }, // "Body text here"
		{ x: 72, y: 80, w: 60, h: 8, start: 30, len: 8 }, // "Footnote"
	];
	it("takes the items whose centre is inside", () => {
		expect(textInBox(items, joined, [60, 640, 300, 720])).toBe("Title line one Body text here");
		expect(textInBox(items, joined, [60, 70, 300, 100])).toBe("Footnote");
		expect(textInBox(items, joined, [400, 400, 500, 500])).toBe("");
	});
	it("keeps the case of the original text", () => {
		const raw: TextItem[] = items.map((it, i) => ({ ...it, raw: ["Title Line One", "Body Text", "FN"][i] }));
		expect(textInBox(raw, joined, [60, 640, 300, 720])).toBe("Title Line One Body Text");
	});
	it("follows the text direction (vertical text)", () => {
		const up: TextItem = { x: 300, y: 100, w: 200, h: 12, ux: 0, uy: 1, start: 0, len: 5 };
		// runs upwards from (300, 100): centre ≈ (296, 200)
		expect(textInBox([up], "Vert!", [280, 150, 310, 250])).toBe("Vert!");
		expect(textInBox([up], "Vert!", [400, 150, 500, 250])).toBe("");
	});
});

describe("area image plan", () => {
	const q: Quad = [100, 600, 250, 600, 100, 500, 250, 500];
	it("renders at scale × 96/72 px per point", () => {
		const p = areaRenderPlan(q, letter, 0, 2, 1e9);
		expect(p.scale).toBeCloseTo(pixelsPerPoint(2));
		expect(p.width).toBe(Math.ceil(150 * pixelsPerPoint(2)));
		expect(p.height).toBe(Math.ceil(100 * pixelsPerPoint(2)));
		expect(p.reduced).toBe(false);
	});
	it("turns with the page's own rotation", () => {
		const p = areaRenderPlan(q, letter, 90, 1, 1e9);
		expect(p.width).toBe(Math.ceil(100 * pixelsPerPoint(1)));
		expect(p.height).toBe(Math.ceil(150 * pixelsPerPoint(1)));
	});
	it("stays within the pixel budget", () => {
		const p = areaRenderPlan(q, letter, 0, 8, 100_000);
		expect(p.width * p.height).toBeLessThanOrEqual(100_000);
		expect(p.reduced).toBe(true);
	});
});
