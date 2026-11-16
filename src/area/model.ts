// Area excerpts (Phase 7b, 0.8.0). Pure — no DOM, no pdf.js.

import { PageGeometry, type Quad, type Rect, type ViewBox } from "../geometry";

/** smallest area worth keeping (view px) — a tap is not an area */
export const MIN_AREA_PX = 6;

/** Rectangle from two corners in any order, clamped to [0, w] × [0, h]. */
export function dragRect(x0: number, y0: number, x1: number, y1: number, w: number, h: number): Rect {
	const cx = (v: number) => Math.min(w, Math.max(0, v));
	const cy = (v: number) => Math.min(h, Math.max(0, v));
	const ax = cx(Math.min(x0, x1));
	const bx = cx(Math.max(x0, x1));
	const ay = cy(Math.min(y0, y1));
	const by = cy(Math.max(y0, y1));
	return { x: ax, y: ay, w: bx - ax, h: by - ay };
}

/** PDF box [x0, y0, x1, y1] of a quad. */
export function quadBox(q: Quad | readonly number[]): [number, number, number, number] {
	const xs = [q[0], q[2], q[4], q[6]];
	const ys = [q[1], q[3], q[5], q[7]];
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export interface TextItem {
	/** origin (start of the baseline), PDF user space */
	x: number;
	y: number;
	/** length along the text direction and font height, PDF units */
	w: number;
	h: number;
	/** unit text direction (1, 0 for horizontal text) */
	ux?: number;
	uy?: number;
	/** slice of `joined` (search-normalized: lower case) */
	start: number;
	len: number;
	/** the item's own text, whitespace-normalized (case kept) */
	raw?: string;
}

/** The text of the items whose centre lies inside the PDF box, in reading (content stream) order. */
export function textInBox(items: readonly TextItem[], joined: string, box: readonly [number, number, number, number]): string {
	const [x0, y0, x1, y1] = box;
	const out: string[] = [];
	for (const it of items) {
		const ux = it.ux ?? 1;
		const uy = it.uy ?? 0;
		// centre: half the width along the text, a third of the height up (most glyph ink sits there)
		const cx = it.x + ux * (it.w / 2) - uy * (it.h / 3);
		const cy = it.y + uy * (it.w / 2) + ux * (it.h / 3);
		if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) out.push(it.raw ?? joined.slice(it.start, it.start + it.len));
	}
	return out.join(" ").replace(/\s+/g, " ").trim();
}

/** pixels per PDF point of an area image at `scale` × 100 % zoom (CSS px are 96/72 of a point) */
export function pixelsPerPoint(scale: number): number {
	return (scale * 96) / 72;
}

export interface AreaRenderPlan {
	/** pdf.js viewport scale (px per PDF point) */
	scale: number;
	/** rotation to render at (the page's own /Rotate: the excerpt is upright as the page reads) */
	rotation: number;
	/** the area inside that viewport */
	rect: Rect;
	width: number;
	height: number;
	/** the requested resolution was lowered to stay within maxPixels */
	reduced: boolean;
}

/**
 * Size of the image of `quad` at `scale` (× 100 % zoom), lowered if it would
 * exceed `maxPixels` (canvas memory budget, iOS canvas limits).
 */
export function areaRenderPlan(quad: Quad | readonly number[], viewBox: ViewBox, rotation: number, scale: number, maxPixels: number): AreaRenderPlan {
	let ppp = pixelsPerPoint(scale);
	const at = (k: number) => {
		const g = new PageGeometry(viewBox, k, rotation);
		const r = g.quadToViewRect(quad as Quad);
		return { r, w: Math.max(1, Math.ceil(r.w)), h: Math.max(1, Math.ceil(r.h)) };
	};
	let p = at(ppp);
	let reduced = false;
	if (p.w * p.h > maxPixels) {
		ppp *= Math.sqrt(maxPixels / (p.w * p.h)) * 0.995;
		p = at(ppp);
		reduced = true;
	}
	return { scale: ppp, rotation, rect: p.r, width: p.w, height: p.h, reduced };
}
