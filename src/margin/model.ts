// Margin space (Phase 7a, 0.8.0, D-41). Pure — no DOM, no pdf.js.
//
// Convention (docs/SCHEMA.md "Off-page coordinates"): margin content is stored
// like everything else, as PDF user-space points of its page — just outside the
// page box. "Right" and "left" are sides of the page as it is displayed with its
// own /Rotate applied (its intrinsic orientation). When the reader rotates the
// view, the margin turns with the page, so its content keeps its place next to
// the page.

import { PageGeometry, normalizeRotation, type ViewBox } from "../geometry";

export type MarginSide = "left" | "right";
export type ScreenSide = "left" | "right" | "top" | "bottom";

export interface MarginConfig {
	on: boolean;
	side: MarginSide;
	/** margin width as a share of the page width (intrinsic orientation) */
	ratio: number;
}

export const MARGIN_RATIOS = [0.25, 0.5, 0.75, 1] as const;
export const DEFAULT_MARGIN: MarginConfig = { on: false, side: "right", ratio: 0.5 };
/** widest margin penDF opens automatically for existing content */
export const MAX_AUTO_RATIO = 3;
/** room left beyond the farthest content when widening automatically */
const AUTO_PAD = 0.05;

export function normalizeMargin(v: unknown, fallback: MarginConfig = DEFAULT_MARGIN): MarginConfig {
	const o = (v ?? {}) as Partial<Record<keyof MarginConfig, unknown>>;
	const ratio = typeof o.ratio === "number" && Number.isFinite(o.ratio) && o.ratio > 0 ? Math.min(MAX_AUTO_RATIO, o.ratio) : fallback.ratio;
	return { on: typeof o.on === "boolean" ? o.on : fallback.on, side: o.side === "left" || o.side === "right" ? o.side : fallback.side, ratio };
}

/** The page's own rotation, from the total (pdf.js viewport) rotation and the reader's view rotation. */
export function intrinsicRotation(totalRotation: number, viewRotation: number): 0 | 90 | 180 | 270 {
	return normalizeRotation(totalRotation - viewRotation);
}

/** Width of the page box as displayed with its own /Rotate (PDF units). */
export function intrinsicWidth(viewBox: ViewBox, intrinsicRot: number): number {
	const w = Math.abs(viewBox[2] - viewBox[0]);
	const h = Math.abs(viewBox[3] - viewBox[1]);
	return normalizeRotation(intrinsicRot) % 180 === 0 ? w : h;
}

/** Where a margin side ends up on screen after the reader rotates the view clockwise. */
export function screenSide(side: MarginSide | ScreenSide, viewRotation: number): ScreenSide {
	const order: ScreenSide[] = ["top", "right", "bottom", "left"];
	const i = order.indexOf(side);
	return order[(i + normalizeRotation(viewRotation) / 90) % 4];
}

/** How far content reaches beyond each side of the page (intrinsic orientation), as a share of the page width / height. */
export interface Extent {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

export const NO_EXTENT: Extent = { left: 0, right: 0, top: 0, bottom: 0 };

/** Extent of PDF points [x0, y0, x1, y1, …] beyond the page box (intrinsic orientation). */
export function offPageExtent(points: readonly number[], viewBox: ViewBox, intrinsicRot: number, pad = 0): Extent {
	const g = new PageGeometry(viewBox, 1, intrinsicRot);
	const e = { ...NO_EXTENT };
	for (let i = 0; i + 1 < points.length; i += 2) {
		const [vx, vy] = g.toView(points[i], points[i + 1]);
		if (vx + pad > g.width) e.right = Math.max(e.right, (vx + pad - g.width) / g.width);
		if (vx - pad < 0) e.left = Math.max(e.left, (pad - vx) / g.width);
		if (vy + pad > g.height) e.bottom = Math.max(e.bottom, (vy + pad - g.height) / g.height);
		if (vy - pad < 0) e.top = Math.max(e.top, (pad - vy) / g.height);
	}
	return e;
}

export function mergeExtent(a: Extent, b: Extent): Extent {
	return { left: Math.max(a.left, b.left), right: Math.max(a.right, b.right), top: Math.max(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) };
}

/** Content beyond this share of the page counts (a stroke grazing the edge is not margin content). */
const MIN_CONTENT = 0.01;

export function hasSideContent(e: Extent): { left: boolean; right: boolean } {
	return { left: e.left > MIN_CONTENT, right: e.right > MIN_CONTENT };
}

/**
 * The margin to show when a PDF opens. Content in a side margin turns it on,
 * on the side holding the most content (the configured side on a tie), at
 * least as wide as that content plus a little room.
 */
export function autoMargin(document: Extent, base: MarginConfig): MarginConfig {
	const { left, right } = hasSideContent(document);
	if (!left && !right) return base;
	const side: MarginSide = left && right ? (document.left > document.right ? "left" : document.right > document.left ? "right" : base.side) : left ? "left" : "right";
	const need = (side === "left" ? document.left : document.right) + AUTO_PAD;
	return { on: true, side, ratio: Math.min(MAX_AUTO_RATIO, Math.max(base.ratio, need)) };
}

/** Which screen sides of a page hold content hidden while the margin (on `shown` side) is closed or too narrow. */
export function hiddenSides(e: Extent, cfg: MarginConfig): MarginSide[] {
	const out: MarginSide[] = [];
	for (const side of ["left", "right"] as const) {
		const reach = e[side];
		if (reach <= MIN_CONTENT) continue;
		if (!cfg.on || cfg.side !== side || reach > cfg.ratio + 1e-6) out.push(side);
	}
	return out;
}
