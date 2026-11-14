// Phase 6 — simple handwriting: a uniform-width ("mono") pen, a highlighter,
// a stroke eraser and undo. Ink mode is toggled from the toolbar.
//
// Input: in ink mode the Apple Pencil draws while fingers keep scrolling and
// selecting text (setting "stylus": the Pencil's touchstart is cancelled so
// iPadOS does not scroll; finger touches are left alone). Setting
// "exclusive": every pointer draws and touch scrolling is off while ink mode
// is on. A mouse draws in ink mode (desktop, for development).
//
// Latency: the live stroke goes onto one viewport-sized canvas, drawn
// synchronously in the pointer handler (coalesced events included). At pen-up
// the stroke is simplified, stored in PDF points, appended to the page's SVG
// ink layer, and the canvas is cleared.

import type { LayerManager, LayerRenderer, PageLayer } from "../layers";
import { pageContentRect, svgEl } from "../layers";
import type { PageGeometry } from "../geometry";
import type { InkSettings } from "../settings";
import type { InkAnnotation } from "../store/schema";
import { uuid } from "../store/schema";
import type { SidecarStore } from "../store/sidecar";
import type { UndoStack } from "../store/undo";
import { logger } from "../util/log";
import { bounds, dedupe, distanceToPolyline, pathData, roundPoints, simplify, type Box } from "./model";

const log = logger("ink");

/** eraser radius in CSS pixels */
const ERASER_PX = 10;
/** simplification tolerance, pt */
const TOL = { pen: 0.08, highlighter: 0.3 };
/** a click right after a stroke belongs to the stroke, not to highlights/notes */
const CLICK_GRACE_MS = 450;

export interface InkHost {
	root: HTMLElement;
	container: HTMLElement;
	layers: LayerManager;
	store: () => SidecarStore | null;
	undo: () => UndoStack | null;
	settings: () => InkSettings;
	notice: (msg: string) => void;
	/** ink mode turned on/off (toolbar state) */
	onActiveChange?: (on: boolean) => void;
	/** run a store edit without the panel re-render a normal edit triggers */
	quietly?: (fn: () => void) => void;
	/** another tool owns the next tap (e.g. placing a note): do not draw */
	busy?: () => boolean;
}

interface Stroke {
	pointerId: number;
	page: number;
	geom: PageGeometry;
	pageDiv: HTMLElement;
	/** CSS px per PDF point */
	scale: number;
	tool: "pen" | "highlighter";
	color: string;
	width: number;
	pts: number[];
	lastX: number;
	lastY: number;
}

interface Erase {
	pointerId: number;
	hits: Set<string>;
	lastX: number;
	lastY: number;
	/** strokes and their bounds, taken once at eraser-down (pages can hold thousands) */
	strokes: { id: string; page: number; points: number[]; width: number; box: Box }[];
	/** the page under the eraser, kept while the eraser stays on it (avoids a hit test per sample) */
	at: { page: number; div: HTMLElement; rect: DOMRect; geom: PageGeometry } | null;
	/** rendered paths by stroke id, collected at eraser-down */
	els: Map<string, Element[]>;
}

export class InkController implements LayerRenderer {
	private ac = new AbortController();
	private _active = false;
	private stroke: Stroke | null = null;
	private erase: Erase | null = null;
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D | null = null;
	private rootRect: DOMRect | null = null;
	private suppressClickUntil = 0;

	constructor(private readonly host: InkHost) {
		host.layers.addRenderer(this);
		this.canvas = host.root.createEl("canvas", { cls: "pendf-ink-live" });
		const c = host.container;
		const opts = { capture: true, signal: this.ac.signal };
		c.addEventListener("pointerdown", (e) => this.onDown(e), opts);
		c.addEventListener("pointermove", (e) => this.onMove(e), opts);
		c.addEventListener("pointerup", (e) => this.onUp(e, false), opts);
		c.addEventListener("pointercancel", (e) => this.onUp(e, true), opts);
		// iPadOS: cancelling the Pencil's touchstart stops it from scrolling the page;
		// finger touches pass through and still scroll / select
		c.addEventListener(
			"touchstart",
			(e) => {
				if (!this.pencilWrites() || this.host.settings().input !== "stylus" || this.host.busy?.()) return;
				for (const t of Array.from(e.changedTouches)) {
					if ((t as Touch & { touchType?: string }).touchType === "stylus") {
						e.preventDefault();
						return;
					}
				}
			},
			{ passive: false, capture: true, signal: this.ac.signal },
		);
		// swallow the click that ends a stroke (it would open highlight menus / notes)
		host.root.addEventListener(
			"click",
			(e) => {
				if (Date.now() < this.suppressClickUntil) {
					e.preventDefault();
					e.stopPropagation();
				}
			},
			{ capture: true, signal: this.ac.signal },
		);
	}

	// ----------------------------------------------------------------- state

	get active(): boolean {
		return this._active;
	}

	/** a stroke or erase gesture is in progress (pinch zoom is held off meanwhile) */
	get isDrawing(): boolean {
		return this.stroke !== null || this.erase !== null;
	}

	setActive(on: boolean): void {
		if (on === this._active) return;
		const store = this.host.store();
		if (on && (!store || !store.writable)) {
			this.host.notice("penDF: annotations for this PDF are read-only (see the banner).");
			return;
		}
		this._active = on;
		this.applyInputMode();
		if (!on) {
			this.cancelGesture();
			this.releaseCanvas();
		}
		this.host.onActiveChange?.(on);
	}

	/** re-apply the input mode (after the setting changed) */
	applyInputMode(): void {
		const exclusive = this._active && this.host.settings().input === "exclusive";
		this.host.root.toggleClass("is-inking", this._active);
		this.host.root.toggleClass("is-inking-exclusive", exclusive);
	}

	// ---------------------------------------------------------------- render

	renderPage(layer: PageLayer): void {
		const store = this.host.store();
		if (!store || !store.writable) return;
		for (const a of store.all()) if (a.type === "ink" && a.page === layer.pageNumber) this.drawStroke(layer, a);
	}

	private drawStroke(layer: PageLayer, a: InkAnnotation): void {
		const view: [number, number][] = [];
		for (let i = 0; i + 1 < a.points.length; i += 2) view.push(layer.geom.toView(a.points[i], a.points[i + 1]));
		const path = svgEl("path", {
			class: `pendf-ink pendf-ink-${a.tool}`,
			"data-id": a.id,
			d: pathData(view),
			stroke: a.color,
			"stroke-width": a.width,
		});
		// the highlighter blends with the page like text highlights; the pen sits on its own layer
		(a.tool === "highlighter" ? layer.group : layer.ink).appendChild(path);
	}

	// ----------------------------------------------------------------- input

	/** the Pencil writes now: in ink mode, or always when "Apple Pencil always writes" is on */
	private pencilWrites(): boolean {
		return this._active || this.host.settings().pencilAlways;
	}

	private draws(e: PointerEvent): boolean {
		if (this.host.busy?.()) return false;
		if (e.pointerType === "pen") return this.pencilWrites() && this.writable();
		if (!this._active) return false;
		if (e.pointerType === "touch") return this.host.settings().input === "exclusive";
		if (e.pointerType === "mouse") return e.button === 0;
		return false;
	}

	private writable(): boolean {
		const store = this.host.store();
		return !!store && store.writable;
	}

	private pageAt(clientX: number, clientY: number): HTMLElement | null {
		const doc = this.host.root.ownerDocument;
		const el = doc
			.elementsFromPoint(clientX, clientY)
			.map((x) => x.closest<HTMLElement>(".page[data-page-number]"))
			.find((x) => !!x);
		return el && this.host.container.contains(el) ? el : null;
	}

	private toPdf(s: Pick<Stroke, "geom" | "pageDiv">, x: number, y: number): [number, number] {
		const v = s.geom.clientToView(x, y, pageContentRect(s.pageDiv));
		return s.geom.toPdf(v[0], v[1]);
	}

	private onDown(e: PointerEvent): void {
		if (this.isDrawing || !this.draws(e)) return;
		const pageDiv = this.pageAt(e.clientX, e.clientY);
		if (!pageDiv) return;
		const page = Number(pageDiv.dataset.pageNumber);
		const geom = this.host.layers.geometry(page);
		if (!geom) return;
		e.preventDefault();
		e.stopPropagation();
		try {
			this.host.container.setPointerCapture(e.pointerId);
		} catch {
			// synthetic or already-released pointer: keep going without capture
		}
		const cfg = this.host.settings();
		if (cfg.tool === "eraser") {
			const store = this.host.store();
			const strokes = (store?.all() ?? [])
				.filter((a): a is InkAnnotation => a.type === "ink")
				.map((a) => ({ id: a.id, page: a.page, points: a.points, width: a.width, box: bounds(a.points) }));
			const els = new Map<string, Element[]>();
			for (const el of Array.from(this.host.container.querySelectorAll(".pendf-ink[data-id]"))) {
				const id = el.getAttribute("data-id") ?? "";
				const list = els.get(id);
				if (list) list.push(el);
				else els.set(id, [el]);
			}
			this.erase = { pointerId: e.pointerId, hits: new Set(), lastX: e.clientX, lastY: e.clientY, strokes, at: null, els };
			this.eraseAt(e.clientX, e.clientY);
			return;
		}
		const pr = pageContentRect(pageDiv);
		const scale = pr.width / geom.width;
		const tool = cfg.tool;
		const stroke: Stroke = {
			pointerId: e.pointerId,
			page,
			geom,
			pageDiv,
			scale,
			tool,
			color: tool === "pen" ? cfg.penColor : cfg.highlighterColor,
			width: tool === "pen" ? cfg.penWidth : cfg.highlighterWidth,
			pts: [],
			lastX: e.clientX,
			lastY: e.clientY,
		};
		this.stroke = stroke;
		const [x, y] = this.toPdf(stroke, e.clientX, e.clientY);
		stroke.pts.push(x, y);
		this.beginCanvas(stroke);
		this.segment(stroke, e.clientX, e.clientY, e.clientX, e.clientY);
	}

	private samples(e: PointerEvent): { clientX: number; clientY: number }[] {
		const list = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
		return list.length ? list : [e];
	}

	private onMove(e: PointerEvent): void {
		const s = this.stroke;
		if (s && e.pointerId === s.pointerId) {
			e.preventDefault();
			for (const p of this.samples(e)) {
				if (p.clientX === s.lastX && p.clientY === s.lastY) continue;
				const [x, y] = this.toPdf(s, p.clientX, p.clientY);
				s.pts.push(x, y);
				this.segment(s, s.lastX, s.lastY, p.clientX, p.clientY);
				s.lastX = p.clientX;
				s.lastY = p.clientY;
			}
			return;
		}
		const er = this.erase;
		if (er && e.pointerId === er.pointerId) {
			e.preventDefault();
			for (const p of this.samples(e)) {
				// test the path between samples too, so a quick flick does not skip strokes
				const dist = Math.hypot(p.clientX - er.lastX, p.clientY - er.lastY);
				const steps = Math.max(1, Math.ceil(dist / (ERASER_PX / 2)));
				for (let k = 1; k <= steps; k++) this.eraseAt(er.lastX + ((p.clientX - er.lastX) * k) / steps, er.lastY + ((p.clientY - er.lastY) * k) / steps);
				er.lastX = p.clientX;
				er.lastY = p.clientY;
			}
		}
	}

	private onUp(e: PointerEvent, cancelled: boolean): void {
		const s = this.stroke;
		if (s && e.pointerId === s.pointerId) {
			this.stroke = null;
			// pointercancel: iPadOS took the gesture over (e.g. as a scroll) — drop it
			if (!cancelled) this.commitStroke(s);
			this.clearCanvas();
			this.suppressClickUntil = Date.now() + CLICK_GRACE_MS;
			this.releaseLater();
			return;
		}
		const er = this.erase;
		if (er && e.pointerId === er.pointerId) {
			this.erase = null;
			this.commitErase(er);
			this.suppressClickUntil = Date.now() + CLICK_GRACE_MS;
		}
	}

	private cancelGesture(): void {
		this.stroke = null;
		if (this.erase) {
			// restore strokes hidden during an unfinished erase
			for (const id of this.erase.hits) this.pathsFor(id).forEach((p) => p.removeClass("is-erased"));
			this.erase = null;
		}
		this.clearCanvas();
	}

	// ---------------------------------------------------------- live canvas

	private beginCanvas(s: Stroke): void {
		const r = this.host.root.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		const w = Math.max(1, Math.round(r.width * dpr));
		const h = Math.max(1, Math.round(r.height * dpr));
		if (this.canvas.width !== w || this.canvas.height !== h) {
			this.canvas.width = w;
			this.canvas.height = h;
			this.canvas.setCssProps({ "--pendf-canvas-w": `${r.width}px`, "--pendf-canvas-h": `${r.height}px` });
			this.ctx = null;
		}
		this.rootRect = r;
		this.ctx ??= this.canvas.getContext("2d", { desynchronized: true });
		const ctx = this.ctx;
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, r.width, r.height);
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		// the highlighter is drawn opaque; the canvas element carries its transparency
		ctx.strokeStyle = s.color;
		ctx.lineWidth = Math.max(0.5, s.width * s.scale);
		this.canvas.toggleClass("is-highlighter", s.tool === "highlighter");
		this.canvas.addClass("is-drawing");
	}

	private segment(s: Stroke, x0: number, y0: number, x1: number, y1: number): void {
		const ctx = this.ctx;
		const r = this.rootRect;
		if (!ctx || !r) return;
		ctx.beginPath();
		ctx.moveTo(x0 - r.left, y0 - r.top);
		ctx.lineTo(x1 - r.left + (x0 === x1 && y0 === y1 ? 0.01 : 0), y1 - r.top);
		ctx.stroke();
	}

	private clearCanvas(): void {
		const r = this.rootRect;
		if (this.ctx && r) this.ctx.clearRect(0, 0, r.width, r.height);
		this.canvas.removeClass("is-drawing");
	}

	private releaseTimer: number | null = null;

	/** Outside ink mode (Pencil-always writing), free the canvas after a quiet spell. */
	private releaseLater(): void {
		if (this._active) return;
		if (this.releaseTimer !== null) window.clearTimeout(this.releaseTimer);
		this.releaseTimer = window.setTimeout(() => {
			this.releaseTimer = null;
			if (!this._active && !this.isDrawing) this.releaseCanvas();
		}, 10_000);
	}

	/** Free the canvas memory when ink mode is off. */
	private releaseCanvas(): void {
		this.canvas.width = 0;
		this.canvas.height = 0;
		this.ctx = null;
	}

	// ---------------------------------------------------------------- commit

	private commitStroke(s: Stroke): void {
		const store = this.host.store();
		const undo = this.host.undo();
		if (!store || !undo || !store.writable || s.pts.length < 2) return;
		const pts = roundPoints(simplify(dedupe(s.pts), TOL[s.tool]));
		const now = Date.now();
		const a: InkAnnotation = { id: uuid(), type: "ink", page: s.page, createdAt: now, updatedAt: now, deleted: false, tool: s.tool, color: s.color, width: s.width, points: pts };
		const edit = () => undo.record("ink", [a.id], () => store.upsert(a));
		if (this.host.quietly) this.host.quietly(edit);
		else edit();
		// append instead of re-rendering the whole page (pages may hold thousands of strokes)
		const layer = this.host.layers.getLayer(s.page);
		if (layer && layer.geom.rotation === s.geom.rotation) this.drawStroke(layer, a);
		else this.host.layers.refresh(s.page);
	}

	private pathsFor(id: string): HTMLElement[] {
		return Array.from(this.host.container.querySelectorAll<HTMLElement>(`.pendf-ink[data-id="${id}"]`));
	}

	private eraseAt(clientX: number, clientY: number): void {
		const er = this.erase;
		if (!er) return;
		let at = er.at;
		const inside = (r: DOMRect) => clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
		if (!at || !inside(at.rect)) {
			const div = this.pageAt(clientX, clientY);
			if (!div) return;
			const page = Number(div.dataset.pageNumber);
			const geom = this.host.layers.geometry(page);
			if (!geom) return;
			at = { page, div, rect: pageContentRect(div), geom };
			er.at = at;
		}
		const { page, geom, rect: pr } = at;
		const v = geom.clientToView(clientX, clientY, pr);
		const [x, y] = geom.toPdf(v[0], v[1]);
		const radius = ERASER_PX / (pr.width / geom.width);
		for (const a of er.strokes) {
			if (a.page !== page || er.hits.has(a.id)) continue;
			const r = radius + a.width / 2;
			if (x < a.box.x0 - r || x > a.box.x1 + r || y < a.box.y0 - r || y > a.box.y1 + r) continue;
			if (distanceToPolyline(x, y, a.points) <= r) {
				er.hits.add(a.id);
				for (const p of er.els.get(a.id) ?? []) p.classList.add("is-erased");
			}
		}
	}

	private commitErase(er: Erase): void {
		const store = this.host.store();
		const undo = this.host.undo();
		if (!store || !undo || er.hits.size === 0) return;
		const ids = [...er.hits];
		const edit = () =>
			undo.record("erase", ids, () => {
				for (const id of ids) store.remove(id);
			});
		if (this.host.quietly) this.host.quietly(edit);
		else edit();
		for (const id of ids) this.pathsFor(id).forEach((p) => p.remove());
		log.info(`erased ${ids.length} stroke(s)`);
	}

	destroy(): void {
		if (this.releaseTimer !== null) window.clearTimeout(this.releaseTimer);
		this.ac.abort();
		this.cancelGesture();
		this.releaseCanvas();
		this.canvas.remove();
	}
}
