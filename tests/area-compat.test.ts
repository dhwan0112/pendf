// Area excerpts and generic note targets (0.8.0) against the 0.7.3 parser (frozen copy in
// tests/compat/v073): an older penDF that reads and saves a newer sidecar must not lose them.
import { describe, expect, it } from "vitest";
import { parseSidecar, serializeSidecar, validateAnnotation, type Annotation, type AreaAnnotation, type HighlightAnnotation, type NoteAnnotation, type Sidecar } from "../src/store/schema";
import { migrate } from "../src/store/migrate";
import * as v073 from "./compat/v073/schema";
import { migrate as migrate073 } from "./compat/v073/migrate";
import { mergeSidecars as merge073 } from "./compat/v073/merge";
import { noteAnchor, notesForHighlights, panelPages, targetFor } from "../src/notes/model";

const base = { createdAt: 1, updatedAt: 1, deleted: false };
const area: AreaAnnotation = { ...base, id: "a1", type: "area", page: 2, quad: [100, 600, 250, 600, 100, 500, 250, 500], color: "#2ea8e5", text: "Figure 3", label: "fig" };
const hl: HighlightAnnotation = { ...base, id: "h1", type: "highlight", page: 1, quads: [[72, 700, 300, 700, 72, 688, 300, 688]], color: "#ffd400", text: "quoted" };
const areaNote: NoteAnnotation = { ...base, id: "n1", type: "note", page: 2, body: "about the figure", target: { kind: "annotation", id: "a1" } };
const hlNote: NoteAnnotation = { ...base, id: "n2", type: "note", page: 1, body: "on the quote", target: { kind: "highlight", highlightId: "h1" } };
const hlNoteNew: NoteAnnotation = { ...base, id: "n3", type: "note", page: 1, body: "new form", target: { kind: "annotation", id: "h1" } };
const all: Annotation[] = [hl, hlNote, area, areaNote, hlNoteNew];
const newer: Sidecar = { schemaVersion: 1, pdfFingerprint: "fp", annotations: all };

const byId = (list: Annotation[]) => Object.fromEntries(list.map((a) => [a.id, a]));

describe("0.7.3 reads and saves a 0.8.0 sidecar", () => {
	it("keeps what it does not know in `unknown` and writes it back verbatim", () => {
		const old = v073.parseSidecar(migrate073(JSON.parse(serializeSidecar(newer))));
		expect(old.sidecar.annotations.map((a) => a.id).sort()).toEqual(["h1", "n2"]);
		expect((old.sidecar.unknown ?? []).map((u) => (u as { id: string }).id).sort()).toEqual(["a1", "n1", "n3"]);
		// 0.7.3 saves; 0.8.0 reads it again: nothing lost, nothing left in unknown
		const back = parseSidecar(migrate(JSON.parse(v073.serializeSidecar(old.sidecar))));
		expect(back.problems).toEqual([]);
		expect(back.sidecar.unknown).toBeUndefined();
		expect(byId(back.sidecar.annotations)).toEqual(byId(all));
	});
	it("survives a 0.7.3 sync merge too", () => {
		const a = v073.parseSidecar(migrate073(JSON.parse(serializeSidecar(newer)))).sidecar;
		const b = v073.parseSidecar(migrate073(JSON.parse(serializeSidecar({ ...newer, annotations: [hl] })))).sidecar;
		const merged = merge073(a, b);
		const back = parseSidecar(migrate(JSON.parse(v073.serializeSidecar(merged))));
		expect(byId(back.sidecar.annotations)).toEqual(byId(all));
	});
	it("an area edited in 0.8.0 after a 0.7.3 round trip: the usual merge rules decide", () => {
		const stale = { ...area, color: "#ff0000", updatedAt: 1 };
		const edited = { ...area, color: "#00ff00", updatedAt: 5 };
		const raw = JSON.parse(serializeSidecar({ schemaVersion: 1, pdfFingerprint: "fp", annotations: [edited] }));
		raw.unknown = [stale];
		const back = parseSidecar(raw);
		expect(back.sidecar.annotations).toEqual([edited]);
		const deleted = { ...area, deleted: true, updatedAt: 0 };
		raw.unknown = [deleted];
		expect(parseSidecar(raw).sidecar.annotations[0].deleted).toBe(true);
	});
	it("keeps entries no version knows in unknown", () => {
		const raw = JSON.parse(serializeSidecar(newer));
		raw.annotations.push({ ...base, id: "x", type: "sticker", page: 1 });
		const r = parseSidecar(raw);
		expect(r.sidecar.unknown).toEqual([{ ...base, id: "x", type: "sticker", page: 1 }]);
	});
});

describe("area schema", () => {
	it("validates areas", () => {
		expect(validateAnnotation(area)).toBeNull();
		expect(validateAnnotation({ ...area, label: undefined })).toBeNull();
		expect(validateAnnotation({ ...area, quad: [1, 2, 3] })).toBe("quad");
		expect(validateAnnotation({ ...area, text: 3 })).toBe("text");
		expect(validateAnnotation({ ...area, label: 5 })).toBe("label");
		expect(validateAnnotation({ ...areaNote, target: { kind: "annotation", id: "" } })).toBe("target.id");
	});
	it("serializes the quad on one line", () => {
		expect(serializeSidecar({ schemaVersion: 1, pdfFingerprint: "fp", annotations: [area] })).toContain('"quad": [100,600,250,600,100,500,250,500]');
	});
});

describe("generic note targets", () => {
	const get = (id: string) => all.find((a) => a.id === id);
	it("anchors notes on areas and on highlights in both forms", () => {
		expect(noteAnchor(areaNote, get)).toEqual([250, 600]);
		expect(noteAnchor(hlNote, get)).toEqual([300, 700]);
		expect(noteAnchor(hlNoteNew, get)).toEqual([300, 700]);
	});
	it("finds notes for a deleted highlight or area in both forms (cascade delete)", () => {
		expect(notesForHighlights(all, ["h1"]).map((n) => n.id).sort()).toEqual(["n2", "n3"]);
		expect(notesForHighlights(all, ["a1"]).map((n) => n.id)).toEqual(["n1"]);
	});
	it("writes the old form for highlights, the new one for everything else", () => {
		expect(targetFor(hl)).toEqual({ kind: "highlight", highlightId: "h1" });
		expect(targetFor(area)).toEqual({ kind: "annotation", id: "a1" });
	});
	it("the panel shows the area with its note", () => {
		const pages = panelPages([area, areaNote]);
		expect(pages).toHaveLength(1);
		expect(pages[0].items).toEqual([{ annotation: area, note: areaNote }]);
	});
});
