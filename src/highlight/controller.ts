// Phase 2 — text highlights.
//
// select text → palette appears next to the selection → pick a color →
// one highlight per page (pieces of a cross-page selection share a groupId).
// Tap a highlight → menu: recolor, copy text, delete. Undo/redo per document.

import { setIcon } from "obsidian";
import type { Quad, Rect } from "../geometry";
import { pointInPolygon } from "../geometry";
import type { LayerManager, LayerRenderer, PageLayer } from "../layers";
import { pageContentRect, svgEl } from "../layers";
import type { HighlightColor } from "../settings";
import type { HighlightAnnotation } from "../store/schema";
import { uuid } from "../store/schema";
import type { SidecarStore } from "../store/sidecar";
import type { UndoStack } from "../store/undo";
import { logger } from "../util/log";
import { mergeLineRects, normalizeText } from "./rects";
import { currentRange, piecesFromRange, type PagePiece } from "./selection";

const log = logger("highlight");

export interface HighlightHost {
	/** positioned ancestor that overlays (palette, menu) are placed in */
	root: HTMLElement;
	/** pdf.js scroll container */
	container: HTMLElement;
	layers: LayerManager;
	store: () => SidecarStore | null;
	undo: () => UndoStack | null;
	colors: () => HighlightColor[];
	defaultColor: () => number;
	notice: (msg: string) => void;
	copy: (text: string) => void;
}

interface PendingSelection {
	pieces: PagePiece[];
	/** client rect of the last selected line, for palette placement */
	anchor: DOMRect;
	first: DOMRect;
}

export class HighlightController implements LayerRenderer {
	private ac = new AbortController();
	private palette: HTMLElement | null = null;
	private menu: HTMLElement | null = null;
	private pending: PendingSelection | null = null;
	private selTimer: number | null = null;
	private selectedId: string | null = null;

	constructor(private readonly host: HighlightHost) {
		host.layers.addRenderer(this);
		const doc = host.root.ownerDocument;
		const sig = { signal: this.ac.signal };
		doc.addEventListener("selectionchange", () => this.onSelectionChange(), sig);
		host.container.addEventListener("click", (e) => this.onClick(e), sig);
		host.container.addEventListener("scroll", () => this.closeMenu(), { passive: true, signal: this.ac.signal });
		doc.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				this.hidePalette();
				this.closeMenu();
			}
		}, sig);
	}

	// ------------------------------------------------------------------ render

	renderPage(layer: PageLayer): void {
		const store = this.host.store();
		if (!store || !store.writable) return;
		for (const a of store.all()) {
			if (a.type !== "highlight" || a.page !== layer.pageNumber) continue;
			const g = svgEl("g", { class: "ppp-hl", "data-id": a.id });
			if (a.id === this.selectedId) g.classList.add("is-selected");
			for (const q of a.quads) {
				const pts = layer.geom.quadToViewPolygon(q);
				g.appendChild(svgEl("polygon", { points: pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" "), fill: a.color }));
			}
			layer.group.appendChild(g);
		}
	}

	// --------------------------------------------------------------- selection

	private onSelectionChange(): void {
		if (this.selTimer !== null) window.clearTimeout(this.selTimer);
		this.selTimer = window.setTimeout(() => {
			this.selTimer = null;
			this.captureSelection();
		}, 220);
	}

	private captureSelection(): void {
		const range = currentRange(this.host.container);
		if (!range) {
			this.pending = null;
			this.hidePalette();
			return;
		}
		const pieces = piecesFromRange(range, this.host.container);
		if (pieces.length === 0) {
			this.pending = null;
			this.hidePalette();
			return;
		}
		const lastRects = pieces[pieces.length - 1].rects;
		const anchor = lastRects[lastRects.length - 1];
		this.pending = { pieces, anchor, first: pieces[0].rects[0] };
		const store = this.host.store();
		if (store && store.writable) this.showPalette();
	}

	/** Turn the current selection into highlights. Returns the new ids. */
	createFromSelection(color?: string): string[] {
		// A live selection is the truth (the cache may lag by the debounce);
		// fall back to the cache when a tap already cleared it (iOS).
		if (currentRange(this.host.container) || !this.pending) this.captureSelection();
		const pending = this.pending;
		const store = this.host.store();
		const undo = this.host.undo();
		if (!pending || !store || !undo) return [];
		if (!store.writable) {
			this.host.notice("penDF: annotations for this PDF are read-only (see the banner).");
			return [];
		}
		const hex = color ?? this.host.colors()[this.host.defaultColor()]?.hex ?? "#ffd400";
		const groupId = pending.pieces.length > 1 ? uuid() : undefined;
		const now = Date.now();
		const made: HighlightAnnotation[] = [];
		for (const piece of pending.pieces) {
			const geom = this.host.layers.geometry(piece.pageNumber);
			if (!geom) continue;
			const pageRect = pageContentRect(piece.pageDiv);
			const viewRects: Rect[] = piece.rects.map((r) => geom.clientRectToView(r, pageRect));
			const lines = mergeLineRects(viewRects);
			if (lines.length === 0) continue;
			const quads: Quad[] = lines.map((r) => geom.viewRectToQuad(r).map((v) => Math.round(v * 1000) / 1000) as Quad);
			made.push({
				id: uuid(),
				type: "highlight",
				page: piece.pageNumber,
				createdAt: now,
				updatedAt: now,
				deleted: false,
				quads,
				color: hex,
				text: normalizeText(piece.text),
				...(groupId ? { groupId } : {}),
			});
		}
		if (made.length === 0) return [];
		undo.record("highlight", made.map((m) => m.id), () => {
			for (const m of made) store.upsert(m);
		});
		log.info(`created ${made.length} highlight(s) on page(s) ${made.map((m) => m.page).join(",")}`);
		this.host.root.ownerDocument.getSelection()?.removeAllRanges();
		this.pending = null;
		this.hidePalette();
		for (const m of made) this.host.layers.refresh(m.page);
		return made.map((m) => m.id);
	}

	private showPalette(): void {
		const p = this.pending;
		if (!p) return;
		if (!this.palette) {
			const el = this.host.root.createDiv({ cls: "ppp-palette ppp-floating" });
			// Keep the selection alive while the palette is touched: mouse/pen
			// down (desktop) and touchstart (iOS collapses the selection on
			// touchstart otherwise). With touchstart's default prevented iOS
			// sends no click, so swatches act on pointerup.
			el.addEventListener("pointerdown", (e) => e.preventDefault());
			el.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
			this.palette = el;
		}
		const el = this.palette;
		el.empty();
		this.host.colors().forEach((c) => {
			const b = el.createEl("button", { cls: "ppp-swatch", attr: { "aria-label": `Highlight ${c.name}`, title: c.name } });
			b.style.setProperty("--ppp-swatch", c.hex);
			const apply = (e: Event) => {
				e.preventDefault();
				e.stopPropagation();
				// pointerup and a later click both land here; the second finds
				// nothing selected and does nothing
				if (this.pending) this.createFromSelection(c.hex);
			};
			b.addEventListener("pointerup", apply);
			b.addEventListener("click", apply);
		});
		this.place(el, p.anchor, p.first);
	}

	hidePalette(): void {
		this.palette?.remove();
		this.palette = null;
	}

	/** Place a floating element below `below` (or above `above` if no room). */
	private place(el: HTMLElement, below: DOMRect, above: DOMRect): void {
		const root = this.host.root.getBoundingClientRect();
		el.style.left = "0px";
		el.style.top = "0px";
		const w = el.offsetWidth;
		const h = el.offsetHeight;
		const gap = 10;
		let left = below.right - root.left - w / 2;
		let top = below.bottom - root.top + gap;
		if (top + h > root.height - 4) top = above.top - root.top - h - gap;
		left = Math.max(4, Math.min(left, root.width - w - 4));
		top = Math.max(4, Math.min(top, root.height - h - 4));
		el.style.left = `${Math.round(left)}px`;
		el.style.top = `${Math.round(top)}px`;
	}

	// -------------------------------------------------------------------- tap

	private onClick(e: MouseEvent): void {
		const target = e.target as HTMLElement | null;
		if (!target || target.closest("a, .ppp-floating, input, button, textarea")) return;
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

	hitTest(clientX: number, clientY: number): HighlightAnnotation | null {
		const store = this.host.store();
		if (!store || !store.writable) return null;
		const doc = this.host.root.ownerDocument;
		const pageDiv = doc.elementsFromPoint(clientX, clientY).map((el) => el.closest<HTMLElement>(".page[data-page-number]")).find((x) => !!x);
		if (!pageDiv || !this.host.container.contains(pageDiv)) return null;
		const pageNumber = Number(pageDiv.dataset.pageNumber);
		const geom = this.host.layers.geometry(pageNumber);
		if (!geom) return null;
		const pt = geom.clientToView(clientX, clientY, pageContentRect(pageDiv));
		const list = store.all().filter((a): a is HighlightAnnotation => a.type === "highlight" && a.page === pageNumber);
		for (let i = list.length - 1; i >= 0; i--) {
			for (const q of list[i].quads) if (pointInPolygon(pt, geom.quadToViewPolygon(q), 1.5)) return list[i];
		}
		return null;
	}

	private group(a: HighlightAnnotation): HighlightAnnotation[] {
		const store = this.host.store();
		if (!store || !a.groupId) return [a];
		return store.all().filter((x): x is HighlightAnnotation => x.type === "highlight" && x.groupId === a.groupId);
	}

	private openMenu(a: HighlightAnnotation, clientX: number, clientY: number): void {
		this.closeMenu();
		this.hidePalette();
		this.setSelected(a.id);
		const el = this.host.root.createDiv({ cls: "ppp-hl-menu ppp-floating" });
		el.addEventListener("pointerdown", (e) => e.stopPropagation());
		this.menu = el;
		const swatches = el.createDiv({ cls: "ppp-hl-menu-colors" });
		for (const c of this.host.colors()) {
			const b = swatches.createEl("button", { cls: "ppp-swatch", attr: { "aria-label": `Change to ${c.name}`, title: c.name } });
			b.style.setProperty("--ppp-swatch", c.hex);
			if (c.hex.toLowerCase() === a.color.toLowerCase()) b.addClass("is-active");
			b.addEventListener("click", () => {
				this.recolor(a, c.hex);
				this.closeMenu();
			});
		}
		const actions = el.createDiv({ cls: "ppp-hl-menu-actions" });
		const copy = actions.createEl("button", { cls: "ppp-icon-btn", attr: { "aria-label": "Copy text", title: "Copy text" } });
		setIcon(copy, "copy");
		copy.addEventListener("click", () => {
			this.host.copy(this.group(a).map((x) => x.text).join(" "));
			this.closeMenu();
		});
		const del = actions.createEl("button", { cls: "ppp-icon-btn mod-warning", attr: { "aria-label": "Delete highlight", title: "Delete highlight" } });
		setIcon(del, "trash-2");
		del.addEventListener("click", () => {
			this.deleteHighlight(a);
			this.closeMenu();
		});
		const pt = new DOMRect(clientX, clientY, 0, 0);
		this.place(el, pt, pt);
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
			const a = x && store?.get(x);
			if (a) pages.add(a.page);
		}
		for (const p of pages) this.host.layers.refresh(p);
	}

	recolor(a: HighlightAnnotation, hex: string): void {
		const store = this.host.store();
		const undo = this.host.undo();
		if (!store || !undo || !store.writable) return;
		const members = this.group(a);
		undo.record("recolor", members.map((m) => m.id), () => {
			for (const m of members) store.upsert({ ...m, color: hex });
		});
		for (const m of members) this.host.layers.refresh(m.page);
	}

	deleteHighlight(a: HighlightAnnotation): void {
		const store = this.host.store();
		const undo = this.host.undo();
		if (!store || !undo || !store.writable) return;
		const members = this.group(a);
		undo.record("delete", members.map((m) => m.id), () => {
			for (const m of members) store.remove(m.id);
		});
		for (const m of members) this.host.layers.refresh(m.page);
	}

	destroy(): void {
		this.ac.abort();
		if (this.selTimer !== null) window.clearTimeout(this.selTimer);
		this.hidePalette();
		this.closeMenu();
	}
}
