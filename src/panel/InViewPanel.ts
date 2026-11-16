// The panel inside the penDF view (0.8.0, D-42): the same tabs as the sidebar
// panel, docked beside the pages when the view is wide enough, otherwise over
// the pages (tap outside to close). It never opens by an edge swipe — on iPad
// the left edge belongs to Obsidian's sidebar gesture.

import { setIcon, setTooltip, type App } from "obsidian";
import type { PenDFView } from "../view/PdfView";
import { PanelContent, isPanelTab, type PanelTab } from "./tabs";
import { PANEL_DEFAULT, clampPanelWidth, panelLayout, type PanelMode } from "./layout";

/** remembered per view (workspace state), not per file */
export interface InViewPanelState {
	open: boolean;
	tab: PanelTab;
	width: number;
	/** "auto": docked when there is room; "overlay": always over the pages */
	prefer: "auto" | "overlay";
}

export const DEFAULT_PANEL_STATE: InViewPanelState = { open: false, tab: "outline", width: PANEL_DEFAULT, prefer: "auto" };

export function parsePanelState(v: unknown): InViewPanelState {
	const o = (v ?? {}) as Partial<Record<keyof InViewPanelState, unknown>>;
	return {
		open: o.open === true,
		tab: isPanelTab(o.tab) ? o.tab : DEFAULT_PANEL_STATE.tab,
		width: typeof o.width === "number" && Number.isFinite(o.width) ? o.width : PANEL_DEFAULT,
		prefer: o.prefer === "overlay" ? "overlay" : "auto",
	};
}

export class InViewPanel {
	readonly el: HTMLElement;
	private readonly backdrop: HTMLElement;
	private readonly contentEl: HTMLElement;
	private readonly pinBtn: HTMLElement;
	private content: PanelContent;
	private st: InViewPanelState = { ...DEFAULT_PANEL_STATE };
	private mode: PanelMode = "docked";
	private ro: ResizeObserver;
	private renderTimer: number | null = null;

	constructor(
		app: App,
		/** row that holds the panel and the pages */
		private readonly body: HTMLElement,
		private readonly view: PenDFView,
		/** state changed (save the workspace layout) */
		private readonly onState: () => void,
	) {
		this.backdrop = body.createDiv({ cls: "pendf-inpanel-backdrop is-hidden" });
		this.backdrop.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			this.setOpen(false);
		});
		this.el = createDiv({ cls: "pendf-inpanel pendf-panel is-hidden", attr: { role: "complementary", "aria-label": "Document panel" } });
		body.prepend(this.el);
		const head = this.el.createDiv({ cls: "pendf-inpanel-head" });
		this.pinBtn = head.createEl("button", { cls: "clickable-icon pendf-inpanel-pin" });
		this.pinBtn.addEventListener("click", () => {
			this.st.prefer = this.st.prefer === "overlay" ? "auto" : "overlay";
			this.layout();
			this.onState();
		});
		const close = head.createEl("button", { cls: "clickable-icon pendf-inpanel-close", attr: { "aria-label": "Close panel" } });
		setTooltip(close, "Close panel");
		setIcon(close, "x");
		close.addEventListener("click", () => this.setOpen(false));
		this.contentEl = this.el.createDiv({ cls: "pendf-inpanel-content" });
		const grip = this.el.createDiv({ cls: "pendf-inpanel-grip", attr: { "aria-label": "Resize panel", role: "separator" } });
		this.installResize(grip);
		this.content = new PanelContent(
			{
				app,
				view: () => this.view,
				scrollRoot: () => this.contentEl,
				willNavigate: () => {
					if (this.mode === "overlay") this.setOpen(false);
				},
				onTabChange: (tab) => {
					this.st.tab = tab;
					this.onState();
				},
			},
			this.contentEl,
			this.st.tab,
		);
		this.ro = new ResizeObserver(() => {
			if (this.st.open) this.layout();
		});
		this.ro.observe(body);
	}

	get state(): InViewPanelState {
		return { ...this.st, tab: this.content.tab };
	}

	get isOpen(): boolean {
		return this.st.open;
	}

	get currentMode(): PanelMode {
		return this.mode;
	}

	setState(st: InViewPanelState): void {
		this.st = { ...st };
		this.content.tab = st.tab;
		this.apply();
	}

	setOpen(open: boolean, tab?: PanelTab): void {
		if (tab && isPanelTab(tab)) {
			this.st.tab = tab;
			this.content.tab = tab;
		}
		const changed = this.st.open !== open;
		this.st.open = open;
		this.apply();
		if (changed || tab) this.onState();
	}

	toggle(): void {
		this.setOpen(!this.st.open);
	}

	/** Re-render the tab (annotations changed, document loaded). */
	refresh(): void {
		if (!this.st.open) return;
		if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
		this.renderTimer = window.setTimeout(() => {
			this.renderTimer = null;
			if (this.st.open) this.content.render();
		}, 120);
	}

	private apply(): void {
		this.el.toggleClass("is-hidden", !this.st.open);
		if (!this.st.open) {
			this.backdrop.addClass("is-hidden");
			this.content.destroy();
			this.body.removeClass("has-docked-panel");
			return;
		}
		this.layout();
		this.content.render();
	}

	private layout(): void {
		const { mode, width } = panelLayout(this.body.clientWidth, this.st.width, this.st.prefer);
		this.mode = mode;
		this.el.toggleClass("is-overlay", mode === "overlay");
		this.el.toggleClass("is-docked", mode === "docked");
		this.body.toggleClass("has-docked-panel", mode === "docked");
		this.backdrop.toggleClass("is-hidden", mode !== "overlay");
		this.el.setCssProps({ "--pendf-panel-w": `${width}px` });
		const label = this.st.prefer === "overlay" ? "Dock the panel beside the pages when there is room" : "Float the panel over the pages";
		this.pinBtn.setAttribute("aria-label", label);
		setTooltip(this.pinBtn, label);
		setIcon(this.pinBtn, this.st.prefer === "overlay" ? "pin" : "pin-off");
	}

	private installResize(grip: HTMLElement): void {
		grip.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const startX = e.clientX;
			const startW = this.el.getBoundingClientRect().width;
			try {
				grip.setPointerCapture(e.pointerId);
			} catch {
				// synthetic pointer
			}
			const move = (ev: PointerEvent) => {
				this.st.width = clampPanelWidth(startW + ev.clientX - startX, this.body.clientWidth);
				this.layout();
			};
			const up = () => {
				grip.removeEventListener("pointermove", move);
				grip.removeEventListener("pointerup", up);
				grip.removeEventListener("pointercancel", up);
				this.onState();
			};
			grip.addEventListener("pointermove", move);
			grip.addEventListener("pointerup", up);
			grip.addEventListener("pointercancel", up);
		});
	}

	destroy(): void {
		this.ro.disconnect();
		if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
		this.content.destroy();
		this.el.remove();
		this.backdrop.remove();
	}
}
