// Phase 5 — user bookmarks: ordering helpers. Pure, no DOM / Obsidian.
//
// Bookmarks are listed by `order` (a float, so one item can move between two
// others without touching the rest); ties fall back to creation time.

import type { Annotation, BookmarkAnnotation } from "../store/schema";

export function sortedBookmarks(all: readonly Annotation[]): BookmarkAnnotation[] {
	return all
		.filter((a): a is BookmarkAnnotation => a.type === "bookmark" && !a.deleted)
		.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** order for a bookmark appended at the end */
export function orderAtEnd(list: readonly BookmarkAnnotation[]): number {
	return list.length ? Math.floor(list[list.length - 1].order) + 1 : 1;
}

/**
 * New `order` values that move bookmark `id` to position `to` (0-based, in
 * the list without it). `list` must be sorted (`sortedBookmarks`). Usually only the moved bookmark changes; when the gap
 * between its new neighbours is too small, all bookmarks are renumbered.
 */
export function reorder(list: readonly BookmarkAnnotation[], id: string, to: number): Map<string, number> {
	const rest = list.filter((b) => b.id !== id);
	const moved = list.find((b) => b.id === id);
	const out = new Map<string, number>();
	if (!moved) return out;
	const i = Math.max(0, Math.min(to, rest.length));
	const before = rest[i - 1]?.order;
	const after = rest[i]?.order;
	let next: number;
	if (before === undefined && after === undefined) next = 1;
	else if (before === undefined) next = after - 1;
	else if (after === undefined) next = Math.floor(before) + 1;
	else next = (before + after) / 2;
	const tooClose = before !== undefined && after !== undefined && (after - before < 1e-6 || next <= before || next >= after);
	if (tooClose) {
		const full = [...rest.slice(0, i), moved, ...rest.slice(i)];
		full.forEach((b, k) => {
			if (b.order !== k + 1) out.set(b.id, k + 1);
		});
		return out;
	}
	if (next !== moved.order) out.set(moved.id, next);
	return out;
}

/** "Page 12", or "Page 12 — <outline title>" when the outline names the section. */
export function defaultBookmarkTitle(page: number, section?: string): string {
	const s = section?.replace(/\s+/g, " ").trim();
	return s ? `Page ${page} — ${s.length > 50 ? s.slice(0, 49) + "…" : s}` : `Page ${page}`;
}

export interface OutlineEntry {
	title: string;
	/** 1-based page, when it could be resolved */
	page: number | null;
	depth: number;
}

/** The deepest outline entry that starts on or before `page` (for default titles). */
export function sectionFor(entries: readonly OutlineEntry[], page: number): string | undefined {
	let best: OutlineEntry | undefined;
	for (const e of entries) {
		if (e.page === null || e.page > page) continue;
		if (!best || e.page > best.page! || (e.page === best.page && e.depth >= best.depth)) best = e;
	}
	return best?.title;
}
