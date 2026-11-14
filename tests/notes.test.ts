import { describe, expect, it } from "vitest";
import type { Quad } from "../src/geometry";
import { annotationTop, noteAnchor, noteForHighlight, notesForHighlights, panelPages } from "../src/notes/model";
import { SidecarStore } from "../src/store/sidecar";
import { type Annotation, type HighlightAnnotation, type NoteAnnotation, sidecarPathFor } from "../src/store/schema";
import { UndoStack } from "../src/store/undo";
import { MemFs, manualTimers } from "./memfs";

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

function hl(page: number, top: number, extra: Partial<HighlightAnnotation> = {}): HighlightAnnotation {
	// one line from x 100..300, y top-10..top (UL, UR, LL, LR)
	const q: Quad = [100, top, 300, top, 100, top - 10, 300, top - 10];
	return { id: id("h"), type: "highlight", page, createdAt: seq, updatedAt: seq, deleted: false, quads: [q], color: "#ffd400", text: `text ${seq}`, ...extra };
}

function pointNote(page: number, x: number, y: number, body = "note", extra: Partial<NoteAnnotation> = {}): NoteAnnotation {
	return { id: id("n"), type: "note", page, createdAt: seq, updatedAt: seq, deleted: false, body, target: { kind: "point", x, y }, ...extra };
}

function hlNote(h: HighlightAnnotation, body = "on highlight", extra: Partial<NoteAnnotation> = {}): NoteAnnotation {
	return { id: id("n"), type: "note", page: h.page, createdAt: seq, updatedAt: seq, deleted: false, body, target: { kind: "highlight", highlightId: h.id }, ...extra };
}

const lookup = (list: Annotation[]) => (x: string) => list.find((a) => a.id === x);

describe("noteAnchor", () => {
	it("point notes sit on their point", () => {
		const n = pointNote(3, 12.5, 700);
		expect(noteAnchor(n, lookup([n]))).toEqual([12.5, 700]);
	});
	it("highlight notes sit on the top-right corner of the first line", () => {
		const h = hl(1, 500);
		const n = hlNote(h);
		expect(noteAnchor(n, lookup([h, n]))).toEqual([300, 500]);
	});
	it("a note whose highlight is gone or deleted has no anchor", () => {
		const h = hl(1, 500, { deleted: true });
		const n = hlNote(h);
		expect(noteAnchor(n, lookup([h, n]))).toBeNull();
		expect(noteAnchor(hlNote(hl(1, 400)), lookup([]))).toBeNull();
	});
});

describe("notesForHighlights", () => {
	it("finds live notes of the given highlights only", () => {
		const a = hl(1, 500);
		const b = hl(1, 400);
		const na = hlNote(a);
		const nb = hlNote(b);
		const dead = hlNote(a, "gone", { deleted: true });
		const all = [a, b, na, nb, dead, pointNote(1, 1, 1)];
		expect(notesForHighlights(all, [a.id]).map((n) => n.id)).toEqual([na.id]);
		expect(noteForHighlight(all, b.id)?.id).toBe(nb.id);
		expect(noteForHighlight(all, "nope")).toBeUndefined();
	});
});

describe("panelPages", () => {
	it("groups by page, orders top-down, attaches highlight notes", () => {
		const low = hl(2, 200);
		const high = hl(2, 700);
		const onHigh = hlNote(high, "**bold**");
		const p1 = pointNote(1, 50, 300);
		const mid = pointNote(2, 50, 450);
		const pages = panelPages([low, onHigh, high, mid, p1]);
		expect(pages.map((p) => p.page)).toEqual([1, 2]);
		expect(pages[0].items.map((i) => i.annotation.id)).toEqual([p1.id]);
		expect(pages[1].items.map((i) => i.annotation.id)).toEqual([high.id, mid.id, low.id]);
		expect(pages[1].items[0].note?.id).toBe(onHigh.id);
		// the attached note is not listed again on its own
		expect(pages[1].items.some((i) => i.annotation.id === onHigh.id)).toBe(false);
	});
	it("lists an orphaned highlight note on its own and skips deleted items", () => {
		const gone = hl(1, 500, { deleted: true });
		const orphan = hlNote(gone, "orphan");
		const dead = pointNote(1, 1, 1, "x", { deleted: true });
		const pages = panelPages([gone, orphan, dead]);
		expect(pages).toHaveLength(1);
		expect(pages[0].items.map((i) => i.annotation.id)).toEqual([orphan.id]);
	});
	it("keeps the oldest note on a highlight attached, lists the others", () => {
		const h = hl(1, 600);
		const first = hlNote(h, "first", { createdAt: 1 });
		const second = hlNote(h, "second", { createdAt: 2 });
		const pages = panelPages([h, second, first]);
		expect(pages[0].items.find((i) => i.annotation.id === h.id)?.note?.id).toBe(first.id);
		expect(pages[0].items.map((i) => i.annotation.id)).toContain(second.id);
	});
	it("annotationTop uses the highest point of each kind", () => {
		const h = hl(1, 600);
		expect(annotationTop(h, lookup([h]))).toBe(600);
		expect(annotationTop({ id: "b", type: "bookmark", page: 1, createdAt: 0, updatedAt: 0, deleted: false, y: 321, title: "t", order: 0 }, lookup([]))).toBe(321);
		expect(annotationTop({ id: "i", type: "ink", page: 1, createdAt: 0, updatedAt: 0, deleted: false, tool: "pen", color: "#000000", width: 1, points: [0, 10, 5, 90, 7, 40] }, lookup([]))).toBe(90);
	});
});

describe("notes in the store", () => {
	const PDF = "notes/doc.pdf";
	async function store() {
		const fs = new MemFs();
		const t = manualTimers();
		const s = new SidecarStore(fs, PDF, "fp", { ...t, now: () => 1_000_000 + seq++ });
		await s.load();
		return { fs, t, s };
	}

	it("round-trips notes of both kinds through the sidecar", async () => {
		const { fs, s } = await store();
		const h = hl(4, 650);
		const a = hlNote(h, "# Title\n\n- [ ] task\n\n[[Other note]]");
		const b = pointNote(4, 72.25, 512.5, "멀티바이트 ✓");
		s.upsert(h);
		s.upsert(a);
		s.upsert(b);
		await s.flush();
		const raw = await fs.read(sidecarPathFor(PDF));
		const s2 = new SidecarStore(fs, PDF, "fp", manualTimers());
		await s2.load();
		expect(s2.get(a.id)).toMatchObject({ body: a.body, target: a.target });
		expect(s2.get(b.id)).toMatchObject({ body: b.body, target: { kind: "point", x: 72.25, y: 512.5 } });
		expect(raw).toContain('"kind": "highlight"');
	});

	it("deleting a highlight with its notes is one undo step", async () => {
		const { s } = await store();
		const undo = new UndoStack(s);
		const h = hl(1, 500);
		const n = hlNote(h);
		undo.record("highlight", [h.id], () => s.upsert(h));
		undo.record("note", [n.id], () => s.upsert(n));
		const notes = notesForHighlights(s.all(), [h.id]);
		undo.record("delete", [h.id, ...notes.map((x) => x.id)], () => {
			s.remove(h.id);
			for (const x of notes) s.remove(x.id);
		});
		expect(s.all()).toHaveLength(0);
		undo.undo();
		expect(s.all().map((a) => a.id).sort()).toEqual([h.id, n.id].sort());
		undo.redo();
		expect(s.all()).toHaveLength(0);
	});

	it("edits merge by updatedAt across devices; a delete wins", async () => {
		const fs = new MemFs();
		const t = manualTimers();
		let clock = 10;
		const A = new SidecarStore(fs, PDF, "fp", { ...t, now: () => clock });
		await A.load();
		const n = pointNote(2, 10, 10, "v1", { createdAt: 1, updatedAt: 1 });
		A.upsert(n);
		await A.flush();
		// device B loads, edits later
		const B = new SidecarStore(fs, PDF, "fp", { ...manualTimers(), now: () => clock });
		await B.load();
		clock = 20;
		B.upsert({ ...(B.get(n.id) as NoteAnnotation), body: "v2 from B" });
		await B.flush();
		await A.checkExternal();
		expect((A.get(n.id) as NoteAnnotation).body).toBe("v2 from B");
		// A deletes; B (stale) edits again; the deletion survives the merge
		clock = 30;
		A.remove(n.id);
		await A.flush();
		clock = 40;
		B.upsert({ ...(B.get(n.id) as NoteAnnotation), body: "v3 from B" });
		await B.checkExternal();
		await B.flush();
		await A.checkExternal();
		expect(A.get(n.id)?.deleted).toBe(true);
		expect(B.get(n.id)?.deleted).toBe(true);
	});
});

describe("save hold", () => {
	it("postpones the debounced save while canSave() is false", async () => {
		const fs = new MemFs();
		let pending: (() => void) | null = null;
		let drawing = true;
		const s = new SidecarStore(fs, "hold/doc.pdf", "fp", {
			setTimeout: (fn) => ((pending = fn), 1),
			clearTimeout: () => (pending = null),
			canSave: () => !drawing,
		});
		await s.load();
		s.upsert(pointNote(1, 1, 1, "x"));
		const fire = async () => {
			const f = pending;
			pending = null;
			f?.();
			await s.flush().catch(() => undefined);
		};
		// timer fires while drawing: rescheduled, nothing written
		const f1 = pending as (() => void) | null;
		pending = null;
		f1?.();
		expect(await fs.exists(sidecarPathFor("hold/doc.pdf"))).toBe(false);
		expect(pending).not.toBeNull();
		drawing = false;
		await fire();
		expect(await fs.exists(sidecarPathFor("hold/doc.pdf"))).toBe(true);
	});
});
