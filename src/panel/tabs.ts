// Panel tab contents, shared by the Obsidian sidebar panel (AnnotationsView) and
// the panel inside the penDF view (InViewPanel). 0.8.0.
//
// Tabs are registered (registerPanelTab) so later features — notebook, cards —
// can add their own tab to both panels without touching this file's callers.
//   Outline      the PDF's own bookmarks (read-only; the PDF is never modified)
//   Pages        page thumbnails (only the visible ones are drawn)
//   Search       every match in the document, with context
//   Bookmarks    your bookmarks: jump, rename, reorder, copy link, delete
//   Annotations  highlights (with their note), notes and area excerpts, page by page

import { Component, MarkdownRenderer, setIcon, setTooltip, type App } from "obsidian";
import { panelPages, type PanelItem } from "../notes/model";
import type { Annotation, BookmarkAnnotation } from "../store/schema";
import { aliasFrom } from "../links/format";
import type { OutlineNode, PenDFView, SearchHit } from "../view/PdfView";
import { currentOutlineKey, outlineKey } from "./outline";

export type PanelTab = "outline" | "pages" | "search" | "bookmarks" | "annotations" | (string & {});

export interface PanelHost {
	readonly app: App;
	/** the penDF view the panel shows */
	view(): PenDFView | null;
	/** element that scrolls the tab body (thumbnail visibility is measured against it) */
	scrollRoot(): HTMLElement;
	/** called before a panel item navigates the view (focus that tab; close an overlay) */
	willNavigate(view: PenDFView): void;
	/** the shown tab changed (persist it) */
	onTabChange(tab: PanelTab): void;
}

export interface TabContext {
	host: PanelHost;
	view: PenDFView;
	body: HTMLElement;
	/** owns Markdown render children; unloaded on the next render */
	comp: Component;
	/** false once a newer render started (async renderers stop) */
	alive(): boolean;
	/** run when the tab is re-rendered or the panel closes */
	onCleanup(fn: () => void): void;
	/** survives re-renders of the same panel (e.g. the search query) */
	state: Record<string, unknown>;
	/** navigate the view (focus / close overlay first) */
	go(fn: () => void): void;
}

export interface PanelTabDef {
	id: PanelTab;
	label: string;
	icon: string;
	/** only for an open PDF; without one the panel shows a hint */
	render(ctx: TabContext): void | Promise<void>;
}

const registry: PanelTabDef[] = [];

/** Add a tab to both panels (order of registration = order of the tab bar). */
export function registerPanelTab(def: PanelTabDef): void {
	const i = registry.findIndex((t) => t.id === def.id);
	if (i >= 0) registry[i] = def;
	else registry.push(def);
}

export function panelTabs(): readonly PanelTabDef[] {
	return registry;
}

export function isPanelTab(v: unknown): v is PanelTab {
	return typeof v === "string" && registry.some((t) => t.id === v);
}

/** Tab bar + body for one panel. */
export class PanelContent {
	private seq = 0;
	private comp: Component | null = null;
	private cleanups: (() => void)[] = [];
	private readonly state: Record<string, unknown> = {};

	constructor(
		private readonly host: PanelHost,
		private readonly el: HTMLElement,
		public tab: PanelTab = "annotations",
	) {}

	showTab(tab: PanelTab): void {
		if (!isPanelTab(tab)) return;
		const changed = this.tab !== tab;
		this.tab = tab;
		if (changed) this.host.onTabChange(tab);
		this.render();
	}

	private runCleanups(): void {
		for (const fn of this.cleanups.splice(0)) {
			try {
				fn();
			} catch {
				// best effort
			}
		}
	}

	render(): void {
		const seq = ++this.seq;
		this.runCleanups();
		const el = this.el;
		el.empty();
		this.comp?.unload();
		const comp = new Component();
		comp.load();
		this.comp = comp;
		if (!isPanelTab(this.tab)) this.tab = "annotations";

		const tabs = el.createDiv({ cls: "pendf-panel-tabs", attr: { role: "tablist" } });
		for (const t of registry) {
			const b = tabs.createEl("button", { cls: "pendf-panel-tab clickable-icon", attr: { "aria-label": t.label, "data-tab": t.id, role: "tab" } });
			setTooltip(b, t.label);
			setIcon(b, t.icon);
			b.createSpan({ cls: "pendf-panel-tab-label", text: t.label });
			if (t.id === this.tab) {
				b.addClass("is-active");
				b.setAttribute("aria-selected", "true");
			}
			b.addEventListener("click", () => this.showTab(t.id));
		}

		const view = this.host.view();
		if (!view || !view.file) {
			el.createDiv({ cls: "pendf-panel-empty", text: "Open a PDF in penDF to see its outline, bookmarks, highlights and notes here." });
			return;
		}
		el.createDiv({ cls: "pendf-panel-title", text: view.file.basename });
		const body = el.createDiv({ cls: `pendf-panel-body is-${this.tab}` });
		const def = registry.find((t) => t.id === this.tab);
		if (!def) return;
		const ctx: TabContext = {
			host: this.host,
			view,
			body,
			comp,
			alive: () => seq === this.seq,
			onCleanup: (fn) => this.cleanups.push(fn),
			state: this.state,
			go: (fn) => {
				this.host.willNavigate(view);
				fn();
			},
		};
		void def.render(ctx);
	}

	destroy(): void {
		this.seq++;
		this.runCleanups();
		this.comp?.unload();
		this.comp = null;
		this.el.empty();
	}
}

// ------------------------------------------------------------------- outline

registerPanelTab({ id: "outline", label: "Outline", icon: "list-tree", render: renderOutline });

async function renderOutline(ctx: TabContext): Promise<void> {
	const { body, view } = ctx;
	const loading = body.createDiv({ cls: "pendf-panel-empty", text: "Loading outline…" });
	const nodes = await view.outline();
	if (!ctx.alive()) return;
	loading.remove();
	if (nodes.length === 0) {
		body.createDiv({ cls: "pendf-panel-empty", text: "This PDF has no outline. Add your own bookmarks in the Bookmarks tab." });
		return;
	}
	const remembered = view.outlineOpenKeys();
	const tree = body.createDiv({ cls: "pendf-outline" });
	const rows = new Map<string, { item: HTMLElement; row: HTMLElement; parent: string | null }>();
	const saveOpen = () => view.setOutlineOpenKeys([...rows.entries()].filter(([, r]) => r.item.hasClass("is-open")).map(([k]) => k));
	const add = (parentEl: HTMLElement, list: OutlineNode[], path: number[], parentKey: string | null) => {
		list.forEach((n, i) => {
			const key = outlineKey([...path, i]);
			const item = parentEl.createDiv({ cls: "pendf-outline-item", attr: { "data-key": key } });
			const row = item.createDiv({ cls: "pendf-outline-row", attr: { tabindex: "0" } });
			row.setCssProps({ "--pendf-depth": String(n.depth) });
			rows.set(key, { item, row, parent: parentKey });
			let kids: HTMLElement | null = null;
			const toggle = row.createSpan({ cls: "pendf-outline-toggle" });
			if (n.items.length) {
				setIcon(toggle, "chevron-right");
				kids = item.createDiv({ cls: "pendf-outline-children" });
				item.toggleClass("is-open", remembered ? remembered.has(key) : n.depth < 1);
				toggle.setAttribute("aria-label", "Expand or collapse");
				toggle.addEventListener("click", (e) => {
					e.stopPropagation();
					item.toggleClass("is-open", !item.hasClass("is-open"));
					saveOpen();
					markCurrent();
				});
			}
			row.createSpan({ cls: "pendf-outline-title", text: n.title });
			if (n.page !== null) row.createSpan({ cls: "pendf-outline-page", text: String(n.page) });
			const go = () => ctx.go(() => view.goToOutline(n));
			row.addEventListener("click", go);
			row.addEventListener("keydown", (e) => {
				if (e.key === "Enter") go();
			});
			if (kids) add(kids, n.items, [...path, i], key);
		});
	};
	add(tree, nodes, [], null);
	// the chapter / section the reader is in; when it is folded away, its nearest visible ancestor
	const markCurrent = () => {
		tree.querySelectorAll(".pendf-outline-row.is-current").forEach((r) => r.removeClass("is-current"));
		let key = currentOutlineKey(nodes, view.currentPage);
		while (key) {
			const r = rows.get(key);
			if (!r) break;
			let hidden = false;
			for (let p = r.parent; p; p = rows.get(p)?.parent ?? null) if (!rows.get(p)?.item.hasClass("is-open")) hidden = true;
			if (!hidden) {
				r.row.addClass("is-current");
				break;
			}
			key = r.parent;
		}
	};
	markCurrent();
	tree.querySelector(".pendf-outline-row.is-current")?.scrollIntoView({ block: "nearest" });
	ctx.onCleanup(view.onPageChange(() => markCurrent()));
}

// --------------------------------------------------------------------- pages

registerPanelTab({ id: "pages", label: "Pages", icon: "layout-grid", render: renderPages });

const THUMB = 104;

function renderPages(ctx: TabContext): void {
	const { body, view, host } = ctx;
	const n = view.pageCount;
	if (!n) {
		body.createDiv({ cls: "pendf-panel-empty", text: "Loading…" });
		return;
	}
	const counts = view.annotationCountsByPage();
	const grid = body.createDiv({ cls: "pendf-thumbs" });
	const cells: HTMLElement[] = [];
	const live = new Map<number, { cancel: () => void }>();
	const queue: number[] = [];
	let running = false;
	const pump = () => {
		if (running) return;
		const page = queue.shift();
		if (page === undefined) return;
		const cell = cells[page - 1];
		if (!cell || !cell.hasClass("is-visible") || cell.hasClass("is-rendered")) {
			pump();
			return;
		}
		running = true;
		const frame = cell.querySelector<HTMLElement>(".pendf-thumb-frame") ?? cell;
		const canvas = frame.querySelector("canvas") ?? frame.createEl("canvas", { cls: "pendf-thumb-canvas" });
		const job = view.renderThumbnail(page, canvas, THUMB);
		live.set(page, job);
		void job.done.then((ok) => {
			live.delete(page);
			if (ok) cell.addClass("is-rendered");
			running = false;
			pump();
		});
	};
	const release = (page: number) => {
		const cell = cells[page - 1];
		live.get(page)?.cancel();
		live.delete(page);
		const canvas = cell?.querySelector("canvas");
		if (canvas) view.releaseThumbnail(canvas);
		cell?.removeClass("is-rendered");
	};
	for (let page = 1; page <= n; page++) {
		const cell = grid.createDiv({ cls: "pendf-thumb", attr: { "data-page": String(page), tabindex: "0", "aria-label": `Page ${page}` } });
		const frame = cell.createDiv({ cls: "pendf-thumb-frame" });
		frame.setCssProps({ "--pendf-thumb-h": `${Math.round(THUMB * view.pageAspect(page))}px`, "--pendf-thumb-w": `${THUMB}px` });
		const label = cell.createDiv({ cls: "pendf-thumb-label", text: String(page) });
		const c = counts.get(page);
		if (c) label.createSpan({ cls: "pendf-thumb-badge", text: String(c), attr: { "aria-label": `${c} annotation(s)` } });
		if (page === view.currentPage) cell.addClass("is-current");
		const go = () => ctx.go(() => view.goToPage(page));
		cell.addEventListener("click", go);
		cell.addEventListener("keydown", (e) => {
			if (e.key === "Enter") go();
		});
		cells.push(cell);
	}
	// draw only what is (nearly) visible; free canvases off screen
	const io = new IntersectionObserver(
		(entries) => {
			for (const e of entries) {
				const page = Number((e.target as HTMLElement).dataset.page);
				if (e.isIntersecting) {
					e.target.addClass("is-visible");
					queue.push(page);
				} else {
					e.target.removeClass("is-visible");
					release(page);
				}
			}
			pump();
		},
		{ root: host.scrollRoot(), rootMargin: "300px 0px" },
	);
	for (const cell of cells) io.observe(cell);
	// the current page is marked and kept in view while reading
	const offPage = view.onPageChange((page) => {
		grid.querySelector(".pendf-thumb.is-current")?.removeClass("is-current");
		const cell = cells[page - 1];
		if (!cell) return;
		cell.addClass("is-current");
		const r = cell.getBoundingClientRect();
		const pr = host.scrollRoot().getBoundingClientRect();
		if (r.bottom < pr.top || r.top > pr.bottom) cell.scrollIntoView({ block: "nearest" });
	});
	ctx.onCleanup(() => {
		io.disconnect();
		offPage();
		for (let p = 1; p <= cells.length; p++) release(p);
	});
	window.setTimeout(() => cells[view.currentPage - 1]?.scrollIntoView({ block: "center" }), 0);
}

// -------------------------------------------------------------------- search

registerPanelTab({ id: "search", label: "Search", icon: "search", render: renderSearch });

function renderSearch(ctx: TabContext): void {
	const { body, view } = ctx;
	const form = body.createDiv({ cls: "pendf-search-panel" });
	const input = form.createEl("input", { cls: "pendf-search-panel-input", attr: { type: "search", placeholder: "Search this PDF…", "aria-label": "Search this PDF" } });
	input.value = typeof ctx.state.searchQuery === "string" ? ctx.state.searchQuery : "";
	const status = body.createDiv({ cls: "pendf-panel-empty pendf-search-status" });
	const list = body.createDiv({ cls: "pendf-search-results" });
	let ac: AbortController | null = null;
	let timer: number | null = null;
	const run = () => {
		ac?.abort();
		list.empty();
		const q = input.value.trim();
		ctx.state.searchQuery = input.value;
		if (q.length < 2) {
			status.setText(q ? "Type at least 2 characters." : "Find words in the whole document.");
			return;
		}
		const mine = new AbortController();
		ac = mine;
		let total = 0;
		let pages = 0;
		status.setText("Searching…");
		void view
			.searchAll(q, {
				signal: mine.signal,
				onHits: (hits) => {
					if (mine.signal.aborted) return;
					pages++;
					total += hits.length;
					renderHits(ctx, list, hits);
				},
				onProgress: (page, all) => {
					if (!mine.signal.aborted && page % 10 === 0) status.setText(`Searching… page ${page} of ${all} — ${total} found`);
				},
			})
			.then((n) => {
				if (mine.signal.aborted) return;
				status.setText(n === 0 ? "No matches." : `${n}${n >= 500 ? "+" : ""} match${n === 1 ? "" : "es"} on ${pages} page${pages === 1 ? "" : "s"}`);
			});
	};
	input.addEventListener("input", () => {
		if (timer !== null) window.clearTimeout(timer);
		timer = window.setTimeout(run, 250);
	});
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			if (timer !== null) window.clearTimeout(timer);
			run();
		}
	});
	ctx.onCleanup(() => {
		ac?.abort();
		if (timer !== null) window.clearTimeout(timer);
	});
	run();
	window.setTimeout(() => input.focus(), 0);
}

function renderHits(ctx: TabContext, list: HTMLElement, hits: SearchHit[]): void {
	const section = list.createDiv({ cls: "pendf-panel-page" });
	section.createDiv({ cls: "pendf-panel-page-title", text: `Page ${hits[0].page}` });
	for (const h of hits) {
		const row = section.createDiv({ cls: "pendf-search-hit", attr: { tabindex: "0" } });
		row.appendText((h.before.length >= 40 ? "…" : "") + h.before);
		row.createEl("mark", { text: h.match });
		row.appendText(h.after + (h.after.length >= 60 ? "…" : ""));
		const go = () => ctx.go(() => ctx.view.revealHit(h));
		row.addEventListener("click", go);
		row.addEventListener("keydown", (e) => {
			if (e.key === "Enter") go();
		});
	}
}

// ----------------------------------------------------------------- bookmarks

registerPanelTab({ id: "bookmarks", label: "Bookmarks", icon: "bookmark", render: renderBookmarks });

function renderBookmarks(ctx: TabContext): void {
	const { body, view } = ctx;
	const add = body.createEl("button", { cls: "pendf-panel-add" });
	setIcon(add.createSpan({ cls: "pendf-panel-add-icon" }), "bookmark-plus");
	add.createSpan({ text: "Bookmark the top of the view" });
	add.addEventListener("click", () => void view.addBookmark());
	const list = view.bookmarks();
	if (list.length === 0) {
		body.createDiv({ cls: "pendf-panel-empty", text: "No bookmarks yet." });
		return;
	}
	list.forEach((b, i) => renderBookmark(ctx, body, b, i, list.length));
}

function renderBookmark(ctx: TabContext, parent: HTMLElement, b: BookmarkAnnotation, index: number, count: number): void {
	const { view } = ctx;
	const row = parent.createDiv({ cls: "pendf-bookmark", attr: { "data-id": b.id } });
	const main = row.createDiv({ cls: "pendf-bookmark-main", attr: { tabindex: "0" } });
	main.createSpan({ cls: "pendf-bookmark-title", text: b.title });
	main.createSpan({ cls: "pendf-bookmark-page", text: `p. ${b.page}` });
	const go = () => ctx.go(() => view.revealAnnotation(b));
	main.addEventListener("click", go);
	main.addEventListener("keydown", (e) => {
		if (e.key === "Enter") go();
	});
	const actions = row.createDiv({ cls: "pendf-bookmark-actions" });
	const btn = (icon: string, label: string, fn: () => void, disabled = false, warn = false) => {
		const el = actions.createEl("button", { cls: `clickable-icon pendf-bookmark-btn${warn ? " is-danger" : ""}`, attr: { "aria-label": label } });
		setTooltip(el, label);
		setIcon(el, icon);
		if (disabled) el.disabled = true;
		el.addEventListener("click", (e) => {
			e.stopPropagation();
			fn();
		});
	};
	btn("arrow-up", "Move up", () => view.moveBookmark(b.id, index - 1), index === 0);
	btn("arrow-down", "Move down", () => view.moveBookmark(b.id, index + 1), index === count - 1);
	btn("pencil", "Rename", () => void view.renameBookmark(b));
	btn("link", "Copy link", () => view.copyLink({ page: b.page, id: b.id }, aliasFrom(b.title) || `p. ${b.page}`));
	btn("trash-2", "Delete", () => view.deleteBookmark(b), false, true);
}

// --------------------------------------------------------------- annotations

registerPanelTab({ id: "annotations", label: "Annotations", icon: "highlighter", render: renderAnnotations });

function renderAnnotations(ctx: TabContext): void {
	const { body, view } = ctx;
	const pages = panelPages(view.annotations());
	if (pages.length === 0) {
		body.createDiv({ cls: "pendf-panel-empty", text: "No highlights or notes yet. Select text to highlight it, or use “Add note” in the toolbar." });
		return;
	}
	const src = view.file?.path ?? "";
	for (const p of pages) {
		const section = body.createDiv({ cls: "pendf-panel-page" });
		section.createDiv({ cls: "pendf-panel-page-title", text: `Page ${p.page}` });
		for (const item of p.items) renderItem(ctx, section, item, src);
	}
}

function renderItem(ctx: TabContext, parent: HTMLElement, item: PanelItem, src: string): void {
	const { view, comp, host } = ctx;
	const a = item.annotation;
	const row = parent.createDiv({ cls: `pendf-panel-item is-${a.type}`, attr: { "data-id": a.id, tabindex: "0" } });
	const go = (target: Annotation) => ctx.go(() => view.revealAnnotation(target));
	const noteBelow = () => {
		if (!item.note) return;
		const note = item.note;
		const n = row.createDiv({ cls: "pendf-panel-note markdown-rendered" });
		void MarkdownRenderer.render(host.app, note.body, n, src, comp);
		n.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).closest("a")) return;
			e.stopPropagation();
			go(note);
		});
	};
	if (a.type === "highlight") {
		row.setCssProps({ "--pendf-item-color": a.color });
		row.createDiv({ cls: "pendf-panel-quote", text: a.text || "(no text)" });
		noteBelow();
	} else if (a.type === "note") {
		const icon = row.createSpan({ cls: "pendf-panel-icon" });
		setIcon(icon, "message-square");
		const n = row.createDiv({ cls: "pendf-panel-note markdown-rendered" });
		void MarkdownRenderer.render(host.app, a.body, n, src, comp);
	}
	row.addEventListener("click", (e) => {
		if ((e.target as HTMLElement).closest("a")) return;
		go(a);
	});
	row.addEventListener("keydown", (e) => {
		if (e.key === "Enter") go(a);
	});
}
