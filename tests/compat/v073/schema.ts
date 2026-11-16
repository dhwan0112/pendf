// Sidecar schema v1 — the public, documented data format (docs/SCHEMA.md).
// All four annotation kinds are defined now so Phases 3–6 need no migration.

import type { Quad } from "../../../src/geometry";

export const SCHEMA_VERSION = 1;
export const SIDECAR_SUFFIX = ".pendf.json";

export interface AnnotationBase {
	/** UUID v4 */
	id: string;
	/** 1-based page number */
	page: number;
	/** ms since epoch */
	createdAt: number;
	/** ms since epoch; last-writer-wins key for merging */
	updatedAt: number;
	/** tombstone; deleted annotations are kept so deletions sync */
	deleted: boolean;
}

export interface HighlightAnnotation extends AnnotationBase {
	type: "highlight";
	/** PDF user-space quads, Acrobat QuadPoints order (UL, UR, LL, LR) */
	quads: Quad[];
	/** CSS color, "#rrggbb" */
	color: string;
	/** selected text (whitespace-normalized) */
	text: string;
	/** shared by the per-page pieces of a selection that spans pages */
	groupId?: string;
}

export type NoteTarget = { kind: "highlight"; highlightId: string } | { kind: "point"; x: number; y: number };

export interface NoteAnnotation extends AnnotationBase {
	type: "note";
	/** Markdown */
	body: string;
	target: NoteTarget;
}

export interface BookmarkAnnotation extends AnnotationBase {
	type: "bookmark";
	/** PDF user-space y of the bookmarked position (top of view) */
	y: number;
	title: string;
	/** sort key among bookmarks (fractional indexing allowed) */
	order: number;
}

export interface InkAnnotation extends AnnotationBase {
	type: "ink";
	tool: "pen" | "highlighter";
	color: string;
	/** stroke width in PDF points */
	width: number;
	/** flattened PDF user-space points [x0, y0, x1, y1, ...] of one stroke */
	points: number[];
}

export type Annotation = HighlightAnnotation | NoteAnnotation | BookmarkAnnotation | InkAnnotation;
export type AnnotationType = Annotation["type"];
export const ANNOTATION_TYPES: readonly AnnotationType[] = ["highlight", "note", "bookmark", "ink"];

export interface Sidecar {
	schemaVersion: number;
	/** pdf.js `fingerprints[0]` of the PDF the annotations belong to */
	pdfFingerprint: string;
	annotations: Annotation[];
	/**
	 * Entries this version could not validate (unknown type from a newer
	 * plugin, hand-edited JSON…). Never dropped: written back verbatim.
	 */
	unknown?: unknown[];
}

export function emptySidecar(fingerprint: string): Sidecar {
	return { schemaVersion: SCHEMA_VERSION, pdfFingerprint: fingerprint, annotations: [] };
}

export function sidecarPathFor(pdfPath: string): string {
	return pdfPath + SIDECAR_SUFFIX;
}

// ---------------------------------------------------------------------------
// Validation

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";

export function validateAnnotation(v: unknown): string | null {
	if (!isObj(v)) return "not an object";
	if (!isStr(v.id) || v.id.length === 0) return "id";
	if (!isNum(v.page) || !Number.isInteger(v.page) || v.page < 1) return "page";
	if (!isNum(v.createdAt)) return "createdAt";
	if (!isNum(v.updatedAt)) return "updatedAt";
	if (typeof v.deleted !== "boolean") return "deleted";
	switch (v.type) {
		case "highlight":
			if (!Array.isArray(v.quads) || !v.quads.every((q) => Array.isArray(q) && q.length === 8 && q.every(isNum))) return "quads";
			if (!isStr(v.color)) return "color";
			if (!isStr(v.text)) return "text";
			if (v.groupId !== undefined && !isStr(v.groupId)) return "groupId";
			return null;
		case "note": {
			if (!isStr(v.body)) return "body";
			const t = v.target;
			if (!isObj(t)) return "target";
			if (t.kind === "highlight") return isStr(t.highlightId) ? null : "target.highlightId";
			if (t.kind === "point") return isNum(t.x) && isNum(t.y) ? null : "target.point";
			return "target.kind";
		}
		case "bookmark":
			if (!isNum(v.y)) return "y";
			if (!isStr(v.title)) return "title";
			if (!isNum(v.order)) return "order";
			return null;
		case "ink":
			if (v.tool !== "pen" && v.tool !== "highlighter") return "tool";
			if (!isStr(v.color)) return "color";
			if (!isNum(v.width) || v.width <= 0) return "width";
			if (!Array.isArray(v.points) || v.points.length % 2 !== 0 || !v.points.every(isNum)) return "points";
			return null;
		default:
			return "type";
	}
}

export interface ParseResult {
	sidecar: Sidecar;
	/** human-readable problems (invalid entries moved to `unknown`) */
	problems: string[];
}

/** Validate an already-migrated object. Never throws on bad entries. */
export function parseSidecar(raw: unknown): ParseResult {
	if (!isObj(raw)) throw new Error("sidecar is not a JSON object");
	if (raw.schemaVersion !== SCHEMA_VERSION) throw new Error(`unexpected schemaVersion ${String(raw.schemaVersion)}`);
	if (!isStr(raw.pdfFingerprint)) throw new Error("sidecar has no pdfFingerprint");
	const problems: string[] = [];
	const annotations: Annotation[] = [];
	const unknown: unknown[] = Array.isArray(raw.unknown) ? raw.unknown.slice() : [];
	const list = Array.isArray(raw.annotations) ? raw.annotations : [];
	if (!Array.isArray(raw.annotations)) problems.push("annotations is not an array");
	for (const a of list) {
		const err = validateAnnotation(a);
		if (err) {
			problems.push(`invalid annotation (${err}): ${JSON.stringify(a).slice(0, 120)}`);
			unknown.push(a);
		} else annotations.push(a as Annotation);
	}
	const sidecar: Sidecar = { schemaVersion: SCHEMA_VERSION, pdfFingerprint: raw.pdfFingerprint, annotations };
	if (unknown.length) sidecar.unknown = unknown;
	return { sidecar, problems };
}

/**
 * Pretty-printed JSON, except that coordinate arrays (`points`, `quads`) stay
 * on one line each: handwriting has thousands of numbers per page, and one
 * number per line would multiply the file size. Still plain JSON.
 */
export function serializeSidecar(s: Sidecar): string {
	const out: Sidecar = { schemaVersion: s.schemaVersion, pdfFingerprint: s.pdfFingerprint, annotations: s.annotations };
	if (s.unknown && s.unknown.length) out.unknown = s.unknown;
	const inline: string[] = [];
	// marker: U+0000 + "pendf:" + index; a real string collides only if it is exactly that
	const json = JSON.stringify(
		out,
		(key, value: unknown) => {
			if ((key === "points" || key === "quads") && Array.isArray(value)) {
				inline.push(JSON.stringify(value));
				return `\u0000pendf:${inline.length - 1}`;
			}
			return value;
		},
		"\t",
	);
	return json.replace(/"\\u0000pendf:(\d+)"/g, (_, i: string) => inline[Number(i)]) + "\n";
}

export function uuid(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
	const b = new Uint8Array(16);
	crypto.getRandomValues(b);
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
