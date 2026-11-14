import { describe, expect, it } from "vitest";
import { bounds, dedupe, distanceToPolyline, pathData, roundPoints, simplify, strokeHit } from "../src/ink/model";

describe("simplify", () => {
	it("keeps endpoints and drops collinear points", () => {
		const line = [0, 0, 1, 1, 2, 2, 3, 3, 10, 10];
		expect(simplify(line, 0.1)).toEqual([0, 0, 10, 10]);
	});
	it("keeps corners above the tolerance", () => {
		const corner = [0, 0, 5, 0, 10, 0, 10, 5, 10, 10];
		expect(simplify(corner, 0.1)).toEqual([0, 0, 10, 0, 10, 10]);
	});
	it("keeps dots and two-point strokes as they are", () => {
		expect(simplify([3, 4], 0.5)).toEqual([3, 4]);
		expect(simplify([3, 4, 3, 4], 0.5)).toEqual([3, 4, 3, 4]);
	});
	it("stays within the tolerance of the original stroke", () => {
		const pts: number[] = [];
		for (let i = 0; i <= 200; i++) pts.push(i * 0.5, Math.sin(i / 10) * 20);
		const s = simplify(pts, 0.15);
		expect(s.length).toBeLessThan(pts.length / 2);
		for (let i = 0; i < pts.length; i += 2) expect(distanceToPolyline(pts[i], pts[i + 1], s)).toBeLessThanOrEqual(0.15 + 1e-9);
	});
});

describe("helpers", () => {
	it("rounds to 0.01 and removes repeated points", () => {
		expect(roundPoints([1.23456, -0.004])).toEqual([1.23, -0]);
		expect(dedupe([1, 1, 1, 1, 2, 2, 2, 2, 1, 1])).toEqual([1, 1, 2, 2, 1, 1]);
		expect(dedupe([5, 5, 5, 5])).toEqual([5, 5]);
	});
	it("measures distance and bounds", () => {
		expect(distanceToPolyline(5, 3, [0, 0, 10, 0])).toBeCloseTo(3);
		expect(distanceToPolyline(13, 4, [0, 0, 10, 0])).toBeCloseTo(5);
		expect(distanceToPolyline(1, 1, [1, 2])).toBeCloseTo(1);
		expect(bounds([3, 9, -1, 4, 7, 2])).toEqual({ x0: -1, y0: 2, x1: 7, y1: 9 });
	});
	it("hit-tests strokes including their width", () => {
		const s = [0, 0, 100, 0];
		expect(strokeHit(50, 4, 2, s, 2)).toBe(false); // 4 > 2 + 1
		expect(strokeHit(50, 2.9, 2, s, 2)).toBe(true);
		expect(strokeHit(200, 0, 5, s, 2)).toBe(false);
	});
	it("builds path data, with a visible dot for one point", () => {
		expect(pathData([[1, 2]])).toBe("M1.00 2.00h0.01");
		expect(pathData([[1, 2], [3.456, 4]])).toBe("M1.00 2.00L3.46 4.00");
		expect(pathData([])).toBe("");
	});
});

import { parseSidecar, serializeSidecar, type InkAnnotation } from "../src/store/schema";

describe("compact sidecar", () => {
	it("keeps coordinate arrays on one line and round-trips", () => {
		const ink: InkAnnotation = { id: "i1", type: "ink", page: 2, createdAt: 1, updatedAt: 2, deleted: false, tool: "pen", color: "#1f1f1f", width: 1.5, points: [1.25, 2.5, 3, 4, 5.75, 6] };
		const text = serializeSidecar({ schemaVersion: 1, pdfFingerprint: "fp", annotations: [ink], unknown: [{ type: "future", points: [9, 9] }] });
		expect(text).toContain('"points": [1.25,2.5,3,4,5.75,6]');
		expect(text).toContain('"points": [9,9]');
		const back = parseSidecar(JSON.parse(text));
		expect(back.sidecar.annotations[0]).toEqual(ink);
		expect(back.sidecar.unknown).toEqual([{ type: "future", points: [9, 9] }]);
	});
	it("does not touch strings that look like the placeholder", () => {
		const note = { id: "n", type: "note" as const, page: 1, createdAt: 1, updatedAt: 1, deleted: false, body: "\u0000pendf:0\u0000", target: { kind: "point" as const, x: 1, y: 2 } };
		const text = serializeSidecar({ schemaVersion: 1, pdfFingerprint: "fp", annotations: [note] });
		expect(JSON.parse(text).annotations[0].body).toBe("\u0000pendf:0\u0000");
	});
	it("1,500 handwritten strokes on a page stay a few MB at most", () => {
		const anns: InkAnnotation[] = [];
		for (let k = 0; k < 1500; k++) {
			const pts: number[] = [];
			for (let i = 0; i < 40; i++) pts.push(Math.round((50 + i * 3.1 + (k % 30) * 17) * 100) / 100, Math.round((800 - Math.floor(k / 30) * 15 + Math.sin(i) * 4) * 100) / 100);
			anns.push({ id: `id-${k}`, type: "ink", page: 1, createdAt: k, updatedAt: k, deleted: false, tool: "pen", color: "#1f1f1f", width: 1, points: pts });
		}
		const t0 = performance.now();
		const text = serializeSidecar({ schemaVersion: 1, pdfFingerprint: "fp", annotations: anns });
		const ms = performance.now() - t0;
		expect(text.length).toBeLessThan(1.6e6);
		expect(ms).toBeLessThan(1000);
	});
});
