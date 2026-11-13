import { describe, expect, it } from "vitest";
import { cleanRects, mergeLineRects, normalizeText, sameLine } from "../src/highlight/rects";

const r = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

describe("line rect merging", () => {
	it("merges words on one line into one rect", () => {
		const out = mergeLineRects([r(10, 100, 30, 12), r(44, 100.5, 40, 12), r(88, 99.8, 25, 12.4)]);
		expect(out).toHaveLength(1);
		expect(out[0].x).toBeCloseTo(10);
		expect(out[0].x + out[0].w).toBeCloseTo(113);
	});

	it("keeps separate lines separate", () => {
		const out = mergeLineRects([r(10, 100, 200, 12), r(10, 116, 180, 12), r(10, 132, 90, 12)]);
		expect(out).toHaveLength(3);
		expect(out.map((x) => x.y)).toEqual([100, 116, 132]);
	});

	it("does not bridge a two-column gutter", () => {
		// same baseline, 24pt gutter at 10pt type
		const out = mergeLineRects([r(56, 100, 230, 10), r(310, 100, 230, 10)]);
		expect(out).toHaveLength(2);
	});

	it("merges fragments separated by normal word spacing", () => {
		expect(sameLine(r(0, 0, 50, 10), r(53, 0.5, 20, 10))).toBe(true);
		expect(sameLine(r(0, 0, 50, 10), r(0, 20, 50, 10))).toBe(false);
	});

	it("handles superscripts as part of the line", () => {
		const out = mergeLineRects([r(10, 100, 50, 12), r(61, 97, 6, 7), r(68, 100, 40, 12)]);
		expect(out).toHaveLength(1);
	});

	it("drops degenerate and container-sized rects", () => {
		const out = cleanRects([r(0, 0, 0, 10), r(0, 0, 10, 0.2), r(0, 0, 500, 800), r(1, 1, 10, 12), r(12, 1, 10, 12)]);
		expect(out).toHaveLength(2);
	});
});

describe("text normalization", () => {
	it("collapses whitespace and rejoins hyphenated words", () => {
		expect(normalizeText("  spec-\ntroscopy   is\n fun ")).toBe("spectroscopy is fun");
		expect(normalizeText("한국어\n텍스트")).toBe("한국어 텍스트");
		expect(normalizeText("E-\nMail")).toBe("E- Mail");
	});
});
