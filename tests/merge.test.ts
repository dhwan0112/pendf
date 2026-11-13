import { describe, expect, it } from "vitest";
import { mergeAnnotations, mergeSidecars, pickWinner, stableStringify } from "../src/store/merge";
import type { Annotation, HighlightAnnotation } from "../src/store/schema";

function h(id: string, updatedAt: number, extra: Partial<HighlightAnnotation> = {}): HighlightAnnotation {
	return { id, type: "highlight", page: 1, createdAt: 0, updatedAt, deleted: false, quads: [], color: "#ffd400", text: "", ...extra };
}

describe("merge", () => {
	it("concurrent adds on two devices: union", () => {
		const out = mergeAnnotations([h("a", 1)], [h("b", 1)]);
		expect(out.map((x) => x.id).sort()).toEqual(["a", "b"]);
	});

	it("one side deletes: deletion wins even if the other side edited later", () => {
		const del = h("a", 5, { deleted: true });
		const edit = h("a", 9, { color: "#000000" });
		expect(mergeAnnotations([del], [edit])[0].deleted).toBe(true);
		expect(mergeAnnotations([edit], [del])[0].deleted).toBe(true);
	});

	it("both deleted: later tombstone kept", () => {
		const a = h("a", 5, { deleted: true });
		const b = h("a", 7, { deleted: true });
		expect(mergeAnnotations([a], [b])[0].updatedAt).toBe(7);
	});

	it("updatedAt conflict: newest wins", () => {
		const out = mergeAnnotations([h("a", 5, { color: "#111111" })], [h("a", 6, { color: "#222222" })]);
		expect((out[0] as HighlightAnnotation).color).toBe("#222222");
	});

	it("exact tie resolves the same way regardless of order (convergence)", () => {
		const x = h("a", 5, { color: "#111111" });
		const y = h("a", 5, { color: "#222222" });
		expect(pickWinner(x, y)).toEqual(pickWinner(y, x));
	});

	it("duplicate ids inside one list are deduped", () => {
		const out = mergeAnnotations([h("a", 1), h("a", 3), h("a", 2)]);
		expect(out).toHaveLength(1);
		expect(out[0].updatedAt).toBe(3);
	});

	it("is commutative and idempotent", () => {
		const A: Annotation[] = [h("a", 1), h("b", 4, { deleted: true }), h("c", 2)];
		const B: Annotation[] = [h("a", 3), h("b", 5), h("d", 1)];
		const ab = mergeAnnotations(A, B).map(stableStringify).sort();
		const ba = mergeAnnotations(B, A).map(stableStringify).sort();
		expect(ab).toEqual(ba);
		const twice = mergeAnnotations(mergeAnnotations(A, B), B).map(stableStringify).sort();
		expect(twice).toEqual(ab);
	});

	it("keeps unknown entries from both sides once", () => {
		const out = mergeSidecars(
			{ schemaVersion: 1, pdfFingerprint: "f", annotations: [], unknown: [{ x: 1 }] },
			{ schemaVersion: 1, pdfFingerprint: "f", annotations: [], unknown: [{ x: 1 }, { y: 2 }] },
		);
		expect(out.unknown).toEqual([{ x: 1 }, { y: 2 }]);
	});

	it("stableStringify ignores key order", () => {
		expect(stableStringify({ a: 1, b: [1, { d: 2, c: 3 }] })).toBe(stableStringify({ b: [1, { c: 3, d: 2 }], a: 1 }));
	});
});
