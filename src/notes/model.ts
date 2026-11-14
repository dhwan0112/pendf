// Pure note/annotation helpers shared by the note controller, the highlight
// controller (cascade delete) and the annotations panel. No DOM, no Obsidian.

import type { Annotation, HighlightAnnotation, NoteAnnotation } from "../store/schema";

/** PDF user-space point a note's marker sits on, or null for an orphaned note. */
export function noteAnchor(note: NoteAnnotation, byId: (id: string) => Annotation | undefined): [number, number] | null {
	if (note.target.kind === "point") return [note.target.x, note.target.y];
	const h = byId(note.target.highlightId);
	if (!h || h.deleted || h.type !== "highlight" || h.quads.length === 0) return null;
	// top-right corner of the first line, as displayed (quad order UL, UR, LL, LR)
	const q = h.quads[0];
	return [q[2], q[3]];
}

/** Live notes attached to any of the given highlight ids. */
export function notesForHighlights(all: readonly Annotation[], highlightIds: readonly string[]): NoteAnnotation[] {
	const ids = new Set(highlightIds);
	return all.filter((a): a is NoteAnnotation => a.type === "note" && !a.deleted && a.target.kind === "highlight" && ids.has(a.target.highlightId));
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
	}
}

export interface PanelItem {
	/** the highlight or the stand-alone (point / orphaned) note */
	annotation: HighlightAnnotation | NoteAnnotation;
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
		if (a.type === "note" && a.target.kind === "highlight" && get(a.target.highlightId)?.type === "highlight") {
			const prev = attached.get(a.target.highlightId);
			if (!prev || a.createdAt < prev.createdAt) attached.set(a.target.highlightId, a);
		}
	}
	const pages = new Map<number, { item: PanelItem; top: number; created: number }[]>();
	const push = (page: number, item: PanelItem) => {
		const list = pages.get(page) ?? [];
		list.push({ item, top: annotationTop(item.annotation, get), created: item.annotation.createdAt });
		pages.set(page, list);
	};
	for (const a of live) {
		if (a.type === "highlight") push(a.page, { annotation: a, note: attached.get(a.id) });
		else if (a.type === "note" && !(a.target.kind === "highlight" && attached.get(a.target.highlightId) === a)) push(a.page, { annotation: a });
	}
	return [...pages.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([page, list]) => ({
			page,
			items: list.sort((x, y) => y.top - x.top || x.created - y.created).map((x) => x.item),
		}));
}
