import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PageGeometry, type ViewBox, applyMatrix, invertMatrix, normalizeRotation, pointInPolygon, viewportTransform } from "../src/geometry";

const ROTATIONS = [0, 90, 180, 270] as const;
const BOXES: Record<string, ViewBox> = {
	"no offset (A4)": [0, 0, 595.28, 841.89],
	"CropBox offset": [100, 150, 500, 700],
	"negative origin": [-50, -20, 562, 772],
};

describe("geometry: PDF ↔ view round trip", () => {
	for (const [name, box] of Object.entries(BOXES)) {
		for (const rot of ROTATIONS) {
			for (const scale of [1, 1.3333, 2.75]) {
				it(`${name}, rotation ${rot}, scale ${scale}`, () => {
					const g = new PageGeometry(box, scale, rot);
					for (let i = 0; i <= 10; i++) {
						for (let j = 0; j <= 10; j++) {
							const x = box[0] + ((box[2] - box[0]) * i) / 10 + 0.123;
							const y = box[1] + ((box[3] - box[1]) * j) / 10 + 0.456;
							const [vx, vy] = g.toView(x, y);
							const [px, py] = g.toPdf(vx, vy);
							expect(Math.abs(px - x)).toBeLessThan(0.01);
							expect(Math.abs(py - y)).toBeLessThan(0.01);
						}
					}
				});
			}
		}
	}

	it("box corners land on the view rectangle corners", () => {
		for (const box of Object.values(BOXES)) {
			for (const rot of ROTATIONS) {
				const g = new PageGeometry(box, 2, rot);
				const corners = [
					g.toView(box[0], box[1]),
					g.toView(box[2], box[1]),
					g.toView(box[0], box[3]),
					g.toView(box[2], box[3]),
				];
				const xs = corners.map((c) => c[0]).sort((a, b) => a - b);
				const ys = corners.map((c) => c[1]).sort((a, b) => a - b);
				expect(xs[0]).toBeCloseTo(0, 6);
				expect(ys[0]).toBeCloseTo(0, 6);
				expect(xs[3]).toBeCloseTo(g.width, 6);
				expect(ys[3]).toBeCloseTo(g.height, 6);
			}
		}
	});

	it("view rect → quad → view polygon is the same rect", () => {
		for (const rot of ROTATIONS) {
			const g = new PageGeometry([100, 150, 500, 700], 1.5, rot);
			const r = { x: 40, y: 70, w: 120, h: 18 };
			const back = g.quadToViewRect(g.viewRectToQuad(r));
			expect(back.x).toBeCloseTo(r.x, 6);
			expect(back.y).toBeCloseTo(r.y, 6);
			expect(back.w).toBeCloseTo(r.w, 6);
			expect(back.h).toBeCloseTo(r.h, 6);
		}
	});

	it("matrix inverse", () => {
		const m = viewportTransform([10, 20, 300, 400], 1.7, 90);
		const inv = invertMatrix(m);
		const p = applyMatrix(inv, ...applyMatrix(m, 33, 44));
		expect(p[0]).toBeCloseTo(33, 9);
		expect(p[1]).toBeCloseTo(44, 9);
	});

	it("normalizes rotations", () => {
		expect(normalizeRotation(-90)).toBe(270);
		expect(normalizeRotation(450)).toBe(90);
		expect(normalizeRotation(360)).toBe(0);
	});

	it("client → view under a scaled page rect", () => {
		const g = new PageGeometry([0, 0, 600, 800], 1, 0);
		const pageRect = { left: 100, top: 50, width: 1200, height: 1600 }; // shown at 2×
		const [x, y] = g.clientToView(700, 850, pageRect);
		expect(x).toBeCloseTo(300);
		expect(y).toBeCloseTo(400);
	});

	it("point in polygon with tolerance", () => {
		const poly: [number, number][] = [[0, 0], [10, 0], [10, 5], [0, 5]];
		expect(pointInPolygon([5, 2], poly)).toBe(true);
		expect(pointInPolygon([11, 2], poly)).toBe(false);
		expect(pointInPolygon([11, 2], poly, 1.5)).toBe(true);
	});
});

// Cross-check against pdf.js's own PageViewport on real fixture pages.
describe("geometry matches pdf.js PageViewport", () => {
	let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
	beforeAll(async () => {
		pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	});

	for (const file of ["rotations.pdf", "cropbox.pdf", "a4.pdf"]) {
		it(file, async () => {
			const data = new Uint8Array(readFileSync(path.join(__dirname, "..", "fixtures", "out", file)));
			const task = pdfjs.getDocument({ data, verbosity: 0 });
			const doc = await task.promise;
			try {
				for (let n = 1; n <= doc.numPages; n++) {
					const page = await doc.getPage(n);
					for (const extra of [0, 90, 180, 270]) {
						for (const scale of [1, 1.5]) {
							const rotation = (page.rotate + extra) % 360;
							const vp = page.getViewport({ scale, rotation });
							const g = new PageGeometry(page.view as ViewBox, scale * (vp.userUnit ?? 1), rotation);
							for (let k = 0; k < 6; k++) expect(g.toViewM[k]).toBeCloseTo(vp.transform[k], 9);
							expect(g.width).toBeCloseTo(vp.width, 9);
							expect(g.height).toBeCloseTo(vp.height, 9);
						}
					}
				}
			} finally {
				await task.destroy();
			}
		});
	}
});
