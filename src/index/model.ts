// Vault-wide annotation index (0.8.0, Phase 8 groundwork, D-45). Pure — no Obsidian.
//
// Built from the sidecars (`<pdf>.pendf.json`) in the vault. Notebooks (Phase 8)
// refer to annotations only as `{ fp, id }` (PDF fingerprint + annotation id);
// this index resolves such a reference to the PDF's current path(s) and the
// annotation, so references survive renaming or moving the PDF.
//   (a) fingerprint → current PDF paths (several when a PDF was copied)
//   (b) annotation id → { fingerprint, type, page, colour, text preview, updatedAt }

import type { Annotation, AnnotationType, Sidecar } from "../store/schema";
import { ANNOTATION_TYPES, SIDECAR_SUFFIX } from "../store/schema";

export const PREVIEW_CHARS = 160;

export interface IndexedAnnotation {
	fp: string;
	id: string;
	type: AnnotationType;
	page: number;
	color?: string;
	/** start of the annotation's text (highlight / area text, note body, bookmark title, area label) */
	text: string;
	updatedAt: number;
}

export interface AnnotationRef {
	fp: string;
	id: string;
}

interface SidecarEntry {
	fp: string;
	pdfPath: string;
	/** sidecar file mtime when indexed (cache validation) */
	mtime: number;
	items: Map<string, IndexedAnnotation>;
}

export interface IndexCache {
	version: 1;
	sidecars: { path: string; fp: string; mtime: number; items: IndexedAnnotation[] }[];
}

export function pdfPathOf(sidecarPath: string): string {
	return sidecarPath.endsWith(SIDECAR_SUFFIX) ? sidecarPath.slice(0, -SIDECAR_SUFFIX.length) : sidecarPath;
}

export function isSidecarPath(path: string): boolean {
	return path.endsWith(".pdf" + SIDECAR_SUFFIX);
}

/** One-line, whitespace-normalized start of a text. */
export function preview(s: string, max = PREVIEW_CHARS): string {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

export function summarize(fp: string, a: Annotation): IndexedAnnotation {
	let text = "";
	let color: string | undefined;
	switch (a.type) {
		case "highlight":
			text = a.text;
			color = a.color;
			break;
		case "area":
			text = a.label ? `${a.label} — ${a.text}` : a.text;
			color = a.color;
			break;
		case "note":
			text = a.body;
			break;
		case "bookmark":
			text = a.title;
			break;
		case "ink":
			color = a.color;
			break;
	}
	return { fp, id: a.id, type: a.type, page: a.page, color, text: preview(text), updatedAt: a.updatedAt };
}

export interface SearchQuery {
	/** words that must all occur (case-insensitive) in the text or the PDF name */
	text?: string;
	types?: readonly AnnotationType[];
	/** "#rrggbb" values (case-insensitive) */
	colors?: readonly string[];
	limit?: number;
}

export interface SearchResult extends IndexedAnnotation {
	/** the PDF's current path(s) */
	paths: string[];
	/** the copy this version of the annotation comes from */
	path: string;
}

export class AnnotationIndex {
	private sidecars = new Map<string, SidecarEntry>();
	/** fingerprint → sidecar paths */
	private byFp = new Map<string, Set<string>>();
	/** annotation id → sidecar paths holding it (copies of a PDF share ids) */
	private byId = new Map<string, Set<string>>();

	get sidecarCount(): number {
		return this.sidecars.size;
	}

	get annotationCount(): number {
		let n = 0;
		for (const e of this.sidecars.values()) n += e.items.size;
		return n;
	}

	mtimeOf(sidecarPath: string): number | null {
		return this.sidecars.get(sidecarPath)?.mtime ?? null;
	}

	paths(): string[] {
		return [...this.sidecars.keys()];
	}

	/** (Re)index one sidecar. Tombstones are left out. */
	upsert(sidecarPath: string, sidecar: Pick<Sidecar, "pdfFingerprint" | "annotations">, mtime = 0): void {
		this.remove(sidecarPath);
		const fp = sidecar.pdfFingerprint;
		const items = new Map<string, IndexedAnnotation>();
		for (const a of sidecar.annotations) if (!a.deleted) items.set(a.id, summarize(fp, a));
		this.insert(sidecarPath, { fp, pdfPath: pdfPathOf(sidecarPath), mtime, items });
	}

	private insert(sidecarPath: string, e: SidecarEntry): void {
		this.sidecars.set(sidecarPath, e);
		add(this.byFp, e.fp, sidecarPath);
		for (const id of e.items.keys()) add(this.byId, id, sidecarPath);
	}

	remove(sidecarPath: string): void {
		const e = this.sidecars.get(sidecarPath);
		if (!e) return;
		this.sidecars.delete(sidecarPath);
		drop(this.byFp, e.fp, sidecarPath);
		for (const id of e.items.keys()) drop(this.byId, id, sidecarPath);
	}

	rename(oldSidecarPath: string, newSidecarPath: string): void {
		const e = this.sidecars.get(oldSidecarPath);
		if (!e) return;
		this.remove(oldSidecarPath);
		this.insert(newSidecarPath, { ...e, pdfPath: pdfPathOf(newSidecarPath) });
	}

	/** Current PDF paths with this fingerprint (copies included), sorted. */
	pdfPaths(fp: string): string[] {
		return [...(this.byFp.get(fp) ?? [])].map((s) => this.sidecars.get(s)?.pdfPath ?? pdfPathOf(s)).sort();
	}

	/** `{ fp, id }` → the PDF's current path(s) and the annotation (the most recently updated copy). */
	resolve(ref: AnnotationRef): SearchResult | null {
		let best: IndexedAnnotation | null = null;
		let bestPath = "";
		for (const sp of [...(this.byId.get(ref.id) ?? [])].sort()) {
			const e = this.sidecars.get(sp);
			const a = e?.items.get(ref.id);
			if (!e || !a || e.fp !== ref.fp) continue;
			if (!best || a.updatedAt > best.updatedAt) {
				best = a;
				bestPath = e.pdfPath;
			}
		}
		return best ? { ...best, paths: this.pdfPaths(ref.fp), path: bestPath } : null;
	}

	/** Search every indexed annotation; newest first. */
	search(q: SearchQuery): SearchResult[] {
		const words = (q.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
		const types = q.types?.length ? new Set(q.types) : null;
		const colors = q.colors?.length ? new Set(q.colors.map((c) => c.toLowerCase())) : null;
		const limit = q.limit ?? 200;
		const seen = new Set<string>();
		const out: SearchResult[] = [];
		for (const e of this.sidecars.values()) {
			const name = e.pdfPath.toLowerCase();
			for (const a of e.items.values()) {
				if (types && !types.has(a.type)) continue;
				if (colors && !(a.color && colors.has(a.color.toLowerCase()))) continue;
				if (words.length) {
					const hay = a.text.toLowerCase() + " " + name;
					if (!words.every((w) => hay.includes(w))) continue;
				}
				const key = a.fp + "\u0000" + a.id;
				if (seen.has(key)) continue;
				seen.add(key);
				out.push({ ...a, paths: this.pdfPaths(a.fp), path: e.pdfPath });
			}
		}
		out.sort((x, y) => y.updatedAt - x.updatedAt);
		return out.slice(0, limit);
	}

	toCache(): IndexCache {
		return { version: 1, sidecars: [...this.sidecars.entries()].map(([path, e]) => ({ path, fp: e.fp, mtime: e.mtime, items: [...e.items.values()] })) };
	}

	static fromCache(c: unknown): AnnotationIndex {
		const idx = new AnnotationIndex();
		const cache = c as Partial<IndexCache> | null;
		if (!cache || cache.version !== 1 || !Array.isArray(cache.sidecars)) return idx;
		for (const s of cache.sidecars) {
			if (!s || typeof s.path !== "string" || typeof s.fp !== "string" || !Array.isArray(s.items)) continue;
			idx.insert(s.path, { fp: s.fp, pdfPath: pdfPathOf(s.path), mtime: typeof s.mtime === "number" ? s.mtime : 0, items: new Map(s.items.map((a) => [a.id, a])) });
		}
		return idx;
	}
}

function add(m: Map<string, Set<string>>, k: string, v: string): void {
	const s = m.get(k);
	if (s) s.add(v);
	else m.set(k, new Set([v]));
}

function drop(m: Map<string, Set<string>>, k: string, v: string): void {
	const s = m.get(k);
	if (!s) return;
	s.delete(v);
	if (!s.size) m.delete(k);
}

/** Query of "Search annotations in vault": words, `type:<kind>` (repeatable), `color:<name | #hex>`. */
export function parseIndexQuery(input: string, colors: readonly { name: string; hex: string }[]): SearchQuery {
	const words: string[] = [];
	const types: AnnotationType[] = [];
	const hexes: string[] = [];
	for (const tok of input.split(/\s+/).filter(Boolean)) {
		const m = /^(type|color|colour):(.+)$/i.exec(tok);
		if (!m) {
			words.push(tok);
			continue;
		}
		const v = m[2].toLowerCase();
		if (m[1].toLowerCase() === "type") {
			const t = ANNOTATION_TYPES.find((x) => x === v || x + "s" === v);
			if (t) types.push(t);
		} else {
			const named = colors.find((c) => c.name.toLowerCase() === v);
			if (named) hexes.push(named.hex);
			else if (/^#?[0-9a-f]{6}$/.test(v)) hexes.push(v.startsWith("#") ? v : `#${v}`);
		}
	}
	return { text: words.join(" "), types, colors: hexes, limit: 100 };
}
