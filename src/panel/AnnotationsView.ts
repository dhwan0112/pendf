// Sidebar panel: the annotations of the active penDF document, page by page in
// reading order — highlights (with their note) and stand-alone notes. Tap an
// item to jump there. Follows whichever penDF tab was active last.

import { Component, ItemView, MarkdownRenderer, setIcon, type WorkspaceLeaf } from "obsidian";
import { panelPages, type PanelItem } from "../notes/model";
import type { Annotation } from "../store/schema";
import { PenDFView, VIEW_TYPE } from "../view/PdfView";

export const ANNOTATIONS_VIEW = "pendf-annotations";

export class AnnotationsView extends ItemView {
	private target: WorkspaceLeaf | null = null;
	private unsubscribe: (() => void) | null = null;
	private renderComp: Component | null = null;
	private timer: number | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return ANNOTATIONS_VIEW;
	}
	getDisplayText(): string {
		return "penDF annotations";
	}
	getIcon(): string {
		return "list";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("pendf-panel");
		this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => this.follow(leaf)));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.follow(null)));
		const active = this.app.workspace.getLeavesOfType(VIEW_TYPE).find((l) => l === this.app.workspace.getMostRecentLeaf()) ?? this.app.workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
		this.follow(active);
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
			// the followed tab was closed
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
		const el = this.contentEl;
		el.empty();
		this.renderComp?.unload();
		const comp = new Component();
		comp.load();
		this.renderComp = comp;
		const view = this.view();
		if (!view || !view.file) {
			el.createDiv({ cls: "pendf-panel-empty", text: "Open a PDF in penDF to see its highlights and notes here." });
			return;
		}
		el.createDiv({ cls: "pendf-panel-title", text: view.file.basename });
		const pages = panelPages(view.annotations());
		if (pages.length === 0) {
			el.createDiv({ cls: "pendf-panel-empty", text: "No highlights or notes yet. Select text to highlight it, or use “Add note” in the toolbar." });
			return;
		}
		const src = view.file.path;
		for (const p of pages) {
			const section = el.createDiv({ cls: "pendf-panel-page" });
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
