import { describe, expect, it } from "vitest";
import { SidecarStore, moveSidecar } from "../src/store/sidecar";
import { type Annotation, type HighlightAnnotation, SCHEMA_VERSION, parseSidecar, serializeSidecar, sidecarPathFor, uuid, validateAnnotation } from "../src/store/schema";
import { MIGRATIONS, NewerSchemaError, migrate } from "../src/store/migrate";
import { UndoStack } from "../src/store/undo";
import { MemFs, manualTimers } from "./memfs";
import type { Quad } from "../src/geometry";

const PDF = "Papers/paper.pdf";
const SIDE = sidecarPathFor(PDF);
const FP = "abc123";

function hl(page: number, quads: Quad[], extra: Partial<HighlightAnnotation> = {}): HighlightAnnotation {
	return { id: uuid(), type: "highlight", page, createdAt: 1, updatedAt: 1, deleted: false, quads, color: "#ffd400", text: "t", ...extra };
}

function rnd(seed: number) {
	let s = seed;
	return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
}

function randomAnnotation(r: () => number, i: number): Annotation {
	const page = 1 + Math.floor(r() * 300);
	const id = `id-${i}`;
	const base = { id, page, createdAt: 1000 + i, updatedAt: 2000 + i, deleted: false };
	switch (i % 4) {
		case 0:
			return { ...base, type: "highlight", color: "#2ea8e5", text: `텍스트 ${i} "quoted" \\ back`, quads: [Array.from({ length: 8 }, () => r() * 842 - 50) as Quad], groupId: i % 8 === 0 ? "g" : undefined } as HighlightAnnotation;
		case 1:
			return { ...base, type: "note", body: `# note ${i}\n\n- **md** ✓`, target: i % 3 ? { kind: "point", x: r() * 600, y: r() * 800 } : { kind: "highlight", highlightId: `id-${i - 1}` } };
		case 2:
			return { ...base, type: "bookmark", y: r() * 842, title: `Bookmark ${i}`, order: i + r() };
		default:
			return { ...base, type: "ink", tool: i % 2 ? "pen" : "highlighter", color: "#000000", width: 0.5 + r() * 4, points: Array.from({ length: 20 }, () => r() * 700) };
	}
}

async function freshStore(fs: MemFs, timers = manualTimers(), fp = FP) {
	const s = new SidecarStore(fs, PDF, fp, { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
	await s.load();
	return s;
}

describe("sidecar store", () => {
	it("save → reload 1,000 annotations: coordinates within 0.5 pt, all properties kept", async () => {
		const fs = new MemFs();
		const s = await freshStore(fs);
		const r = rnd(42);
		const made: Annotation[] = [];
		for (let i = 0; i < 1000; i++) made.push(s.upsert(randomAnnotation(r, i)));
		await s.flush();
		const s2 = await freshStore(fs);
		expect(s2.status).toBe("ok");
		const back = new Map(s2.all().map((a) => [a.id, a]));
		expect(back.size).toBe(1000);
		for (const a of made) {
			const b = back.get(a.id)!;
			expect(b).toBeDefined();
			if (a.type === "highlight" && b.type === "highlight") {
				for (let k = 0; k < 8; k++) expect(Math.abs(a.quads[0][k] - b.quads[0][k])).toBeLessThan(0.5);
			}
			if (a.type === "ink" && b.type === "ink") a.points.forEach((p, k) => expect(Math.abs(p - b.points[k])).toBeLessThan(0.5));
			expect(b).toEqual(JSON.parse(JSON.stringify(a)));
		}
	});

	it("debounces writes and writes nothing when unchanged", async () => {
		const fs = new MemFs();
		const t = manualTimers();
		const s = await freshStore(fs, t);
		s.upsert(hl(1, []));
		s.upsert(hl(2, []));
		expect(fs.writes).toBe(0);
		expect(t.size).toBe(1);
		await t.runAll();
		await s.flush();
		expect(fs.writes).toBe(1);
		await s.flush();
		expect(fs.writes).toBe(1);
	});

	it("writes via tmp + rename; falls back when rename cannot overwrite", async () => {
		const fs = new MemFs();
		fs.renameOverwrite = false;
		const s = await freshStore(fs);
		s.upsert(hl(1, []));
		await s.flush();
		s.upsert(hl(2, []));
		await s.flush();
		expect(fs.files.has(SIDE)).toBe(true);
		expect(fs.files.has(SIDE + ".tmp")).toBe(false);
		expect((await freshStore(fs)).all()).toHaveLength(2);
	});

	it("recovers an interrupted save from the .tmp file", async () => {
		const fs = new MemFs();
		const sc = { schemaVersion: 1, pdfFingerprint: FP, annotations: [hl(3, [])] };
		fs.externalWrite(SIDE + ".tmp", serializeSidecar(sc));
		const s = await freshStore(fs);
		expect(s.all()).toHaveLength(1);
	});

	it("keeps unsaved changes dirty when a write fails", async () => {
		const fs = new MemFs();
		const s = await freshStore(fs);
		s.upsert(hl(1, []));
		fs.failNextWrite = true;
		await expect(s.flush()).rejects.toThrow("disk full");
		expect(s.isDirty).toBe(true);
		await s.flush();
		expect((await freshStore(fs)).all()).toHaveLength(1);
	});

	it("fingerprint mismatch: annotations hidden, store read-only, file untouched", async () => {
		const fs = new MemFs();
		const other = serializeSidecar({ schemaVersion: 1, pdfFingerprint: "different", annotations: [hl(1, [])] });
		fs.externalWrite(SIDE, other);
		const s = await freshStore(fs);
		expect(s.status).toBe("fingerprint-mismatch");
		expect(s.all()).toHaveLength(0);
		expect(s.writable).toBe(false);
		expect(() => s.upsert(hl(1, []))).toThrow();
		await s.flush();
		expect(fs.files.get(SIDE)!.data).toBe(other);
	});

	it("newer schema: read-only, never overwritten", async () => {
		const fs = new MemFs();
		const raw = JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, pdfFingerprint: FP, annotations: [] });
		fs.externalWrite(SIDE, raw);
		const s = await freshStore(fs);
		expect(s.status).toBe("newer-schema");
		expect(s.writable).toBe(false);
		expect(fs.files.get(SIDE)!.data).toBe(raw);
	});

	it("invalid entries are preserved verbatim in `unknown`", async () => {
		const fs = new MemFs();
		const weird = { id: "x", type: "sticker", page: 1, createdAt: 1, updatedAt: 1, deleted: false, emoji: "🦆" };
		fs.externalWrite(SIDE, JSON.stringify({ schemaVersion: 1, pdfFingerprint: FP, annotations: [weird, hl(1, [])] }));
		const s = await freshStore(fs);
		expect(s.all()).toHaveLength(1);
		s.upsert(hl(2, []));
		await s.flush();
		const saved = JSON.parse(fs.files.get(SIDE)!.data);
		expect(saved.unknown).toEqual([weird]);
		expect(saved.annotations).toHaveLength(2);
	});

	it("merges an external change before saving instead of clobbering it", async () => {
		const fs = new MemFs();
		const t = manualTimers();
		const s = await freshStore(fs, t);
		const mine = s.upsert(hl(1, []));
		await s.flush();
		// another device adds one and edits nothing else
		const theirs = hl(5, [], { updatedAt: 10_000_000_000_000 });
		const disk = JSON.parse(fs.files.get(SIDE)!.data);
		disk.annotations.push(theirs);
		fs.externalWrite(SIDE, JSON.stringify(disk));
		s.upsert({ ...mine, color: "#000000" });
		await s.flush();
		const ids = JSON.parse(fs.files.get(SIDE)!.data).annotations.map((a: Annotation) => a.id).sort();
		expect(ids).toEqual([mine.id, theirs.id].sort());
	});

	it("checkExternal pulls in changes and reports them", async () => {
		const fs = new MemFs();
		const changes: string[] = [];
		const s = new SidecarStore(fs, PDF, FP, { onChange: (src) => changes.push(src) });
		await s.load();
		expect(await s.checkExternal()).toBe(false);
		fs.externalWrite(SIDE, serializeSidecar({ schemaVersion: 1, pdfFingerprint: FP, annotations: [hl(9, [])] }));
		expect(await s.checkExternal()).toBe(true);
		expect(s.all()).toHaveLength(1);
		expect(changes).toContain("external");
	});

	it("dedupes repeated ids in a file on load", async () => {
		const fs = new MemFs();
		const a = hl(1, [], { id: "same", updatedAt: 5, color: "#111111" });
		const b = { ...a, updatedAt: 9, color: "#222222" };
		fs.externalWrite(SIDE, JSON.stringify({ schemaVersion: 1, pdfFingerprint: FP, annotations: [a, b] }));
		const s = await freshStore(fs);
		expect(s.all()).toHaveLength(1);
		expect((s.all()[0] as HighlightAnnotation).color).toBe("#222222");
	});

	it("moveSidecar follows renames and never overwrites", async () => {
		const fs = new MemFs();
		fs.externalWrite(SIDE, "{}");
		expect(await moveSidecar(fs, PDF, "New/name.pdf")).toBe("moved");
		expect(fs.files.has("New/name.pdf.ppp.json")).toBe(true);
		expect(await moveSidecar(fs, PDF, "x.pdf")).toBe("none");
		fs.externalWrite("a.pdf.ppp.json", "{}");
		fs.externalWrite("b.pdf.ppp.json", "{}");
		expect(await moveSidecar(fs, "a.pdf", "b.pdf")).toBe("target-exists");
	});
});

describe("schema", () => {
	it("validates each annotation kind", () => {
		expect(validateAnnotation(hl(1, [[0, 0, 1, 0, 0, 1, 1, 1]]))).toBeNull();
		expect(validateAnnotation({ ...hl(1, []), page: 0 })).toBe("page");
		expect(validateAnnotation({ ...hl(1, []), quads: [[1, 2, 3]] })).toBe("quads");
		expect(validateAnnotation({ id: "n", type: "note", page: 1, createdAt: 0, updatedAt: 0, deleted: false, body: "x", target: { kind: "point", x: 1, y: 2 } })).toBeNull();
		expect(validateAnnotation({ id: "n", type: "note", page: 1, createdAt: 0, updatedAt: 0, deleted: false, body: "x", target: { kind: "nope" } })).toBe("target.kind");
		expect(validateAnnotation({ id: "b", type: "bookmark", page: 1, createdAt: 0, updatedAt: 0, deleted: false, y: 1, title: "t", order: 0 })).toBeNull();
		expect(validateAnnotation({ id: "i", type: "ink", page: 1, createdAt: 0, updatedAt: 0, deleted: false, tool: "pen", color: "#000", width: 1, points: [1, 2, 3] })).toBe("points");
		expect(validateAnnotation({ id: "i", type: "ink", page: 1, createdAt: 0, updatedAt: 0, deleted: false, tool: "brush", color: "#000", width: 1, points: [] })).toBe("tool");
	});

	it("parseSidecar rejects non-objects and missing fingerprints", () => {
		expect(() => parseSidecar([])).toThrow();
		expect(() => parseSidecar({ schemaVersion: 1, annotations: [] })).toThrow();
	});
});

describe("migrations", () => {
	it("versionless files are treated as v1", () => {
		expect(migrate({ pdfFingerprint: "x", annotations: [] }).schemaVersion).toBe(1);
	});
	it("newer files raise NewerSchemaError", () => {
		expect(() => migrate({ schemaVersion: 99 })).toThrow(NewerSchemaError);
	});
	it("runs steps in order up to the target", () => {
		const steps = {
			1: (r: Record<string, unknown>) => ({ ...r, schemaVersion: 2, a: true }),
			2: (r: Record<string, unknown>) => ({ ...r, schemaVersion: 3, b: true }),
		};
		const out = migrate({ schemaVersion: 1 }, steps, 3);
		expect(out).toMatchObject({ schemaVersion: 3, a: true, b: true });
	});
	it("fails on a gap or a step that forgets to bump the version", () => {
		expect(() => migrate({ schemaVersion: 1 }, {}, 2)).toThrow(/no migration/);
		expect(() => migrate({ schemaVersion: 1 }, { 1: (r) => r }, 2)).toThrow(/produced/);
	});
	it("has no real migrations yet (v1 is the first version)", () => {
		expect(Object.keys(MIGRATIONS)).toHaveLength(0);
		expect(SCHEMA_VERSION).toBe(1);
	});
});

describe("undo / redo", () => {
	it("undo of a create tombstones it, redo brings it back, both win merges", async () => {
		const fs = new MemFs();
		let now = 100;
		const s = new SidecarStore(fs, PDF, FP, { now: () => now });
		await s.load();
		const u = new UndoStack(s);
		const a = hl(1, []);
		u.record("create", [a.id], () => s.upsert(a));
		now = 200;
		u.undo();
		expect(s.all()).toHaveLength(0);
		expect(s.get(a.id)!.deleted).toBe(true);
		now = 300;
		u.redo();
		expect(s.all()).toHaveLength(1);
		expect(s.get(a.id)!.updatedAt).toBeGreaterThanOrEqual(300);
	});

	it("undo of a recolor restores the old color", async () => {
		const fs = new MemFs();
		const s = new SidecarStore(fs, PDF, FP);
		await s.load();
		const u = new UndoStack(s);
		const a = s.upsert(hl(1, []));
		u.record("recolor", [a.id], () => s.upsert({ ...a, color: "#000000" }));
		expect((s.get(a.id) as HighlightAnnotation).color).toBe("#000000");
		u.undo();
		expect((s.get(a.id) as HighlightAnnotation).color).toBe("#ffd400");
		expect(u.canRedo).toBe(true);
		u.record("other", [a.id], () => s.remove(a.id));
		expect(u.canRedo).toBe(false);
	});
});
