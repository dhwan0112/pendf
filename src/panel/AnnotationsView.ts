// Obsidian sidebar panel for the active penDF document. Its tabs are the shared
// panel tabs (./tabs.ts) — the same ones the panel inside the penDF view shows.
// It follows whichever penDF tab was active last.

import { ItemView, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { PenDFView, VIEW_TYPE } from "../view/PdfView";
import { PanelContent, isPanelTab, type PanelTab } from "./tabs";

export const ANNOTATIONS_VIEW = "pendf-annotations";
export type { PanelTab } from "./tabs";

export class AnnotationsView extends ItemView {
	private target: WorkspaceLeaf | null = null;
	private unsubscribe: (() => void) | null = null;
	private timer: number | null = null;
	private content: PanelContent | null = null;
	private initialTab: PanelTab = "annotations";

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
		return { ...super.getState(), tab: this.currentTab };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const t = (state as { tab?: unknown } | null)?.tab;
		if (isPanelTab(t)) {
			this.initialTab = t;
			if (this.content) this.content.tab = t;
		}
		await super.setState(state, result);
		this.renderSoon();
	}

	showTab(tab: PanelTab): void {
		this.content?.showTab(tab);
	}

	get currentTab(): PanelTab {
		return this.content?.tab ?? this.initialTab;
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("pendf-panel");
		this.content = new PanelContent(
			{
				app: this.app,
				view: () => this.view(),
				scrollRoot: () => this.contentEl,
				willNavigate: (view) => this.app.workspace.setActiveLeaf(view.leaf, { focus: false }),
				onTabChange: () => this.app.workspace.requestSaveLayout(),
			},
			this.contentEl,
			this.initialTab,
		);
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
		this.content?.destroy();
		this.content = null;
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
		this.content?.render();
	}
}
