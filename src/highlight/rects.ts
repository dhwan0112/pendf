// Pure helpers for turning a text selection's rectangles into highlight
// quads. View-space rects (y down) of a single page in, merged line rects out.

import type { Rect } from "../geometry";

/** Drop degenerate and implausibly tall rects (container boxes etc.). */
export function cleanRects(rects: Rect[]): Rect[] {
	const ok = rects.filter((r) => r.w > 0.5 && r.h > 0.5 && Number.isFinite(r.x) && Number.isFinite(r.y));
	if (ok.length < 3) return ok;
	const hs = ok.map((r) => r.h).sort((a, b) => a - b);
	const median = hs[Math.floor(hs.length / 2)];
	return ok.filter((r) => r.h <= median * 3);
}

function vOverlap(a: Rect, b: Rect): number {
	return Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
}

function hGap(a: Rect, b: Rect): number {
	// negative when overlapping horizontally
	return Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
}

function union(a: Rect, b: Rect): Rect {
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/**
 * Two rects belong to the same visual line when they overlap vertically by at
 * least half the smaller height and the horizontal gap between them is at
 * most `gapFactor` × line height (word spacing; a column gutter is wider).
 */
export function sameLine(a: Rect, b: Rect, gapFactor = 1.0): boolean {
	const minH = Math.min(a.h, b.h);
	if (vOverlap(a, b) < minH * 0.5) return false;
	return hGap(a, b) <= Math.max(a.h, b.h) * gapFactor;
}

/** Merge rects that are on the same line into one rect per line segment. */
export function mergeLineRects(input: Rect[], gapFactor = 1.0): Rect[] {
	let rects = cleanRects(input).slice().sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x);
	let changed = true;
	while (changed) {
		changed = false;
		const out: Rect[] = [];
		for (const r of rects) {
			const hit = out.findIndex((o) => sameLine(o, r, gapFactor));
			if (hit >= 0) {
				out[hit] = union(out[hit], r);
				changed = true;
			} else out.push(r);
		}
		rects = out;
	}
	return rects.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Collapse whitespace the way a reader expects copied text to look. */
export function normalizeText(s: string): string {
	return s
		.replace(/-\n(?=\p{Ll})/gu, "") // re-join words hyphenated at line ends
		.replace(/\s+/g, " ")
		.trim();
}
