// Per-page annotation layers.
//
// pdf.js removes unknown children from a page div whenever it resets the page
// (zoom, rotation, re-render), and only keeps rendered pages near the
// viewport. We therefore (re)attach our layers on the relevant pdf.js events
// and keep them only on visible pages ±1; everything else is detached and
// garbage-collectable.
//
// Each page gets one host <div class="pendf-layer-host"> placed directly
// *below* the text layer (so text selection keeps working) holding an <svg>
// whose viewBox is the page in PDF points at rotation r. Because the SVG is
// sized 100%×100% of the page box, zooming needs no re-layout at all; only a
// rotation change rebuilds the geometry.

import type { EventBus, PDFViewer } from "../pdfjs";
import { PageGeometry, type ViewBox } from "../geometry";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface PageLayer {
	pageNumber: number;
	host: HTMLDivElement;
	svg: SVGSVGElement;
	/** geometry in PDF points (scale = userUnit), current rotation */
	geom: PageGeometry;
	/** content group renderers draw into (blended: multiply, like ink on paper) */
	group: SVGGElement;
	/** pen ink (Phase 6): unblended, follows the page-invert filter like the canvas */
	ink: SVGGElement;
	inkSvg: SVGSVGElement;
	/** unblended group above `group`, for markers/icons that must keep their colors */
	overlay: SVGGElement;
	/** the <svg> holding `overlay` */
	overlaySvg: SVGSVGElement;
}

export interface LayerRenderer {
	/** Draw everything for this page into layer.group (already emptied). */
	renderPage(layer: PageLayer): void;
}

interface PageViewLike {
	id: number;
	div: HTMLDivElement;
	viewport: { viewBox: number[]; rotation: number; userUnit?: number; scale: number; width: number; height: number };
	textLayer?: { div: HTMLDivElement } | null;
}

export class LayerManager {
	private layers = new Map<number, PageLayer>();
	private renderers: LayerRenderer[] = [];
	private raf: number | null = null;
	private ac = new AbortController();
	private destroyed = false;
	private wanted = new Set<number>();
	/** during a zoom gesture: no DOM reads, no attach/detach (0.7.2) */
	private frozen = false;
	/** attach / detach counts, for the zoom timeline */
	readonly counters = { attach: 0, detach: 0, restored: 0 };
	private mo: MutationObserver;

	constructor(
		private readonly viewer: PDFViewer,
		eventBus: EventBus,
		private readonly container: HTMLElement,
	) {
		const on = (name: string, fn: (e: { pageNumber?: number }) => void) => {
			eventBus.on(name, fn, { signal: this.ac.signal });
		};
		on("pagerendered", (e) => e.pageNumber && this.ensure(e.pageNumber));
		on("textlayerrendered", (e) => e.pageNumber && this.ensure(e.pageNumber));
		on("scalechanging", () => this.reattachVisible());
		on("rotationchanging", () => this.rebuildAll());
		on("pagesinit", () => this.schedule());
		on("updateviewarea", () => this.schedule());
		container.addEventListener("scroll", () => this.schedule(), { passive: true, signal: this.ac.signal });
		// pdf.js removes unknown children when it resets a page (scale change, postponed or
		// cancelled render). Put a wanted layer back before the frame is painted.
		this.mo = new MutationObserver((records) => {
			if (this.destroyed) return;
			for (const m of records) {
				for (const node of Array.from(m.removedNodes)) {
					if (!node.instanceOf(HTMLElement) || !node.classList.contains("pendf-layer-host") || node.isConnected) continue;
					const n = Number(node.dataset.page);
					if (this.layers.get(n)?.host !== node) continue;
					this.place(n);
					if (node.isConnected) this.counters.restored++;
				}
			}
		});
		this.mo.observe(container, { childList: true, subtree: true });
	}

	/** Freeze layer bookkeeping during a zoom gesture; unfreezing syncs at once (layout is clean then). */
	setFrozen(frozen: boolean): void {
		if (this.frozen === frozen) return;
		this.frozen = frozen;
		if (frozen) {
			if (this.raf !== null) {
				window.cancelAnimationFrame(this.raf);
				this.raf = null;
			}
			return;
		}
		this.sync();
	}

	addRenderer(r: LayerRenderer): void {
		this.renderers.push(r);
	}

	get attachedPages(): number[] {
		return [...this.layers.keys()].sort((a, b) => a - b);
	}

	getLayer(pageNumber: number): PageLayer | undefined {
		return this.layers.get(pageNumber);
	}

	private pageView(n: number): PageViewLike | null {
		const pv = this.viewer.getPageView(n - 1) as unknown as PageViewLike | undefined;
		return pv ?? null;
	}

	/** Geometry in PDF points for page n at its current rotation. */
	geometry(n: number): PageGeometry | null {
		const pv = this.pageView(n);
		if (!pv) return null;
		const vp = pv.viewport;
		return new PageGeometry(vp.viewBox as ViewBox, vp.userUnit ?? 1, vp.rotation);
	}

	/** Pages whose box intersects the scroll container, by DOM measurement. */
	visiblePages(): number[] {
		const c = this.container.getBoundingClientRect();
		const out: number[] = [];
		const n = this.viewer.pagesCount;
		// binary search would be faster, but a linear pass over page tops is
		// cheap (offsetTop reads, no layout) for a few hundred pages
		for (let i = 1; i <= n; i++) {
			const pv = this.pageView(i);
			if (!pv) continue;
			const r = pv.div.getBoundingClientRect();
			if (r.bottom >= c.top && r.top <= c.bottom && r.right >= c.left && r.left <= c.right) out.push(i);
			else if (out.length && r.top > c.bottom) break;
		}
		return out;
	}

	/** Visible pages ±1. */
	wantedPages(): Set<number> {
		const vis = this.visiblePages();
		const want = new Set<number>();
		const n = this.viewer.pagesCount;
		for (const p of vis) {
			for (const q of [p - 1, p, p + 1]) if (q >= 1 && q <= n) want.add(q);
		}
		return want;
	}

	schedule(): void {
		if (this.frozen) {
			return;
		}
		if (this.raf !== null || this.destroyed) return;
		this.raf = window.requestAnimationFrame(() => {
			this.raf = null;
			this.sync();
		});
	}

	/** Attach wanted pages, detach the rest. */
	sync(): void {
		if (this.destroyed || this.frozen) return;
		const want = this.wantedPages();
		this.wanted = want;
		for (const n of [...this.layers.keys()]) if (!want.has(n)) this.detach(n);
		for (const n of want) this.ensure(n);
	}

	private reattachVisible(): void {
		for (const n of this.layers.keys()) this.place(n);
		this.schedule();
	}

	private rebuildAll(): void {
		for (const n of [...this.layers.keys()]) this.detach(n);
		this.schedule();
	}

	/** Make sure page n has a layer in the right DOM position (if wanted). */
	ensure(n: number): void {
		if (this.destroyed) return;
		if (this.frozen && !this.layers.has(n)) {
			return;
		}
		let layer = this.layers.get(n);
		if (!layer) {
			if (!this.wanted.has(n)) {
				this.schedule();
				return;
			}
			const geom = this.geometry(n);
			if (!geom) return;
			const host = createDiv({ cls: "pendf-layer-host", attr: { "data-page": String(n) } });
			const svg = host.doc.createElementNS(SVG_NS, "svg");
			svg.classList.add("pendf-layer-svg");
			svg.setAttribute("preserveAspectRatio", "none");
			const group = host.doc.createElementNS(SVG_NS, "g");
			svg.appendChild(group);
			host.appendChild(svg);
			const inkSvg = host.doc.createElementNS(SVG_NS, "svg");
			inkSvg.classList.add("pendf-layer-svg", "pendf-layer-ink");
			inkSvg.setAttribute("preserveAspectRatio", "none");
			const ink = host.doc.createElementNS(SVG_NS, "g");
			inkSvg.appendChild(ink);
			host.appendChild(inkSvg);
			const overlaySvg = host.doc.createElementNS(SVG_NS, "svg");
			overlaySvg.classList.add("pendf-layer-svg", "pendf-layer-overlay");
			overlaySvg.setAttribute("preserveAspectRatio", "none");
			const overlay = host.doc.createElementNS(SVG_NS, "g");
			overlaySvg.appendChild(overlay);
			host.appendChild(overlaySvg);
			layer = { pageNumber: n, host, svg, geom, group, ink, inkSvg, overlay, overlaySvg };
			this.layers.set(n, layer);
			this.counters.attach++;
			this.applyGeometry(layer);
			this.render(layer);
		} else {
			const geom = this.geometry(n);
			if (geom && geom.rotation !== layer.geom.rotation) {
				layer.geom = geom;
				this.applyGeometry(layer);
				this.render(layer);
			}
		}
		this.place(n);
	}

	private applyGeometry(layer: PageLayer): void {
		const vb = `0 0 ${layer.geom.width} ${layer.geom.height}`;
		layer.svg.setAttribute("viewBox", vb);
		layer.inkSvg.setAttribute("viewBox", vb);
		layer.overlaySvg.setAttribute("viewBox", vb);
	}

	/** Insert the host right below the text layer (or after the canvas). */
	private place(n: number): void {
		const layer = this.layers.get(n);
		const pv = this.pageView(n);
		if (!layer || !pv) return;
		const div = pv.div;
		const text = pv.textLayer?.div && pv.textLayer.div.parentElement === div ? pv.textLayer.div : null;
		if (text) {
			if (layer.host.nextSibling !== text || layer.host.parentElement !== div) div.insertBefore(layer.host, text);
		} else {
			const canvas = div.querySelector(":scope > .canvasWrapper");
			if (canvas) {
				if (canvas.nextSibling !== layer.host) canvas.after(layer.host);
			} else if (layer.host.parentElement !== div) div.appendChild(layer.host);
		}
	}

	private detach(n: number): void {
		const layer = this.layers.get(n);
		if (!layer) return;
		this.layers.delete(n);
		layer.host.remove();
		this.counters.detach++;
	}

	private render(layer: PageLayer): void {
		layer.group.replaceChildren();
		layer.ink.replaceChildren();
		layer.overlay.replaceChildren();
		for (const r of this.renderers) {
			try {
				r.renderPage(layer);
			} catch (e) {
				console.error("penDF layer renderer failed", e);
			}
		}
	}

	/** Re-render one page (if attached), or all attached pages. */
	refresh(pageNumber?: number): void {
		if (pageNumber !== undefined) {
			const l = this.layers.get(pageNumber);
			if (l) this.render(l);
			return;
		}
		for (const l of this.layers.values()) this.render(l);
	}

	destroy(): void {
		this.destroyed = true;
		this.ac.abort();
		this.mo.disconnect();
		if (this.raf !== null) window.cancelAnimationFrame(this.raf);
		for (const n of [...this.layers.keys()]) this.detach(n);
		this.renderers = [];
	}
}

/**
 * Client rect of a page's content box. pdf.js pages have a (transparent)
 * border, so the page div's own rect is larger than the area the canvas, the
 * text layer and our layers occupy. Measuring an inset-0 child keeps this
 * right under CSS transforms (pinch preview) too.
 */
export function pageContentRect(pageDiv: HTMLElement): DOMRect {
	for (const sel of [":scope > .textLayer", ":scope > .canvasWrapper", ":scope > .pendf-layer-host"]) {
		const el = pageDiv.querySelector<HTMLElement>(sel);
		if (!el) continue;
		const r = el.getBoundingClientRect();
		if (r.width > 0 && r.height > 0) return r;
	}
	const r = pageDiv.getBoundingClientRect();
	const cs = getComputedStyle(pageDiv);
	const sx = pageDiv.offsetWidth ? r.width / pageDiv.offsetWidth : 1;
	const sy = pageDiv.offsetHeight ? r.height / pageDiv.offsetHeight : 1;
	const bl = (parseFloat(cs.borderLeftWidth) || 0) * sx;
	const br = (parseFloat(cs.borderRightWidth) || 0) * sx;
	const bt = (parseFloat(cs.borderTopWidth) || 0) * sy;
	const bb = (parseFloat(cs.borderBottomWidth) || 0) * sy;
	return new DOMRect(r.left + bl, r.top + bt, r.width - bl - br, r.height - bt - bb);
}

export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
	const el = activeDocument.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
	return el;
}
