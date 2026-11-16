// Pinch / trackpad zoom without re-rendering during the gesture (0.7.2).
//
// While fingers move, only a compositor transform changes: the .pdfViewer
// element gets `transform-origin` (the gesture's start point) and
// `translate() scale()`; pdf.js is not told anything, no layout is read, no
// layer is touched. When the gesture ends, everything happens in one task so
// the browser paints only the final state:
//   1. note which page point is under the gesture centre in the preview,
//   2. remove the transform and set the new scale on pdf.js once,
//   3. inside pdf.js's synchronous `scalechanging` (before it picks pages to
//      render) scroll so that page point is under the centre again, and free
//      the canvases of pages that are no longer visible.
// pdf.js keeps each visible page's old canvas (CSS-scaled, blurry) until the
// new one is complete, so the swap is blurry → sharp, never blank.
//
// No Obsidian imports: the WebKit smoke bundles this file with the engine.

import { MAX_SCALE, MIN_SCALE, anchorIn, clampFactor, clampTranslate, isContinuousWheel, scrollCorrection, transformCss, wheelZoomFactor, type Box, type CompositeState } from "./math";
import type { ZoomTimeline } from "./timeline";

export interface ZoomHost {
	/** pdf.js scroll container */
	container: HTMLElement;
	/** pdf.js .pdfViewer element (gets the transform) */
	viewerEl: HTMLElement;
	pagesCount(): number;
	/** page div, 1-based */
	pageDiv(n: number): HTMLElement | null;
	getScale(): number;
	/** set the pdf.js scale; pdf.js dispatches `scalechanging` synchronously → call onScaleChanging() from it */
	setScale(scale: number): void;
	/** stop / resume layer bookkeeping (no DOM reads or writes while frozen) */
	freezeLayers(frozen: boolean): void;
	/** after the commit's scroll correction: free what is off screen; returns pages freed */
	releaseOffscreen?(visible: Set<number>): number;
	/** a gesture started (close menus etc.) */
	onBegin?(): void;
	timeline?: ZoomTimeline | null;
}

interface PageBox {
	n: number;
	/** in the transformed element's coordinates (untransformed) */
	left: number;
	top: number;
	width: number;
	height: number;
}

interface Gesture {
	kind: "pinch" | "wheel" | "notch";
	startScale: number;
	min: number;
	max: number;
	/** the element's untransformed client box (height = full content height) */
	el: { left: number; top: number; height: number };
	view: Box;
	pages: PageBox[];
	anchorPage: PageBox | null;
	st: CompositeState;
	startX: number;
	startY: number;
	curX: number;
	curY: number;
	raf: number | null;
}

interface PendingCommit {
	page: number;
	fx: number;
	fy: number;
	x: number;
	y: number;
	done: boolean;
	released: number;
}

/** wheel events closer than this belong to one trackpad gesture */
const WHEEL_IDLE_MS = 160;
/**
 * When pdf.js starts drawing a page at the new scale it snaps the page box to the
 * canvas's pixel grid (--scale-round-x/y), which can move the layout by a few px
 * after the commit. For this long after a commit, renders re-apply the anchor —
 * unless the view was scrolled meanwhile (the user took over).
 */
const SETTLE_MS = 3000;
const SETTLE_MAX_PX = 40;

export class ZoomController {
	private g: Gesture | null = null;
	private pending: PendingCommit | null = null;
	private wheelFactor = 1;
	private wheelTimer: number | null = null;
	private settle: { page: number; fx: number; fy: number; x: number; y: number; until: number; top: number; left: number } | null = null;
	/** last commit, for the timeline / tests */
	lastCommit: {
		scale: number;
		anchorErrorPx: number | null;
		ms: number;
		released: number;
		/** how far the reachability clamp moved the preview, and how far the gesture centre moved (CSS px) */
		clamp: [number, number];
		moved: [number, number];
		/** re-anchorings after pdf.js snapped page boxes while rendering */
		settled: number;
	} | null = null;

	constructor(private readonly host: ZoomHost) {}

	get active(): boolean {
		return this.g !== null;
	}

	/** Start a composited gesture at client point (x, y). */
	begin(kind: Gesture["kind"], x: number, y: number): void {
		if (this.g) return;
		this.settle = null;
		const { container, viewerEl } = this.host;
		const r = viewerEl.getBoundingClientRect();
		const cr = container.getBoundingClientRect();
		const view: Box = { left: cr.left + container.clientLeft, top: cr.top + container.clientTop, width: container.clientWidth, height: container.clientHeight };
		const pages = this.pagesNear(view, r);
		const scale = this.host.getScale();
		const st: CompositeState = { originX: x - r.left, originY: y - r.top, tx: 0, ty: 0, factor: 1 };
		this.g = {
			kind,
			startScale: scale,
			min: Math.min(MIN_SCALE, scale),
			max: Math.max(MAX_SCALE, scale),
			el: { left: r.left, top: r.top, height: viewerEl.scrollHeight || r.height },
			view,
			pages,
			anchorPage: pageAt(pages, st.originX, st.originY),
			st,
			startX: x,
			startY: y,
			curX: x,
			curY: y,
			raf: null,
		};
		const css = transformCss(st);
		viewerEl.style.transformOrigin = css.origin;
		viewerEl.classList.add("pendf-zooming");
		this.host.freezeLayers(true);
		this.host.onBegin?.();
		this.host.timeline?.begin(kind === "notch" ? "wheel" : kind, scale);
	}

	/** factor relative to the start scale; (x, y) = current gesture centre. */
	update(factor: number, x: number, y: number): void {
		const g = this.g;
		if (!g) return;
		g.curX = x;
		g.curY = y;
		this.computeState(factor);
		if (g.raf === null) {
			g.raf = window.requestAnimationFrame(() => {
				g.raf = null;
				if (this.g !== g) return;
				this.host.viewerEl.style.transform = transformCss(g.st).transform;
				this.host.timeline?.transformWritten();
			});
		}
	}

	private computeState(factor: number): void {
		const g = this.g;
		if (!g) return;
		const f = clampFactor(g.startScale, factor, g.min, g.max);
		const raw: CompositeState = { ...g.st, factor: f, tx: g.curX - g.startX, ty: g.curY - g.startY };
		const anchor = g.anchorPage ? { left: g.anchorPage.left, width: g.anchorPage.width } : null;
		const { tx, ty } = clampTranslate(raw, g.el, anchor, g.view);
		g.st = { ...raw, tx, ty };
	}

	/** Commit: one scale change, scroll so the content under the centre stays there. */
	end(): void {
		const g = this.g;
		if (!g) return;
		const t0 = performance.now();
		this.g = null;
		if (g.raf !== null) window.cancelAnimationFrame(g.raf);
		this.clearWheel();
		const { container, viewerEl } = this.host;
		const st = g.st;
		// the content point shown under the centre (element coordinates)
		const px = st.originX + (g.curX - g.el.left - st.originX - st.tx) / st.factor;
		const py = st.originY + (g.curY - g.el.top - st.originY - st.ty) / st.factor;
		const page = pageAt(g.pages, px, py);
		viewerEl.style.transform = "";
		viewerEl.style.transformOrigin = "";
		viewerEl.classList.remove("pendf-zooming");
		let released = 0;
		let err: number | null = null;
		if (Math.abs(st.factor - 1) < 0.002 || !page) {
			// a pan (or nothing): move by the preview's translation
			container.scrollLeft -= st.tx;
			container.scrollTop -= st.ty;
		} else {
			const a = anchorIn(page, px, py);
			this.pending = { page: page.n, fx: a.fx, fy: a.fy, x: g.curX, y: g.curY, done: false, released: 0 };
			try {
				this.host.setScale(Math.round(g.startScale * st.factor * 10000) / 10000);
				// same scale (rounding) → pdf.js dispatched nothing
				if (!this.pending.done) this.onScaleChanging();
				released = this.pending.released;
				const r = this.host.pageDiv(page.n)?.getBoundingClientRect();
				if (r) err = Math.hypot(r.left + a.fx * r.width - g.curX, r.top + a.fy * r.height - g.curY);
				this.settle = { page: page.n, fx: a.fx, fy: a.fy, x: g.curX, y: g.curY, until: performance.now() + SETTLE_MS, top: container.scrollTop, left: container.scrollLeft };
			} finally {
				this.pending = null;
			}
		}
		this.host.freezeLayers(false);
		const ms = performance.now() - t0;
		const r2 = (n: number) => Math.round(n * 100) / 100;
		this.lastCommit = {
			scale: this.host.getScale(),
			anchorErrorPx: err === null ? null : r2(err),
			ms,
			released,
			clamp: [r2(st.tx - (g.curX - g.startX)), r2(st.ty - (g.curY - g.startY))],
			moved: [r2(g.curX - g.startX), r2(g.curY - g.startY)],
			settled: 0,
		};
		this.host.timeline?.end(this.host.getScale(), ms, released, this.lastCommit.anchorErrorPx);
	}

	/** Called from pdf.js's `scalechanging`: during a commit, correct the scroll before pdf.js renders. */
	onScaleChanging(): void {
		const p = this.pending;
		if (!p || p.done) return;
		p.done = true;
		const div = this.host.pageDiv(p.page);
		if (!div) return;
		const { container } = this.host;
		const { dx, dy } = scrollCorrection(p, div.getBoundingClientRect(), p.x, p.y);
		container.scrollLeft += dx;
		container.scrollTop += dy;
		if (this.host.releaseOffscreen) {
			const cr = container.getBoundingClientRect();
			p.released = this.host.releaseOffscreen(this.visiblePages(cr));
		}
	}

	/** Call on pdf.js `pagerendered`: keep the committed anchor in place while page boxes snap. */
	onPageRendered(): void {
		const st = this.settle;
		if (!st || this.g) return;
		const { container } = this.host;
		if (performance.now() > st.until || Math.abs(container.scrollTop - st.top) > 0.5 || Math.abs(container.scrollLeft - st.left) > 0.5) {
			this.settle = null;
			return;
		}
		const div = this.host.pageDiv(st.page);
		if (!div) return;
		const { dx, dy } = scrollCorrection(st, div.getBoundingClientRect(), st.x, st.y);
		const d = Math.hypot(dx, dy);
		if (d < 0.5 || d > SETTLE_MAX_PX) return;
		container.scrollLeft += dx;
		container.scrollTop += dy;
		st.top = container.scrollTop;
		st.left = container.scrollLeft;
		if (this.lastCommit) this.lastCommit.settled++;
	}

	/** Drop the preview without changing anything (teardown, ink starts, file switch). */
	cancel(): void {
		this.settle = null;
		const g = this.g;
		if (!g) return;
		this.g = null;
		if (g.raf !== null) window.cancelAnimationFrame(g.raf);
		this.clearWheel();
		const el = this.host.viewerEl;
		el.style.transform = "";
		el.style.transformOrigin = "";
		el.classList.remove("pendf-zooming");
		this.host.freezeLayers(false);
		this.host.timeline?.end(this.host.getScale(), 0, 0, null);
	}

	/**
	 * ctrl/⌘ + wheel. Trackpad pinches (small pixel deltas) zoom continuously on
	 * the composite path and commit once the events stop; a mouse-wheel notch
	 * zooms one 10 % step right away (anchored under the pointer).
	 * Returns false when the event is not a zoom.
	 */
	wheel(e: WheelEvent): boolean {
		if (!(e.ctrlKey || e.metaKey)) return false;
		e.preventDefault();
		if (this.g && this.g.kind === "pinch") return true;
		if (isContinuousWheel(e.deltaY, e.deltaMode)) {
			if (!this.g) {
				this.begin("wheel", e.clientX, e.clientY);
				this.wheelFactor = 1;
			}
			const g = this.g;
			if (!g) return true;
			this.wheelFactor *= wheelZoomFactor(e.deltaY, e.deltaMode);
			this.update(this.wheelFactor, g.startX, g.startY);
			this.clearWheel();
			this.wheelTimer = window.setTimeout(() => this.end(), WHEEL_IDLE_MS);
			return true;
		}
		if (this.g) this.end();
		if (!e.deltaY) return true;
		this.begin("notch", e.clientX, e.clientY);
		this.computeState(e.deltaY < 0 ? 1.1 : 1 / 1.1);
		this.end();
		return true;
	}

	private clearWheel(): void {
		if (this.wheelTimer !== null) window.clearTimeout(this.wheelTimer);
		this.wheelTimer = null;
	}

	/** Pages intersecting `view` ±1 screen, by binary search on page tops (pages are stacked vertically). */
	private pagesNear(view: Box, elRect: DOMRect): PageBox[] {
		const n = this.host.pagesCount();
		const out: PageBox[] = [];
		if (!n) return out;
		const lo = view.top - view.height;
		const hi = view.top + 2 * view.height;
		const first = this.firstPageEndingAfter(lo);
		for (let i = first; i <= n; i++) {
			const div = this.host.pageDiv(i);
			if (!div) continue;
			const r = div.getBoundingClientRect();
			if (r.top > hi) break;
			out.push({ n: i, left: r.left - elRect.left, top: r.top - elRect.top, width: r.width, height: r.height });
		}
		return out;
	}

	private firstPageEndingAfter(y: number): number {
		let a = 1;
		let b = this.host.pagesCount();
		while (a < b) {
			const m = (a + b) >> 1;
			const r = this.host.pageDiv(m)?.getBoundingClientRect();
			if (!r || r.bottom < y) a = m + 1;
			else b = m;
		}
		return a;
	}

	/** Visible page numbers (client rect of the container). */
	visiblePages(cr: DOMRect): Set<number> {
		const out = new Set<number>();
		const n = this.host.pagesCount();
		for (let i = this.firstPageEndingAfter(cr.top); i <= n; i++) {
			const r = this.host.pageDiv(i)?.getBoundingClientRect();
			if (!r) continue;
			if (r.top > cr.bottom) break;
			if (r.right > cr.left && r.left < cr.right) out.add(i);
		}
		return out;
	}
}

/** The page containing (x, y), else the vertically nearest one. */
function pageAt(pages: PageBox[], x: number, y: number): PageBox | null {
	let best: PageBox | null = null;
	let bestD = Infinity;
	for (const p of pages) {
		const dy = y < p.top ? p.top - y : y > p.top + p.height ? y - (p.top + p.height) : 0;
		const dx = x < p.left ? p.left - x : x > p.left + p.width ? x - (p.left + p.width) : 0;
		const d = dy * 10 + dx;
		if (d < bestD) {
			bestD = d;
			best = p;
		}
	}
	return best;
}
