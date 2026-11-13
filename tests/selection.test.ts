// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { piecesFromRange } from "../src/highlight/selection";

// jsdom has no layout; give each text node's sub-range a deterministic rect
// derived from its span's data attributes so the splitting logic is testable.
beforeEach(() => {
	Range.prototype.getClientRects = function (this: Range) {
		const el = (this.startContainer.parentElement ?? null) as HTMLElement | null;
		const y = Number(el?.dataset.y ?? 0);
		const x = Number(el?.dataset.x ?? 0) + this.startOffset * 5;
		const w = (this.endOffset - this.startOffset) * 5;
		const list = [new DOMRect(x, y, w, 10)];
		return Object.assign(list, { item: (i: number) => list[i] }) as unknown as DOMRectList;
	};
});

function page(n: number, lines: string[]): string {
	return `<div class="page" data-page-number="${n}"><div class="canvasWrapper"></div><div class="textLayer">${lines
		.map((l, i) => `<span data-x="10" data-y="${i * 20}">${l}</span><br>`)
		.join("")}</div></div>`;
}

describe("piecesFromRange", () => {
	it("splits a selection across a page boundary into per-page pieces", () => {
		document.body.innerHTML = `<div id="root">${page(1, ["first page line one", "first page line two"])}${page(2, ["second page top", "second page next"])}</div>`;
		const root = document.getElementById("root")!;
		const spans = root.querySelectorAll(".textLayer span");
		const range = document.createRange();
		range.setStart(spans[1].firstChild!, 6); // "page line two"
		range.setEnd(spans[2].firstChild!, 6); // "second"
		const pieces = piecesFromRange(range, root);
		expect(pieces.map((p) => p.pageNumber)).toEqual([1, 2]);
		expect(pieces[0].text).toBe("page line two\n");
		expect(pieces[1].text).toBe("second");
		expect(pieces[0].rects).toHaveLength(1);
		expect(pieces[1].rects).toHaveLength(1);
	});

	it("collects every line of a multi-line selection and inserts line breaks", () => {
		document.body.innerHTML = `<div id="root">${page(3, ["alpha beta", "gamma delta", "epsilon"])}</div>`;
		const root = document.getElementById("root")!;
		const spans = root.querySelectorAll(".textLayer span");
		const range = document.createRange();
		range.setStart(spans[0].firstChild!, 6);
		range.setEnd(spans[2].firstChild!, 3);
		const [p] = piecesFromRange(range, root);
		expect(p.pageNumber).toBe(3);
		expect(p.rects).toHaveLength(3);
		expect(p.text).toBe("beta\ngamma delta\neps");
	});

	it("ignores text outside pdf.js text layers", () => {
		document.body.innerHTML = `<div id="root"><div class="toolbar"><span>Find</span></div>${page(1, ["inside"])}</div>`;
		const root = document.getElementById("root")!;
		const range = document.createRange();
		range.setStart(root.querySelector(".toolbar span")!.firstChild!, 0);
		range.setEnd(root.querySelector(".textLayer span")!.firstChild!, 3);
		const pieces = piecesFromRange(range, root);
		expect(pieces).toHaveLength(1);
		expect(pieces[0].text).toBe("ins");
	});
});
