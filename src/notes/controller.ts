// Phase 3 — text notes.
//
// A note hangs on a highlight (marker at the top-right of its first line) or
// on a point of the page. Tap a marker → popover with the rendered Markdown,
// edit and delete. "Add note" mode: the next tap on a page drops a point note
// there. Markers are drawn in the per-page SVG layer in PDF points, so they
// follow zoom and rotation like highlights.

import { type App, Component, MarkdownRenderer, setIcon } from "obsidian";
import { distance } from "../geometry";
import type { LayerManager, LayerRenderer, PageLayer } from "../layers";
import { pageContentRect, svgEl } from "../layers";
import type { HighlightAnnotation, NoteAnnotation } from "../store/schema";
import { uuid } from "../store/schema";
import type { SidecarStore } from "../store/sidecar";
import type { UndoStack } from "../store/undo";
import { logger } from "../util/log";
import { NoteEditorModal } from "./editor";
import { noteAnchor, noteForHighlight } from "./model";

const log = logger("notes");

/** marker radius in PDF points */
export const MARKER_R = 7;

export interface NoteHost {
	app: App;
	root: HTMLElement;
	container: HTMLElement;
	layers: LayerManager;
	store: () => SidecarStore | null;
	undo: () => UndoStack | null;
	/** vault path of the PDF, for resolving links inside notes */
	sourcePath: () => string;
	notice: (msg: string) => void;
	/** placing mode changed (toolbar button state) */
	onPlacingChange?: (on: boolean) => void;
	/** dismiss other floating UI (highlight palette/menu) */
	closeOthers?: () => void;
}

export class NoteController implements LayerRenderer {
	private ac = new AbortController();
	private popover: HTMLElement | null = null;
	private popoverComp: Component | null = null;
	private _placing = false;

	constructor(private readonly host: NoteHost) {
		host.layers.addRenderer(this);
		const sig = { signal: this.ac.signal };
		// capture: runs before the highlight controller's tap handling
		host.container.addEventListener("click", (e) => this.onClick(e), { capture: true, signal: this.ac.signal });
		host.container.addEventListener("scroll", () => this.closePopover(), { passive: true, signal: this.ac.signal });
		host.root.ownerDocument.addEventListener(
			"keydown",
			(e) => {
				if (e.key !== "Escape") return;
				this.closePopover();
				this.setPlacing(false);
			},
			sig,
		);
	}

	// ------------------------------------------------------------------ render

	renderPage(layer: PageLayer): void {
		const store = this.host.store();
		if (!store || !store.writable) return;
		const get = (id: string) => store.get(id);
		for (const a of store.all()) {
			if (a.type !== "note" || a.page !== layer.pageNumber) continue;
			const at = noteAnchor(a, get);
			if (!at) continue;
			const [x, y] = layer.geom.toView(at[0], at[1]);
			const g = svgEl("g", { class: "pendf-note", "data-id": a.id, transform: `translate(${x.toFixed(2)} ${y.toFixed(2)})` });
			g.appendChild(svgEl("circle", { r: MARKER_R }));
			// three text lines
			g.appendChild(svgEl("path", { d: "M-3.5 -2.5h7M-3.5 0h7M-3.5 2.5h4.5" }));
			layer.overlay.appendChild(g);
		}
	}

	// ----------------------------------------------------------------- input

	get placing(): boolean {
		return this._placing;
	}

	setPlacing(on: boolean): void {
		if (this._placing === on) return;
		const store = this.host.store();
		if (on && (!store || !store.writable)) {
			this.host.notice("penDF: annotations for this PDF are read-only (see the banner).");
			return;
		}
		this._placing = on;
		this.host.root.toggleClass("is-placing-note", on);
		this.host.onPlacingChange?.(on);
	}

	private onClick(e: MouseEvent): void {
		const target = e.target as HTMLElement | null;
		if (!target || target.closest("a, .pendf-floating, input, button, textarea")) return;
		if (this._placing) {
			const spot = this.pointAt(e.clientX, e.clientY);
			if (!spot) return;
			e.preventDefault();
			e.stopPropagation();
			this.setPlacing(false);
			this.createPointNote(spot.page, spot.x, spot.y);
			return;
		}
		const sel = this.host.root.ownerDocument.getSelection();
		if (sel && !sel.isCollapsed) return;
		const hit = this.hitTest(e.clientX, e.clientY);
		if (!hit) {
			this.closePopover();
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		this.host.closeOthers?.();
		this.openPopover(hit, e.clientX, e.clientY);
	}

	/** Page and PDF point under a client position. */
	pointAt(clientX: number, clientY: number): { page: number; x: number; y: number } | null {
		const pageDiv = this.pageDivAt(clientX, clientY);
		if (!pageDiv) return null;
		const page = Number(pageDiv.dataset.pageNumber);
		const geom = this.host.layers.geometry(page);
		if (!geom) return null;
		const v = geom.clientToView(clientX, clientY, pageContentRect(pageDiv));
		const [x, y] = geom.toPdf(v[0], v[1]);
		return { page, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
	}

	private pageDivAt(clientX: number, clientY: number): HTMLElement | null {
		const doc = this.host.root.ownerDocument;
		const pageDiv = doc
			.elementsFromPoint(clientX, clientY)
			.map((el) => el.closest<HTMLElement>(".page[data-page-number]"))
			.find((x) => !!x);
		return pageDiv && this.host.container.contains(pageDiv) ? pageDiv : null;
	}

	hitTest(clientX: number, clientY: number): NoteAnnotation | null {
		const store = this.host.store();
		if (!store || !store.writable) return null;
		const pageDiv = this.pageDivAt(clientX, clientY);
		if (!pageDiv) return null;
		const page = Number(pageDiv.dataset.pageNumber);
		const geom = this.host.layers.geometry(page);
		if (!geom) return null;
		const pt = geom.clientToView(clientX, clientY, pageContentRect(pageDiv));
		const get = (id: string) => store.get(id);
		const notes = store.all().filter((a): a is NoteAnnotation => a.type === "note" && a.page === page);
		for (let i = notes.length - 1; i >= 0; i--) {
			const at = noteAnchor(notes[i], get);
			if (at && distance(pt, geom.toView(at[0], at[1])) <= MARKER_R + 3) return notes[i];
		}
		return null;
	}

	// ------------------------------------------------------------------ edits

	private writable(): { store: SidecarStore; undo: UndoStack } | null {
		const store = this.host.store();
		const undo = this.host.undo();
		if (!store || !undo) return null;
		if (!store.writable) {
			this.host.notice("penDF: annotations for this PDF are read-only (see the banner).");
			return null;
		}
		return { store, undo };
	}

	/** Open the editor for a new note at a page point. */
	createPointNote(page: number, x: number, y: number, body?: string): string | null {
		if (body !== undefined) return this.insert({ page, target: { kind: "point", x, y } }, body);
		new NoteEditorModal(this.host.app, {
			title: `Note — page ${page}`,
			initial: "",
			onSave: (b) => void this.insert({ page, target: { kind: "point", x, y } }, b),
		}).open();
		return null;
	}

	/** Edit the highlight's note, or start one. */
	noteOnHighlight(h: HighlightAnnotation, body?: string): string | null {
		const store = this.host.store();
		if (!store) return null;
		const existing = noteForHighlight(store.all(), h.id);
		if (existing) {
			if (body !== undefined) return this.update(existing, body) ? existing.id : null;
			this.edit(existing);
			return existing.id;
		}
		const target = { kind: "highlight" as const, highlightId: h.id };
		if (body !== undefined) return this.insert({ page: h.page, target }, body);
		new NoteEditorModal(this.host.app, {
			title: `Note — page ${h.page}`,
			quote: h.text,
			initial: "",
			onSave: (b) => void this.insert({ page: h.page, target }, b),
		}).open();
		return null;
	}

	edit(note: NoteAnnotation): void {
		this.closePopover();
		const store = this.host.store();
		const h = note.target.kind === "highlight" ? store?.get(note.target.highlightId) : undefined;
		new NoteEditorModal(this.host.app, {
			title: `Note — page ${note.page}`,
			quote: h && h.type === "highlight" && !h.deleted ? h.text : undefined,
			initial: note.body,
			onSave: (b) => {
				if (b.trim() === "") this.remove(note);
				else this.update(note, b);
			},
			onDelete: () => this.remove(note),
		}).open();
	}

	private insert(at: Pick<NoteAnnotation, "page" | "target">, body: string): string | null {
		if (body.trim() === "") return null;
		const w = this.writable();
		if (!w) return null;
		const now = Date.now();
		const note: NoteAnnotation = { id: uuid(), type: "note", page: at.page, createdAt: now, updatedAt: now, deleted: false, body, target: at.target };
		w.undo.record("note", [note.id], () => w.store.upsert(note));
		log.info(`note on page ${note.page} (${note.target.kind})`);
		this.host.layers.refresh(note.page);
		return note.id;
	}

	private update(note: NoteAnnotation, body: string): boolean {
		const w = this.writable();
		if (!w) return false;
		const cur = w.store.get(note.id);
		if (!cur || cur.type !== "note" || cur.body === body) return false;
		w.undo.record("edit note", [note.id], () => w.store.upsert({ ...cur, body }));
		this.host.layers.refresh(note.page);
		return true;
	}

	remove(note: NoteAnnotation): void {
		const w = this.writable();
		if (!w) return;
		w.undo.record("delete note", [note.id], () => w.store.remove(note.id));
		this.closePopover();
		this.host.layers.refresh(note.page);
	}

	// ---------------------------------------------------------------- popover

	openPopover(note: NoteAnnotation, clientX: number, clientY: number): void {
		this.closePopover();
		const el = this.host.root.createDiv({ cls: "pendf-note-popover pendf-floating" });
		el.addEventListener("pointerdown", (e) => e.stopPropagation());
		const body = el.createDiv({ cls: "pendf-note-body markdown-rendered" });
		const comp = new Component();
		comp.load();
		this.popoverComp = comp;
		this.popover = el;
		// scroll only when the note is really taller than the box (sub-pixel overflow would show a scrollbar)
		void MarkdownRenderer.render(this.host.app, note.body, body, this.host.sourcePath(), comp).then(() => {
			body.toggleClass("is-scrollable", body.scrollHeight > body.clientHeight + 2);
		});
		const actions = el.createDiv({ cls: "pendf-note-actions" });
		const edit = actions.createEl("button", { cls: "pendf-icon-btn", attr: { "aria-label": "Edit note", title: "Edit note" } });
		setIcon(edit, "pencil");
		edit.addEventListener("click", () => this.edit(note));
		const del = actions.createEl("button", { cls: "pendf-icon-btn mod-warning", attr: { "aria-label": "Delete note", title: "Delete note" } });
		setIcon(del, "trash-2");
		del.addEventListener("click", () => this.remove(note));
		this.place(el, clientX, clientY);
	}

	private place(el: HTMLElement, clientX: number, clientY: number): void {
		const root = this.host.root.getBoundingClientRect();
		el.setCssProps({ "--pendf-x": "0px", "--pendf-y": "0px" });
		const w = el.offsetWidth;
		const h = el.offsetHeight;
		let left = clientX - root.left - w / 2;
		let top = clientY - root.top + 14;
		if (top + h > root.height - 4) top = clientY - root.top - h - 14;
		left = Math.max(4, Math.min(left, root.width - w - 4));
		top = Math.max(4, Math.min(top, root.height - h - 4));
		el.setCssProps({ "--pendf-x": `${Math.round(left)}px`, "--pendf-y": `${Math.round(top)}px` });
	}

	get popoverEl(): HTMLElement | null {
		return this.popover;
	}

	closePopover(): void {
		this.popoverComp?.unload();
		this.popoverComp = null;
		this.popover?.remove();
		this.popover = null;
	}

	destroy(): void {
		this.ac.abort();
		this.closePopover();
		this.setPlacing(false);
	}
}
