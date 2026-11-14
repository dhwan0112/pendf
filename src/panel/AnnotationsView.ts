// Sidebar panel for the active penDF document, with three tabs:
//   Outline      the PDF's own bookmarks (read-only; the PDF is never modified)
//   Bookmarks    your bookmarks: jump, rename, reorder, copy link, delete
//   Annotations  highlights (with their note) and notes, page by page
// It follows whichever penDF tab was active last.

import { Component, ItemView, MarkdownRenderer, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { panelPages, type PanelItem } from "../notes/model";
import type { Annotation, BookmarkAnnotation } from "../store/schema";
import { aliasFrom } from "../links/format";
import { PenDFView, VIEW_TYPE, type OutlineNode } from "../view/PdfView";

export const ANNOTATIONS_VIEW = "pendf-annotations";

export type PanelTab = "outline" | "bookmarks" | "annotations";
const TABS: { id: PanelTab; label: string; icon: string }[] = [
	{ id: "outline", label: "Outline", icon: "list-tree" },
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
		if (t === "outline" || t === "bookmarks" || t === "annotations") this.tab = t;
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

	render(): void {
		const seq = ++this.renderSeq;
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
			b.createSpan({ text: t.label });
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
