// Margin space in the view (Phase 7a, 0.8.0, D-41). No Obsidian imports.
//
// The margin is part of each page's box: the page div's transparent border on
// the margin side grows by ratio × page width (CSS, from --pendf-margin-pts).
// Absolutely positioned layers (text, annotations, penDF's) are placed in the
// padding box, which a border does not move, so pdf.js's own layers stay put;
// and the pointer over the margin still hits the page element, so ink, eraser
// and notes work there unchanged (INVESTIGATION §13).

import type { Annotation } from "../store/schema";
import type { ViewBox } from "../geometry";
import { NO_EXTENT, hiddenSides, intrinsicRotation, intrinsicWidth, mergeExtent, offPageExtent, screenSide, type Extent, type MarginConfig } from "./model";

export interface MarginPageView {
	div: HTMLElement;
	viewport: { viewBox: number[]; rotation: number };
}

export interface MarginHost {
	/** .pendf-root (classes) */
	root: HTMLElement;
	pagesCount(): number;
	pageView(n: number): MarginPageView | null;
	/** the reader's view rotation (pdf.js pagesRotation) */
	viewRotation(): number;
	annotations(): readonly Annotation[];
}

/** PDF points a note marker reaches beyond its anchor (marker radius ≈ 9 CSS px at 100 %) */
const NOTE_PAD = 9;

const SIDE_CLASSES = ["pendf-margin-left", "pendf-margin-right", "pendf-margin-top", "pendf-margin-bottom"];
const HIDDEN_CLASSES = ["pendf-hidden-left", "pendf-hidden-right", "pendf-hidden-top", "pendf-hidden-bottom"];

export class MarginController {
	private extents = new Map<number, Extent>();

	constructor(
		private readonly host: MarginHost,
		public cfg: MarginConfig,
	) {}

	/** Content extent beyond each page (recompute after annotation changes). */
	recompute(): void {
		this.extents.clear();
		for (const a of this.host.annotations()) {
			if (a.deleted) continue;
			let pts: number[] | null = null;
			let pad = 0;
			if (a.type === "ink") {
				pts = a.points;
				pad = a.width / 2;
			} else if (a.type === "note" && a.target.kind === "point") {
				pts = [a.target.x, a.target.y];
				pad = NOTE_PAD;
			} else if (a.type === "area") {
				pts = a.quad;
			}
			if (!pts) continue;
			const pv = this.host.pageView(a.page);
			if (!pv) continue;
			const vb = pv.viewport.viewBox as ViewBox;
			const r0 = intrinsicRotation(pv.viewport.rotation, this.host.viewRotation());
			const e = offPageExtent(pts, vb, r0, pad);
			this.extents.set(a.page, mergeExtent(this.extents.get(a.page) ?? NO_EXTENT, e));
		}
	}

	/** Extent of the whole document (auto-opening). */
	documentExtent(): Extent {
		let e = NO_EXTENT;
		for (const x of this.extents.values()) e = mergeExtent(e, x);
		return e;
	}

	pageExtent(page: number): Extent {
		return this.extents.get(page) ?? NO_EXTENT;
	}

	/** Write the margin into the DOM: root classes, per-page width, hidden-content marks. */
	apply(): void {
		const { root } = this.host;
		const rot = this.host.viewRotation();
		root.classList.toggle("pendf-margin-on", this.cfg.on);
		root.classList.remove(...SIDE_CLASSES);
		if (this.cfg.on) root.classList.add(`pendf-margin-${screenSide(this.cfg.side, rot)}`);
		const n = this.host.pagesCount();
		for (let p = 1; p <= n; p++) {
			const pv = this.host.pageView(p);
			if (!pv) continue;
			const vb = pv.viewport.viewBox as ViewBox;
			const r0 = intrinsicRotation(pv.viewport.rotation, rot);
			const pts = this.cfg.on ? this.cfg.ratio * intrinsicWidth(vb, r0) : 0;
			pv.div.style.setProperty("--pendf-margin-pts", String(Math.round(pts * 100) / 100));
			pv.div.classList.remove(...HIDDEN_CLASSES);
			for (const side of hiddenSides(this.pageExtent(p), this.cfg)) pv.div.classList.add(`pendf-hidden-${screenSide(side, rot)}`);
		}
	}

	/** Pages with content beyond the page box on some side (tests, HUD). */
	pagesWithContent(): number[] {
		return [...this.extents.entries()].filter(([, e]) => e.left > 0.01 || e.right > 0.01 || e.top > 0.01 || e.bottom > 0.01).map(([p]) => p);
	}
}
