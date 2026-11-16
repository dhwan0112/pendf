import { describe, expect, it } from "vitest";
import { AnnotationIndex, isSidecarPath, parseIndexQuery, pdfPathOf, preview, summarize } from "../src/index/model";
import { parseSidecar, serializeSidecar, type Annotation, type Sidecar } from "../src/store/schema";

const base = { createdAt: 1, deleted: false };
const hl = (id: string, page: number, text: string, color = "#ffd400", updatedAt = 1): Annotation => ({ ...base, id, type: "highlight", page, updatedAt, quads: [[0, 10, 10, 10, 0, 0, 10, 0]], color, text });
const note = (id: string, body: string): Annotation => ({ ...base, id, type: "note", page: 2, updatedAt: 2, body, target: { kind: "point", x: 1, y: 2 } });
const sc = (fp: string, annotations: Annotation[]): Sidecar => ({ schemaVersion: 1, pdfFingerprint: fp, annotations });

describe("annotation index", () => {
	it("maps fingerprints to PDF paths and ids to summaries", () => {
		const idx = new AnnotationIndex();
		idx.upsert("Papers/a.pdf.pendf.json", sc("fpA", [hl("h1", 3, "Quantum   tunnelling\\nis fun"), note("n1", "check **this**")]));
		expect(idx.pdfPaths("fpA")).toEqual(["Papers/a.pdf"]);
		expect(idx.resolve({ fp: "fpA", id: "h1" })).toMatchObject({ type: "highlight", page: 3, color: "#ffd400", paths: ["Papers/a.pdf"] });
		expect(idx.resolve({ fp: "fpB", id: "h1" })).toBeNull();
		expect(idx.annotationCount).toBe(2);
	});
	it("leaves tombstones out", () => {
		const idx = new AnnotationIndex();
		idx.upsert("a.pdf.pendf.json", sc("fp", [{ ...hl("h1", 1, "x"), deleted: true }]));
		expect(idx.resolve({ fp: "fp", id: "h1" })).toBeNull();
	});
	it("updates incrementally: modify, rename, delete", () => {
		const idx = new AnnotationIndex();
		idx.upsert("a.pdf.pendf.json", sc("fp", [hl("h1", 1, "old")]));
		idx.upsert("a.pdf.pendf.json", sc("fp", [hl("h1", 1, "new", "#2ea8e5", 5), hl("h2", 4, "more")]));
		expect(idx.resolve({ fp: "fp", id: "h1" })?.text).toBe("new");
		expect(idx.annotationCount).toBe(2);
		// the PDF is moved: references by { fp, id } still resolve, to the new path
		idx.rename("a.pdf.pendf.json", "Archive/b.pdf.pendf.json");
		expect(idx.resolve({ fp: "fp", id: "h2" })?.paths).toEqual(["Archive/b.pdf"]);
		idx.remove("Archive/b.pdf.pendf.json");
		expect(idx.resolve({ fp: "fp", id: "h2" })).toBeNull();
		expect(idx.sidecarCount).toBe(0);
	});
	it("knows copies of a PDF (same fingerprint) and picks the newest copy of an annotation", () => {
		const idx = new AnnotationIndex();
		idx.upsert("a.pdf.pendf.json", sc("fp", [hl("h1", 1, "first", "#ffd400", 1)]));
		idx.upsert("copy/a.pdf.pendf.json", sc("fp", [hl("h1", 1, "edited in the copy", "#ffd400", 9)]));
		const r = idx.resolve({ fp: "fp", id: "h1" });
		expect(r?.paths).toEqual(["a.pdf", "copy/a.pdf"]);
		expect(r?.text).toBe("edited in the copy");
		expect(r?.path).toBe("copy/a.pdf");
		expect(idx.search({ text: "first" })).toHaveLength(1);
		expect(idx.search({})).toHaveLength(1); // one per { fp, id }
	});
	it("searches by text, type and colour", () => {
		const idx = new AnnotationIndex();
		idx.upsert("Physics/qm.pdf.pendf.json", sc("fp1", [hl("h1", 1, "wave function collapse", "#ffd400", 3), hl("h2", 2, "entanglement", "#2ea8e5", 4), note("n1", "wave note")]));
		idx.upsert("Bio/cell.pdf.pendf.json", sc("fp2", [hl("h3", 7, "mitochondria", "#ffd400", 5)]));
		expect(idx.search({ text: "wave" }).map((r) => r.id)).toEqual(["h1", "n1"]); // newest first
		expect(idx.search({ types: ["note"] }).map((r) => r.id)).toEqual(["n1"]);
		expect(idx.search({ colors: ["#FFD400"] }).map((r) => r.id)).toEqual(["h3", "h1"]);
		expect(idx.search({ text: "physics wave", types: ["highlight"] }).map((r) => r.id)).toEqual(["h1"]);
		expect(idx.search({ limit: 1 })).toHaveLength(1);
	});
	it("round-trips through its cache", () => {
		const idx = new AnnotationIndex();
		idx.upsert("a.pdf.pendf.json", sc("fp", [hl("h1", 1, "x")]), 1234);
		const back = AnnotationIndex.fromCache(JSON.parse(JSON.stringify(idx.toCache())));
		expect(back.resolve({ fp: "fp", id: "h1" })).toEqual(idx.resolve({ fp: "fp", id: "h1" }));
		expect(back.mtimeOf("a.pdf.pendf.json")).toBe(1234);
		expect(AnnotationIndex.fromCache({ version: 9 }).sidecarCount).toBe(0);
	});
	it("helpers", () => {
		expect(pdfPathOf("x/y.pdf.pendf.json")).toBe("x/y.pdf");
		expect(isSidecarPath("x/y.pdf.pendf.json")).toBe(true);
		expect(isSidecarPath("x/y.md")).toBe(false);
		expect(preview("a  b\n c", 4)).toBe("a b…");
		expect(summarize("fp", { ...base, id: "a1", type: "area", page: 1, updatedAt: 1, quad: [0, 0, 0, 0, 0, 0, 0, 0], color: "#000000", text: "Fig", label: "L" }).text).toBe("L — Fig");
	});
});

describe("index performance (500 sidecars, 50,000 annotations)", () => {
	it("builds, updates and renames fast enough", () => {
		const texts: string[] = [];
		for (let f = 0; f < 500; f++) {
			const list: Annotation[] = [];
			for (let i = 0; i < 100; i++) list.push(hl(`id-${f}-${i}`, (i % 40) + 1, `sentence ${f} ${i} about some topic number ${i % 17}`, i % 2 ? "#ffd400" : "#2ea8e5", f * 100 + i));
			texts.push(serializeSidecar(sc(`fp-${f}`, list)));
		}
		const heap0 = process.memoryUsage().heapUsed;
		const t0 = performance.now();
		const idx = new AnnotationIndex();
		let slowest = 0;
		for (let f = 0; f < 500; f++) {
			const a = performance.now();
			idx.upsert(`dir${f % 20}/doc${f}.pdf.pendf.json`, parseSidecar(JSON.parse(texts[f])).sidecar, f);
			slowest = Math.max(slowest, performance.now() - a);
		}
		const buildMs = performance.now() - t0;
		const heapMB = (process.memoryUsage().heapUsed - heap0) / 1048576;
		const u0 = performance.now();
		idx.upsert("dir3/doc3.pdf.pendf.json", parseSidecar(JSON.parse(texts[3])).sidecar, 999);
		const updateMs = performance.now() - u0;
		const r0 = performance.now();
		idx.rename("dir3/doc3.pdf.pendf.json", "moved/doc3.pdf.pendf.json");
		const renameMs = performance.now() - r0;
		const s0 = performance.now();
		const hits = idx.search({ text: "topic number 5", colors: ["#ffd400"] });
		const searchMs = performance.now() - s0;
		console.log(JSON.stringify({ sidecars: idx.sidecarCount, annotations: idx.annotationCount, buildMs: Math.round(buildMs), slowestSidecarMs: +slowest.toFixed(1), heapMB: +heapMB.toFixed(1), updateMs: +updateMs.toFixed(2), renameMs: +renameMs.toFixed(2), searchMs: +searchMs.toFixed(1), hits: hits.length }));
		expect(idx.annotationCount).toBe(50_000);
		expect(idx.resolve({ fp: "fp-3", id: "id-3-7" })?.paths).toEqual(["moved/doc3.pdf"]);
		expect(updateMs).toBeLessThan(50);
		expect(renameMs).toBeLessThan(50);
		expect(buildMs).toBeLessThan(15_000);
	});
});

describe("vault search query", () => {
	const colors = [{ name: "Yellow", hex: "#ffd400" }, { name: "Blue", hex: "#2ea8e5" }];
	it("splits words, type: and color: filters", () => {
		expect(parseIndexQuery("wave type:highlight color:yellow function", colors)).toEqual({ text: "wave function", types: ["highlight"], colors: ["#ffd400"], limit: 100 });
		expect(parseIndexQuery("type:notes type:area colour:#2EA8E5", colors)).toEqual({ text: "", types: ["note", "area"], colors: ["#2ea8e5"], limit: 100 });
		expect(parseIndexQuery("type:unknown color:mauve x", colors)).toEqual({ text: "x", types: [], colors: [], limit: 100 });
	});
});
