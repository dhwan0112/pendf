// Off-page coordinates (0.8.0, INVESTIGATION §13): margin content is stored as PDF user-space
// points outside the page box. Nothing on the data path may clip or reject them.
import { describe, expect, it } from "vitest";
import { PageGeometry, type ViewBox } from "../src/geometry";
import { validateAnnotation, parseSidecar, serializeSidecar, type InkAnnotation, type NoteAnnotation } from "../src/store/schema";
import { mergeAnnotations } from "../src/store/merge";
import { bounds, distanceToPolyline, strokeHit } from "../src/ink/model";
import { buildSubpath, parseSubpath } from "../src/links/format";
import { noteAnchor } from "../src/notes/model";

const box: ViewBox = [0, 0, 612, 792];
const cropped: ViewBox = [36, 72, 576, 720];

describe("geometry beyond the page box", () => {
	for (const vb of [box, cropped]) {
		for (const rot of [0, 90, 180, 270]) {
			it(`round-trips points outside the box (rotation ${rot}, box ${vb.join(",")})`, () => {
				const g = new PageGeometry(vb, 1.5, rot);
				for (const [x, y] of [[-200, 100], [vb[2] + 300, vb[3] + 50], [vb[0] - 10, vb[1] - 10], [1000, -400]]) {
					const v = g.toView(x, y);
					const back = g.toPdf(v[0], v[1]);
					expect(back[0]).toBeCloseTo(x, 9);
					expect(back[1]).toBeCloseTo(y, 9);
				}
				// a view point right of the displayed page maps to PDF space outside the box, not clamped
				const [px, py] = g.toPdf(g.width + 100, g.height / 2);
				const outside = px < vb[0] || px > vb[2] || py < vb[1] || py > vb[3];
				expect(outside).toBe(true);
			});
		}
	}
});

const ink = (points: number[], id = "i1", updatedAt = 1): InkAnnotation => ({ id, type: "ink", page: 1, createdAt: 1, updatedAt, deleted: false, tool: "pen", color: "#000000", width: 1.5, points });
const pointNote = (x: number, y: number): NoteAnnotation => ({ id: "n1", type: "note", page: 1, createdAt: 1, updatedAt: 1, deleted: false, body: "m", target: { kind: "point", x, y } });

describe("sidecar data path keeps off-page values", () => {
	it("validates and serializes them unchanged", () => {
		const a = ink([700, 400, 812.5, 380, -150, -20]);
		const n = pointNote(905.25, 410);
		expect(validateAnnotation(a)).toBeNull();
		expect(validateAnnotation(n)).toBeNull();
		const text = serializeSidecar({ schemaVersion: 1, pdfFingerprint: "fp", annotations: [a, n] });
		const back = parseSidecar(JSON.parse(text));
		expect(back.problems).toEqual([]);
		expect(back.sidecar.annotations).toEqual([a, n]);
	});
	it("merges them like any other values", () => {
		const older = ink([700, 400, 710, 410], "i1", 1);
		const newer = ink([900, 400, 950, 410], "i1", 2);
		expect(mergeAnnotations([older], [newer])[0]).toEqual(newer);
	});
	it("eraser hit test and bounds work beyond the page", () => {
		const pts = [650, 300, 900, 300];
		expect(bounds(pts)).toEqual({ x0: 650, y0: 300, x1: 900, y1: 300 });
		expect(distanceToPolyline(800, 305, pts)).toBeCloseTo(5);
		expect(strokeHit(800, 305, 4, pts, 2)).toBe(true);
		expect(strokeHit(800, 330, 4, pts, 2)).toBe(false);
	});
	it("links carry off-page and negative rectangles", () => {
		const sub = buildSubpath({ page: 3, rect: [640.25, -30, 880, 12.5] });
		expect(parseSubpath(sub).rect).toEqual([640.3, -30, 880, 12.5]);
	});
	it("a point note in the margin keeps its anchor", () => {
		expect(noteAnchor(pointNote(905.25, 410), () => undefined)).toEqual([905.25, 410]);
	});
});
