import { describe, expect, it } from "vitest";
import { defaultBookmarkTitle, orderAtEnd, reorder, sectionFor, sortedBookmarks } from "../src/bookmarks/model";
import type { Annotation, BookmarkAnnotation } from "../src/store/schema";

const bm = (id: string, order: number, extra: Partial<BookmarkAnnotation> = {}): BookmarkAnnotation => ({
	id,
	type: "bookmark",
	page: 1,
	createdAt: 1,
	updatedAt: 1,
	deleted: false,
	y: 700,
	title: id,
	order,
	...extra,
});

const apply = (list: BookmarkAnnotation[], changes: Map<string, number>) =>
	sortedBookmarks(list.map((b) => (changes.has(b.id) ? { ...b, order: changes.get(b.id)! } : b))).map((b) => b.id);

describe("sortedBookmarks", () => {
	it("orders by order, then creation, and skips deleted / other kinds", () => {
		const all: Annotation[] = [
			bm("c", 3),
			bm("a", 1),
			bm("b2", 2, { createdAt: 5 }),
			bm("b1", 2, { createdAt: 4 }),
			bm("gone", 0, { deleted: true }),
			{ id: "h", type: "highlight", page: 1, createdAt: 1, updatedAt: 1, deleted: false, quads: [], color: "#000000", text: "" },
		];
		expect(sortedBookmarks(all).map((b) => b.id)).toEqual(["a", "b1", "b2", "c"]);
	});
	it("appends after the last one", () => {
		expect(orderAtEnd([])).toBe(1);
		expect(orderAtEnd([bm("a", 1), bm("b", 2.5)])).toBe(3);
	});
});

describe("reorder", () => {
	const list = [bm("a", 1), bm("b", 2), bm("c", 3), bm("d", 4)];
	it("moves to the front, the end and the middle changing only the moved item", () => {
		const front = reorder(list, "c", 0);
		expect([...front.keys()]).toEqual(["c"]);
		expect(apply(list, front)).toEqual(["c", "a", "b", "d"]);
		const end = reorder(list, "a", 3);
		expect(apply(list, end)).toEqual(["b", "c", "d", "a"]);
		const mid = reorder(list, "d", 1);
		expect(apply(list, mid)).toEqual(["a", "d", "b", "c"]);
	});
	it("does nothing when the item stays put or is unknown", () => {
		expect(reorder(list, "b", 1).size).toBe(0);
		expect(reorder(list, "zz", 0).size).toBe(0);
	});
	it("renumbers when repeated moves exhaust the gap", () => {
		let cur = list.slice();
		for (let k = 0; k < 80; k++) {
			const moving = k % 2 ? "d" : "c";
			const ch = reorder(sortedBookmarks(cur), moving, 1);
			cur = cur.map((b) => (ch.has(b.id) ? { ...b, order: ch.get(b.id)! } : b));
			const ids = sortedBookmarks(cur).map((b) => b.id);
			expect(ids[1]).toBe(moving);
			expect(new Set(sortedBookmarks(cur).map((b) => b.order)).size).toBe(4);
		}
	});
});

describe("titles", () => {
	const outline = [
		{ title: "1 Introduction", page: 1, depth: 0 },
		{ title: "2 Methods", page: 4, depth: 0 },
		{ title: "2.1 Setup", page: 5, depth: 1 },
		{ title: "Unresolved", page: null, depth: 0 },
		{ title: "3 Results", page: 9, depth: 0 },
	];
	it("picks the section a page belongs to", () => {
		expect(sectionFor(outline, 6)).toBe("2.1 Setup");
		expect(sectionFor(outline, 4)).toBe("2 Methods");
		expect(sectionFor(outline, 12)).toBe("3 Results");
		expect(sectionFor([], 3)).toBeUndefined();
	});
	it("builds a default title", () => {
		expect(defaultBookmarkTitle(6, "2.1 Setup")).toBe("Page 6 — 2.1 Setup");
		expect(defaultBookmarkTitle(2)).toBe("Page 2");
	});
});
