// Pure note/annotation helpers shared by the note controller, the highlight
// controller (cascade delete) and the annotations panel. No DOM, no Obsidian.

import type { Annotation, AreaAnnotation, HighlightAnnotation, NoteAnnotation, NoteTarget } from "../store/schema";

/** Id of the annotation a note is attached to (both target forms), or null for a point note. */
export function noteTargetId(target: NoteTarget): string | null {
	if (target.kind === "highlight") return target.highlightId;
	if (target.kind === "annotation") return target.id;
	return null;
}

/** The target form written for a note on `a`: highlights keep the 0.7.x form so older versions still show the note. */
export function targetFor(a: Annotation): NoteTarget {
	return a.type === "highlight" ? { kind: "highlight", highlightId: a.id } : { kind: "annotation", id: a.id };
}

/** PDF user-space point a note's marker sits on, or null for an orphaned note. */
export function noteAnchor(note: NoteAnnotation, byId: (id: string) => Annotation | undefined): [number, number] | null {
	if (note.target.kind === "point") return [note.target.x, note.target.y];
	const id = noteTargetId(note.target);
	const h = id ? byId(id) : undefined;
	if (!h || h.deleted) return null;
	// top-right corner of the first line / of the area, as displayed (quad order UL, UR, LL, LR)
	if (h.type === "highlight" && h.quads.length) return [h.quads[0][2], h.quads[0][3]];
	if (h.type === "area") return [h.quad[2], h.quad[3]];
	return null;
}

/** Live notes attached to any of the given annotation ids (either target form). */
export function notesForHighlights(all: readonly Annotation[], highlightIds: readonly string[]): NoteAnnotation[] {
	const ids = new Set(highlightIds);
	return all.filter((a): a is NoteAnnotation => {
		if (a.type !== "note" || a.deleted) return false;
		const id = noteTargetId(a.target);
		return id !== null && ids.has(id);
	});
}

export function noteForHighlight(all: readonly Annotation[], highlightId: string): NoteAnnotation | undefined {
	return notesForHighlights(all, [highlightId])[0];
}

/** Top edge (PDF y, larger = higher on an unrotated page) used to order items on a page. */
export function annotationTop(a: Annotation, byId: (id: string) => Annotation | undefined): number {
	switch (a.type) {
		case "highlight":
			return Math.max(...a.quads.flatMap((q) => [q[1], q[3], q[5], q[7]]));
		case "note":
			return noteAnchor(a, byId)?.[1] ?? Number.NEGATIVE_INFINITY;
		case "bookmark":
			return a.y;
		case "ink": {
			let top = Number.NEGATIVE_INFINITY;
			for (let i = 1; i < a.points.length; i += 2) top = Math.max(top, a.points[i]);
			return top;
		}
		case "area":
			return Math.max(a.quad[1], a.quad[3], a.quad[5], a.quad[7]);
	}
}

export interface PanelItem {
	/** the highlight, the area excerpt, or the stand-alone (point / orphaned) note */
	annotation: HighlightAnnotation | AreaAnnotation | NoteAnnotation;
	/** the note attached to a highlight item */
	note?: NoteAnnotation;
}

export interface PanelPage {
	page: number;
	items: PanelItem[];
}

/**
 * Highlights (with their note) and stand-alone notes, grouped by page in
 * reading order (top of page first). Pieces of a cross-page highlight are
 * listed on their own pages.
 */
export function panelPages(all: readonly Annotation[]): PanelPage[] {
	const live = all.filter((a) => !a.deleted);
	const byId = new Map(live.map((a) => [a.id, a] as const));
	const get = (id: string) => byId.get(id);
	const attached = new Map<string, NoteAnnotation>();
	for (const a of live) {
		if (a.type !== "note") continue;
		const id = noteTargetId(a.target);
		const t = id ? get(id) : undefined;
		if (id && (t?.type === "highlight" || t?.type === "area")) {
			const prev = attached.get(id);
			if (!prev || a.createdAt < prev.createdAt) attached.set(id, a);
		}
	}
	const pages = new Map<number, { item: PanelItem; top: number; created: number }[]>();
	const push = (page: number, item: PanelItem) => {
		const list = pages.get(page) ?? [];
		list.push({ item, top: annotationTop(item.annotation, get), created: item.annotation.createdAt });
		pages.set(page, list);
	};
	for (const a of live) {
		if (a.type === "highlight" || a.type === "area") push(a.page, { annotation: a, note: attached.get(a.id) });
		else if (a.type === "note") {
			const id = noteTargetId(a.target);
			if (!(id && attached.get(id) === a)) push(a.page, { annotation: a });
		}
	}
	return [...pages.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([page, list]) => ({
			page,
			items: list.sort((x, y) => y.top - x.top || x.created - y.created).map((x) => x.item),
		}));
}
