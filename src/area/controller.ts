// Area excerpts in the view (Phase 7b, 0.8.0, D-44).
//
// With the "Area excerpt" tool on, any pointer — Pencil, finger, mouse — drags
// a rectangle on a page (the tool takes precedence over handwriting, note
// placing and finger scrolling while it is on; two fingers cancel the drag and
// pinch-zoom as usual). The area is stored as a PDF quad plus the text inside
// it; its image is rendered from the PDF when asked for. Tapping an area opens
// its menu: colour, note, link, copy / save image, delete (all undoable).

import { setIcon, setTooltip } from "obsidian";
import { pointInPolygon } from "../geometry";
import { pageContentRect, svgEl, type LayerManager, type LayerRenderer, type PageLayer } from "../layers";
import type { SidecarStore } from "../store/sidecar";
import type { UndoStack } from "../store/undo";
import { uuid, type AreaAnnotation } from "../store/schema";
import { notesForHighlights } from "../notes/model";
import { MIN_AREA_PX, dragRect, quadBox, textInBox, type TextItem } from "./model";
import type { PageGeometry } from "../geometry";

export interface AreaHost {
	root: HTMLElement;
	container: HTMLElement;
	layers: LayerManager;
	store(): SidecarStore | null;
	undo(): UndoStack | null;
	colors(): { name: string; hex: string }[];
	defaultColor(): number;
	notice(message: string): void;
	pageText(page: number): Promise<{ items: TextItem[]; joined: string }>;
	note(a: AreaAnnotation): void;
	copyLink(a: AreaAnnotation): void;
	copyImage(a: AreaAnnotation): Promise<boolean>;
	saveImage(a: AreaAnnotation): Promise<string | null>;
	/** the tool was switched on or off (toolbar button state, other tools off) */
	onActiveChange(on: boolean): void;
	/** colour of a new area (tool palette); default: the default highlight colour */
	areaColor?(): string;
	/** fingers drag areas too ("Everything writes" input); otherwise they scroll (D-46) */
	fingersDraw?(): boolean;
}

interface Drag {
	pointerId: number;
	page: number;
	pageDiv: HTMLElement;
	geom: PageGeometry;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	live: HTMLElement;
}

export class AreaController implements LayerRenderer {
	private _active = false;
	private drag: Drag | null = null;
	private menu: HTMLElement | null = null;
	private selectedId: string | null = null;
	private ac = new AbortController();

	constructor(private readonly host: AreaHost) {
		host.layers.addRenderer(this);
		const c = host.container;
		const sig = { signal: this.ac.signal };
		c.addEventListener("pointerdown", (e) => this.onDown(e), { capture: true, signal: this.ac.signal });
		c.addEventListener("pointermove", (e) => this.onMove(e), { capture: true, signal: this.ac.signal });
		c.addEventListener("pointerup", (e) => void this.onUp(e, false), { capture: true, signal: this.ac.signal });
		c.addEventListener("pointercancel", (e) => void this.onUp(e, true), { capture: true, signal: this.ac.signal });
		c.addEventListener("click", (e) => this.onClick(e), sig);
		c.addEventListener("scroll", () => this.closeMenu(), { passive: true, signal: this.ac.signal });
		// iPadOS: cancel the Pencil's touchstart so it drags an area instead of scrolling (fingers still scroll)
		c.addEventListener(
			"touchstart",
			(e) => {
				if (!this._active) return;
				if (Array.from(e.changedTouches).some((t) => (t as Touch & { touchType?: string }).touchType === "stylus")) e.preventDefault();
			},
			{ passive: false, capture: true, signal: this.ac.signal },
		);
		host.root.ownerDocument.addEventListener(
			"keydown",
			(e) => {
				if (e.key === "Escape") {
					this.closeMenu();
					if (this._active) this.setActive(false);
				}
			},
			sig,
		);
	}

	get active(): boolean {
		return this._active;
	}

	get isDrawing(): boolean {
		return this.drag !== null;
	}

	setActive(on: boolean): void {
		if (this._active === on) return;
		if (on && !this.writable()) {
			this.host.notice("penDF: annotations for this PDF are read-only (see the banner).");
			return;
		}
		this._active = on;
		if (!on) this.cancelDrag();
		this.host.root.toggleClass("is-area-tool", on);
		this.host.onActiveChange(on);
	}

	// ------------------------------------------------------------------ render

	renderPage(layer: PageLayer): void {
		const store = this.host.store();
		if (!store || !store.writable) return;
		for (const a of store.all()) {
			if (a.type !== "area" || a.deleted || a.page !== layer.pageNumber) continue;
			const pts = layer.geom.quadToViewPolygon(a.quad);
			const g = svgEl("g", { class: "pendf-area", "data-id": a.id });
			if (a.id === this.selectedId) g.classList.add("is-selected");
			g.appendChild(svgEl("polygon", { class: "pendf-area-fill", points: pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" "), fill: a.color }));
			layer.group.appendChild(g);
			const outline = svgEl("polygon", { class: "pendf-area-outline", "data-id": a.id, points: pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" "), stroke: a.color });
			layer.overlay.appendChild(outline);
		}
	}

	// ------------------------------------------------------------------- input

	private writable(): { store: SidecarStore; undo: UndoStack } | null {
		const store = this.host.store();
		const undo = this.host.undo();
		return store && undo && store.writable ? { store, undo } : null;
	}

	private pageAt(clientX: number, clientY: number): HTMLElement | null {
		const el = this.host.root.ownerDocument
			.elementsFromPoint(clientX, clientY)
			.map((x) => x.closest<HTMLElement>(".page[data-page-number]"))
			.find((x) => !!x);
		return el && this.host.container.contains(el) ? el : null;
	}

	private onDown(e: PointerEvent): void {
		if (!this._active) return;
		if (this.drag) {
			// a second finger: it is a pinch, not an area
			if (e.pointerId !== this.drag.pointerId) this.cancelDrag();
			return;
		}
		if (e.pointerType === "mouse" && e.button !== 0) return;
		// fingers keep scrolling and selecting unless "Everything writes" is on (D-46)
		if (e.pointerType === "touch" && this.host.fingersDraw && !this.host.fingersDraw()) return;
		if ((e.target as HTMLElement | null)?.closest(".pendf-floating, a, button, input")) return;
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
			// synthetic pointer
		}
		this.closeMenu();
		const live = this.host.root.createDiv({ cls: "pendf-area-live" });
		this.drag = { pointerId: e.pointerId, page, pageDiv, geom, x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, live };
		this.drawLive();
	}

	private onMove(e: PointerEvent): void {
		const d = this.drag;
		if (!d || e.pointerId !== d.pointerId) return;
		e.preventDefault();
		e.stopPropagation();
		d.x1 = e.clientX;
		d.y1 = e.clientY;
		this.drawLive();
	}

	private drawLive(): void {
		const d = this.drag;
		if (!d) return;
		const r = this.host.root.getBoundingClientRect();
		const pr = pageContentRect(d.pageDiv);
		const x0 = Math.max(pr.left, Math.min(pr.right, Math.min(d.x0, d.x1)));
		const x1 = Math.max(pr.left, Math.min(pr.right, Math.max(d.x0, d.x1)));
		const y0 = Math.max(pr.top, Math.min(pr.bottom, Math.min(d.y0, d.y1)));
		const y1 = Math.max(pr.top, Math.min(pr.bottom, Math.max(d.y0, d.y1)));
		d.live.setCssProps({ "--pendf-x": `${x0 - r.left}px`, "--pendf-y": `${y0 - r.top}px`, "--pendf-w": `${x1 - x0}px`, "--pendf-h": `${y1 - y0}px` });
	}

	private cancelDrag(): void {
		this.drag?.live.remove();
		this.drag = null;
	}

	private async onUp(e: PointerEvent, cancelled: boolean): Promise<void> {
		const d = this.drag;
		if (!d || e.pointerId !== d.pointerId) return;
		e.preventDefault();
		e.stopPropagation();
		d.x1 = e.clientX;
		d.y1 = e.clientY;
		this.cancelDrag();
		if (cancelled) return;
		const pr = pageContentRect(d.pageDiv);
		const a = d.geom.clientToView(d.x0, d.y0, pr);
		const b = d.geom.clientToView(d.x1, d.y1, pr);
		const rect = dragRect(a[0], a[1], b[0], b[1], d.geom.width, d.geom.height);
		// measured in screen px, so the threshold does not depend on the zoom
		const sx = pr.width / d.geom.width;
		if (rect.w * sx < MIN_AREA_PX || rect.h * sx < MIN_AREA_PX) {
			const hit = this.hitTest(e.clientX, e.clientY);
			if (hit) this.openMenu(hit, e.clientX, e.clientY);
			return;
		}
		const quad = d.geom.viewRectToQuad(rect);
		const id = await this.create(d.page, quad);
		const created = id ? this.host.store()?.get(id) : undefined;
		if (created && created.type === "area") {
			const r = d.pageDiv.getBoundingClientRect();
			this.openMenu(created, Math.min(Math.max(d.x0, d.x1), r.right), Math.max(d.y0, d.y1));
		}
	}

	/** Create an area on `page` (also the API for tests and commands). */
	async create(page: number, quad: AreaAnnotation["quad"], opts: { color?: string; label?: string } = {}): Promise<string | null> {
		const w = this.writable();
		if (!w) return null;
		let text = "";
		try {
			const t = await this.host.pageText(page);
			text = textInBox(t.items, t.joined, quadBox(quad));
		} catch {
			// no text layer: an image-only page
		}
		const now = Date.now();
		const colors = this.host.colors();
		const color = opts.color ?? this.host.areaColor?.() ?? colors[this.host.defaultColor()]?.hex ?? "#2ea8e5";
		const a: AreaAnnotation = { id: uuid(), type: "area", page, createdAt: now, updatedAt: now, deleted: false, quad: quad.map((v) => Math.round(v * 100) / 100) as AreaAnnotation["quad"], color, text };
		if (opts.label) a.label = opts.label;
		w.undo.record("area", [a.id], () => w.store.upsert(a));
		this.host.layers.refresh(page);
		return a.id;
	}

	private onClick(e: MouseEvent): void {
		if (this._active || e.defaultPrevented) return;
		const target = e.target as HTMLElement | null;
		if (!target || target.closest("a, .pendf-floating, input, button, textarea")) return;
		const sel = this.host.root.ownerDocument.getSelection();
		if (sel && !sel.isCollapsed) return;
		const hit = this.hitTest(e.clientX, e.clientY);
		if (!hit) {
			this.closeMenu();
			return;
		}
		e.preventDefault();
		this.openMenu(hit, e.clientX, e.clientY);
	}

	hitTest(clientX: number, clientY: number): AreaAnnotation | null {
		const store = this.host.store();
		if (!store || !store.writable) return null;
		const pageDiv = this.pageAt(clientX, clientY);
		if (!pageDiv) return null;
		const page = Number(pageDiv.dataset.pageNumber);
		const geom = this.host.layers.geometry(page);
		if (!geom) return null;
		const pt = geom.clientToView(clientX, clientY, pageContentRect(pageDiv));
		const list = store.all().filter((a): a is AreaAnnotation => a.type === "area" && !a.deleted && a.page === page);
		for (let i = list.length - 1; i >= 0; i--) if (pointInPolygon(pt, geom.quadToViewPolygon(list[i].quad), 1.5)) return list[i];
		return null;
	}

	// -------------------------------------------------------------------- menu

	openMenu(a: AreaAnnotation, clientX: number, clientY: number): void {
		this.closeMenu();
		this.setSelected(a.id);
		const el = this.host.root.createDiv({ cls: "pendf-hl-menu pendf-area-menu pendf-floating" });
		el.addEventListener("pointerdown", (e) => e.stopPropagation());
		this.menu = el;
		const swatches = el.createDiv({ cls: "pendf-hl-menu-colors" });
		for (const c of this.host.colors()) {
			const b = swatches.createEl("button", { cls: "pendf-swatch", attr: { "aria-label": `Change to ${c.name}` } });
			setTooltip(b, c.name);
			b.style.setProperty("--pendf-swatch", c.hex);
			if (c.hex.toLowerCase() === a.color.toLowerCase()) b.addClass("is-active");
			b.addEventListener("click", () => {
				this.recolor(a, c.hex);
				this.closeMenu();
			});
		}
		const actions = el.createDiv({ cls: "pendf-hl-menu-actions" });
		const store = this.host.store();
		const hasNote = !!store && notesForHighlights(store.all(), [a.id]).length > 0;
		const btn = (icon: string, label: string, run: () => void, warn = false) => {
			const b = actions.createEl("button", { cls: `pendf-icon-btn${warn ? " mod-warning" : ""}`, attr: { "aria-label": label, "data-action": icon } });
			setTooltip(b, label);
			setIcon(b, icon);
			b.addEventListener("click", () => {
				this.closeMenu();
				run();
			});
		};
		btn(hasNote ? "message-square" : "message-square-plus", hasNote ? "Edit note" : "Add note", () => this.host.note(a));
		btn("link", "Copy link", () => this.host.copyLink(a));
		btn("image", "Copy image", () => void this.copyImage(a));
		btn("download", "Save image", () => void this.host.saveImage(a));
		btn("trash-2", "Delete area", () => this.deleteArea(a), true);
		const root = this.host.root.getBoundingClientRect();
		el.setCssProps({ "--pendf-x": "0px", "--pendf-y": "0px" });
		const w = el.offsetWidth;
		const h = el.offsetHeight;
		let left = clientX - root.left - w / 2;
		let top = clientY - root.top + 12;
		if (top + h > root.height - 4) top = clientY - root.top - h - 12;
		left = Math.max(4, Math.min(left, root.width - w - 4));
		top = Math.max(4, Math.min(top, root.height - h - 4));
		el.setCssProps({ "--pendf-x": `${Math.round(left)}px`, "--pendf-y": `${Math.round(top)}px` });
	}

	private async copyImage(a: AreaAnnotation): Promise<void> {
		const ok = await this.host.copyImage(a);
		if (!ok) this.host.notice("penDF: copying images is not available here — use “Save image” instead.");
	}

	get menuEl(): HTMLElement | null {
		return this.menu;
	}

	closeMenu(): void {
		if (!this.menu) return;
		this.menu.remove();
		this.menu = null;
		this.setSelected(null);
	}

	private setSelected(id: string | null): void {
		const prev = this.selectedId;
		this.selectedId = id;
		const store = this.host.store();
		const pages = new Set<number>();
		for (const x of [prev, id]) {
			const a = x ? store?.get(x) : undefined;
			if (a) pages.add(a.page);
		}
		for (const p of pages) this.host.layers.refresh(p);
	}

	recolor(a: AreaAnnotation, hex: string): void {
		const w = this.writable();
		if (!w) return;
		const cur = w.store.get(a.id);
		if (!cur || cur.type !== "area") return;
		w.undo.record("recolor area", [a.id], () => w.store.upsert({ ...cur, color: hex }));
		this.host.layers.refresh(a.page);
	}

	deleteArea(a: AreaAnnotation): void {
		const w = this.writable();
		if (!w) return;
		const notes = notesForHighlights(w.store.all(), [a.id]);
		w.undo.record("delete area", [a.id, ...notes.map((n) => n.id)], () => {
			w.store.remove(a.id);
			for (const n of notes) w.store.remove(n.id);
		});
		this.host.layers.refresh(a.page);
		for (const n of notes) if (n.page !== a.page) this.host.layers.refresh(n.page);
	}

	destroy(): void {
		this.ac.abort();
		this.cancelDrag();
		this.closeMenu();
	}
}
