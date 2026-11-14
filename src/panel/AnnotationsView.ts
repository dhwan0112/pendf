// Sidebar panel for the active penDF document, with five tabs:
//   Outline      the PDF's own bookmarks (read-only; the PDF is never modified)
//   Pages        page thumbnails (only the visible ones are drawn)
//   Search       every match in the document, with context
//   Bookmarks    your bookmarks: jump, rename, reorder, copy link, delete
//   Annotations  highlights (with their note) and notes, page by page
// It follows whichever penDF tab was active last.

import { Component, ItemView, MarkdownRenderer, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { panelPages, type PanelItem } from "../notes/model";
import type { Annotation, BookmarkAnnotation } from "../store/schema";
import { aliasFrom } from "../links/format";
import { PenDFView, VIEW_TYPE, type OutlineNode, type SearchHit } from "../view/PdfView";

export const ANNOTATIONS_VIEW = "pendf-annotations";

export type PanelTab = "outline" | "pages" | "search" | "bookmarks" | "annotations";
const TABS: { id: PanelTab; label: string; icon: string }[] = [
	{ id: "outline", label: "Outline", icon: "list-tree" },
	{ id: "pages", label: "Pages", icon: "layout-grid" },
	{ id: "search", label: "Search", icon: "search" },
	{ id: "bookmarks", label: "Bookmarks", icon: "bookmark" },
	{ id: "annotations", label: "Annotations", icon: "highlighter" },
];

export class AnnotationsView extends ItemView {
	private target: WorkspaceLeaf | null = null;
	private unsubscribe: (() => void) | null = null;
	private renderComp: Component | null = null;
	private timer: number | null = null;
	private tab: PanelTab = "annotations";
	private renderSeq = 0;
	/** per-render cleanups (thumbnail observer, running search, page listener) */
	private cleanups: (() => void)[] = [];
	private searchQuery = "";

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return ANNOTATIONS_VIEW;
	}
	getDisplayText(): string {
		return "penDF";
	}
	getIcon(): string {
		return "book-open-text";
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), tab: this.tab };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const t = (state as { tab?: unknown } | null)?.tab;
		if (typeof t === "string" && TABS.some((x) => x.id === t)) this.tab = t as PanelTab;
		await super.setState(state, result);
		this.renderSoon();
	}

	showTab(tab: PanelTab): void {
		if (this.tab === tab) return;
		this.tab = tab;
		this.app.workspace.requestSaveLayout();
		this.render();
	}

	get currentTab(): PanelTab {
		return this.tab;
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("pendf-panel");
		this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => this.follow(leaf)));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.follow(null)));
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		this.follow(leaves.find((l) => l === this.app.workspace.getMostRecentLeaf()) ?? leaves[0] ?? null);
		this.render();
	}

	async onClose(): Promise<void> {
		this.runCleanups();
		this.unsubscribe?.();
		this.unsubscribe = null;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.renderComp?.unload();
		this.renderComp = null;
	}

	/** The penDF view the panel shows, if its tab still exists. */
	private view(): PenDFView | null {
		const leaf = this.target;
		if (!leaf || !this.app.workspace.getLeavesOfType(VIEW_TYPE).includes(leaf)) return null;
		return leaf.view instanceof PenDFView ? leaf.view : null;
	}

	private follow(leaf: WorkspaceLeaf | null): void {
		if (leaf && leaf.view instanceof PenDFView) {
			if (leaf === this.target) return;
			this.unsubscribe?.();
			this.target = leaf;
			this.unsubscribe = leaf.view.onAnnotationsChange(() => this.renderSoon());
			this.renderSoon();
		} else if (this.target && !this.view()) {
			this.unsubscribe?.();
			this.unsubscribe = null;
			this.target = null;
			this.renderSoon();
		}
	}

	private renderSoon(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.render();
		}, 120);
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
		const seq = ++this.renderSeq;
		this.runCleanups();
		const el = this.contentEl;
		el.empty();
		this.renderComp?.unload();
		const comp = new Component();
		comp.load();
		this.renderComp = comp;

		const tabs = el.createDiv({ cls: "pendf-panel-tabs" });
		for (const t of TABS) {
			const b = tabs.createEl("button", { cls: "pendf-panel-tab clickable-icon", attr: { "aria-label": t.label, title: t.label, "data-tab": t.id } });
			setIcon(b, t.icon);
			b.createSpan({ cls: "pendf-panel-tab-label", text: t.label });
			if (t.id === this.tab) b.addClass("is-active");
			b.addEventListener("click", () => this.showTab(t.id));
		}

		const view = this.view();
		if (!view || !view.file) {
			el.createDiv({ cls: "pendf-panel-empty", text: "Open a PDF in penDF to see its outline, bookmarks, highlights and notes here." });
			return;
		}
		el.createDiv({ cls: "pendf-panel-title", text: view.file.basename });
		const body = el.createDiv({ cls: `pendf-panel-body is-${this.tab}` });
		if (this.tab === "outline") void this.renderOutline(body, view, seq);
		else if (this.tab === "pages") this.renderPages(body, view);
		else if (this.tab === "search") this.renderSearch(body, view);
		else if (this.tab === "bookmarks") this.renderBookmarks(body, view);
		else this.renderAnnotations(body, view, comp);
	}

	// ----------------------------------------------------------------- outline

	private async renderOutline(body: HTMLElement, view: PenDFView, seq: number): Promise<void> {
		const loading = body.createDiv({ cls: "pendf-panel-empty", text: "Loading outline…" });
		const nodes = await view.outline();
		if (seq !== this.renderSeq) return;
		loading.remove();
		if (nodes.length === 0) {
			body.createDiv({ cls: "pendf-panel-empty", text: "This PDF has no outline. Add your own bookmarks in the Bookmarks tab." });
			return;
		}
		const tree = body.createDiv({ cls: "pendf-outline" });
		const add = (parent: HTMLElement, list: OutlineNode[]) => {
			for (const n of list) {
				const item = parent.createDiv({ cls: "pendf-outline-item" });
				const row = item.createDiv({ cls: "pendf-outline-row", attr: { tabindex: "0" } });
				row.setCssProps({ "--pendf-depth": String(n.depth) });
				let kids: HTMLElement | null = null;
				const toggle = row.createSpan({ cls: "pendf-outline-toggle" });
				if (n.items.length) {
					setIcon(toggle, "chevron-right");
					kids = item.createDiv({ cls: "pendf-outline-children" });
					const open = n.depth < 1;
					item.toggleClass("is-open", open);
					toggle.addEventListener("click", (e) => {
						e.stopPropagation();
						item.toggleClass("is-open", !item.hasClass("is-open"));
					});
				}
				row.createSpan({ cls: "pendf-outline-title", text: n.title });
				if (n.page !== null) row.createSpan({ cls: "pendf-outline-page", text: String(n.page) });
				const go = () => {
					this.app.workspace.setActiveLeaf(view.leaf, { focus: false });
					view.goToOutline(n);
				};
				row.addEventListener("click", go);
				row.addEventListener("keydown", (e) => {
					if (e.key === "Enter") go();
				});
				if (kids) add(kids, n.items);
			}
		};
		add(tree, nodes);
	}

	// ------------------------------------------------------------------- pages

	private renderPages(body: HTMLElement, view: PenDFView): void {
		const n = view.pageCount;
		if (!n) {
			body.createDiv({ cls: "pendf-panel-empty", text: "Loading…" });
			return;
		}
		const THUMB = 104;
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
			if (canvas) {
				canvas.width = 0;
				canvas.height = 0;
				canvas.remove();
			}
			cell?.removeClass("is-rendered");
		};
		for (let page = 1; page <= n; page++) {
			const cell = grid.createDiv({ cls: "pendf-thumb", attr: { "data-page": String(page), tabindex: "0", "aria-label": `Page ${page}` } });
			const frame = cell.createDiv({ cls: "pendf-thumb-frame" });
			frame.setCssProps({ "--pendf-thumb-h": `${Math.round(THUMB * view.pageAspect(page))}px`, "--pendf-thumb-w": `${THUMB}px` });
			const label = cell.createDiv({ cls: "pendf-thumb-label", text: String(page) });
			const c = counts.get(page);
			if (c) label.createSpan({ cls: "pendf-thumb-badge", text: String(c), attr: { title: `${c} annotation(s)` } });
			if (page === view.currentPage) cell.addClass("is-current");
			const go = () => {
				this.app.workspace.setActiveLeaf(view.leaf, { focus: false });
				view.goToPage(page);
			};
			cell.addEventListener("click", go);
			cell.addEventListener("keydown", (e) => {
				if (e.key === "Enter") go();
			});
			cells.push(cell);
		}
		// draw only what is (nearly) visible; free canvases far off screen
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
			{ root: this.contentEl, rootMargin: "300px 0px" },
		);
		for (const cell of cells) io.observe(cell);
		const offPage = view.onPageChange((page) => {
			grid.querySelector(".pendf-thumb.is-current")?.removeClass("is-current");
			const cell = cells[page - 1];
			if (!cell) return;
			cell.addClass("is-current");
			const r = cell.getBoundingClientRect();
			const pr = this.contentEl.getBoundingClientRect();
			if (r.bottom < pr.top || r.top > pr.bottom) cell.scrollIntoView({ block: "nearest" });
		});
		this.cleanups.push(() => {
			io.disconnect();
			offPage();
			for (let p = 1; p <= cells.length; p++) release(p);
		});
		// start where the reader is
		window.setTimeout(() => cells[view.currentPage - 1]?.scrollIntoView({ block: "center" }), 0);
	}

	// ------------------------------------------------------------------ search

	private renderSearch(body: HTMLElement, view: PenDFView): void {
		const form = body.createDiv({ cls: "pendf-search-panel" });
		const input = form.createEl("input", { cls: "pendf-search-panel-input", attr: { type: "search", placeholder: "Search this PDF…", "aria-label": "Search this PDF" } });
		input.value = this.searchQuery;
		const status = body.createDiv({ cls: "pendf-panel-empty pendf-search-status" });
		const list = body.createDiv({ cls: "pendf-search-results" });
		let ac: AbortController | null = null;
		let timer: number | null = null;
		const run = () => {
			ac?.abort();
			list.empty();
			const q = input.value.trim();
			this.searchQuery = input.value;
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
						this.renderHits(list, view, hits);
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
		this.cleanups.push(() => {
			ac?.abort();
			if (timer !== null) window.clearTimeout(timer);
		});
		run();
		window.setTimeout(() => input.focus(), 0);
	}

	private renderHits(list: HTMLElement, view: PenDFView, hits: SearchHit[]): void {
		const section = list.createDiv({ cls: "pendf-panel-page" });
		section.createDiv({ cls: "pendf-panel-page-title", text: `Page ${hits[0].page}` });
		for (const h of hits) {
			const row = section.createDiv({ cls: "pendf-search-hit", attr: { tabindex: "0" } });
			row.appendText((h.before.length >= 40 ? "…" : "") + h.before);
			row.createEl("mark", { text: h.match });
			row.appendText(h.after + (h.after.length >= 60 ? "…" : ""));
			const go = () => {
				this.app.workspace.setActiveLeaf(view.leaf, { focus: false });
				view.revealHit(h);
			};
			row.addEventListener("click", go);
			row.addEventListener("keydown", (e) => {
				if (e.key === "Enter") go();
			});
		}
	}

	// --------------------------------------------------------------- bookmarks

	private renderBookmarks(body: HTMLElement, view: PenDFView): void {
		const add = body.createEl("button", { cls: "pendf-panel-add" });
		setIcon(add.createSpan({ cls: "pendf-panel-add-icon" }), "bookmark-plus");
		add.createSpan({ text: "Bookmark the top of the view" });
		add.addEventListener("click", () => void view.addBookmark());
		const list = view.bookmarks();
		if (list.length === 0) {
			body.createDiv({ cls: "pendf-panel-empty", text: "No bookmarks yet." });
			return;
		}
		list.forEach((b, i) => this.renderBookmark(body, view, b, i, list.length));
	}

	private renderBookmark(parent: HTMLElement, view: PenDFView, b: BookmarkAnnotation, index: number, count: number): void {
		const row = parent.createDiv({ cls: "pendf-bookmark", attr: { "data-id": b.id } });
		const main = row.createDiv({ cls: "pendf-bookmark-main", attr: { tabindex: "0" } });
		main.createSpan({ cls: "pendf-bookmark-title", text: b.title });
		main.createSpan({ cls: "pendf-bookmark-page", text: `p. ${b.page}` });
		const go = () => {
			this.app.workspace.setActiveLeaf(view.leaf, { focus: false });
			view.revealAnnotation(b);
		};
		main.addEventListener("click", go);
		main.addEventListener("keydown", (e) => {
			if (e.key === "Enter") go();
		});
		const actions = row.createDiv({ cls: "pendf-bookmark-actions" });
		const btn = (icon: string, label: string, fn: () => void, disabled = false, warn = false) => {
			const el = actions.createEl("button", { cls: `clickable-icon pendf-bookmark-btn${warn ? " is-danger" : ""}`, attr: { "aria-label": label, title: label } });
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

	// ------------------------------------------------------------- annotations

	private renderAnnotations(body: HTMLElement, view: PenDFView, comp: Component): void {
		const pages = panelPages(view.annotations());
		if (pages.length === 0) {
			body.createDiv({ cls: "pendf-panel-empty", text: "No highlights or notes yet. Select text to highlight it, or use “Add note” in the toolbar." });
			return;
		}
		const src = view.file?.path ?? "";
		for (const p of pages) {
			const section = body.createDiv({ cls: "pendf-panel-page" });
			section.createDiv({ cls: "pendf-panel-page-title", text: `Page ${p.page}` });
			for (const item of p.items) this.renderItem(section, item, view, src, comp);
		}
	}

	private renderItem(parent: HTMLElement, item: PanelItem, view: PenDFView, src: string, comp: Component): void {
		const a = item.annotation;
		const row = parent.createDiv({ cls: `pendf-panel-item is-${a.type}`, attr: { "data-id": a.id, tabindex: "0" } });
		const go = (target: Annotation) => {
			this.app.workspace.setActiveLeaf(view.leaf, { focus: false });
			view.revealAnnotation(target);
		};
		if (a.type === "highlight") {
			row.setCssProps({ "--pendf-item-color": a.color });
			row.createDiv({ cls: "pendf-panel-quote", text: a.text || "(no text)" });
			if (item.note) {
				const note = item.note;
				const n = row.createDiv({ cls: "pendf-panel-note markdown-rendered" });
				void MarkdownRenderer.render(this.app, note.body, n, src, comp);
				n.addEventListener("click", (e) => {
					if ((e.target as HTMLElement).closest("a")) return;
					e.stopPropagation();
					go(note);
				});
			}
		} else if (a.type === "note") {
			const icon = row.createSpan({ cls: "pendf-panel-icon" });
			setIcon(icon, "message-square");
			const n = row.createDiv({ cls: "pendf-panel-note markdown-rendered" });
			void MarkdownRenderer.render(this.app, a.body, n, src, comp);
		}
		row.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).closest("a")) return;
			go(a);
		});
		row.addEventListener("keydown", (e) => {
			if (e.key === "Enter") go(a);
		});
	}
}
