// penDF toolbar (0.8.0): labelled buttons in functional groups, with the
// least-used ones moving into a "More" menu when the view is narrow.
//
// - every button: aria-label + Obsidian tooltip; on touch/pen a long press
//   shows its name instead of acting (iPad has no hover)
// - groups: navigation & zoom | annotation tools | undo/redo | search, link, panel
// - priority 1 never overflows; 2 and 3 go into "More" (3 first) until the
//   toolbar fits on one line

import { Menu, setIcon, setTooltip } from "obsidian";

export interface ToolButton {
	id: string;
	icon: string;
	label: string;
	/** 1: always visible, 2: overflows second, 3: overflows first */
	priority: 1 | 2 | 3;
	run: () => void;
	/** text shown next to the icon when the bar has room (labels option); default: label */
	short?: string;
	el?: HTMLButtonElement;
}

const LONG_PRESS_MS = 450;

export interface ToolbarOptions {
	/** accessible name of the bar */
	name?: string;
	/** show text labels next to the icons while they fit (dropped before anything overflows) */
	labels?: boolean;
	/** the bar sits at the bottom: tooltips and press labels go above the buttons */
	above?: boolean;
}

let activeTip: HTMLElement | null = null;

function showPressTip(anchor: HTMLElement, text: string, above: boolean): void {
	activeTip?.remove();
	const tip = anchor.ownerDocument.body.createDiv({ cls: "pendf-press-tip", text });
	const r = anchor.getBoundingClientRect();
	if (above) tip.addClass("is-above");
	tip.setCssProps({ "--pendf-tip-x": `${Math.round(r.left + r.width / 2)}px`, "--pendf-tip-y": `${Math.round(above ? r.top - 6 : r.bottom + 6)}px` });
	activeTip = tip;
	window.setTimeout(() => {
		if (activeTip === tip) activeTip = null;
		tip.remove();
	}, 1600);
}

/**
 * iPad has no hover: a long press (touch or Pencil) on `el` shows its name instead of acting.
 * Call before adding the element's own click listener (the suppressed click stops here).
 */
export function pressLabel(el: HTMLElement, label: () => string, opts: { above?: boolean } = {}): void {
	let timer: number | null = null;
	let suppressClick = false;
	const clear = () => {
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
	};
	el.addEventListener("pointerdown", (e) => {
		// a long press may end without a click (iPadOS): never let it swallow the next tap
		suppressClick = false;
		if (e.pointerType === "mouse") return;
		clear();
		timer = window.setTimeout(() => {
			timer = null;
			suppressClick = true;
			showPressTip(el, label(), !!opts.above);
		}, LONG_PRESS_MS);
	});
	for (const t of ["pointerup", "pointercancel", "pointerleave"] as const) el.addEventListener(t, clear);
	el.addEventListener("contextmenu", (e) => {
		// iPadOS/Android long press may also raise a context menu
		if (suppressClick) e.preventDefault();
	});
	el.addEventListener(
		"click",
		(e) => {
			if (!suppressClick) return;
			suppressClick = false;
			e.preventDefault();
			e.stopImmediatePropagation();
		},
		{ capture: true },
	);
}

export class Toolbar {
	private buttons: ToolButton[] = [];
	private moreBtn: HTMLButtonElement;
	private ro: ResizeObserver;
	private fitting = false;
	private activeIds = new Set<string>();

	constructor(
		readonly el: HTMLElement,
		private readonly opts: ToolbarOptions = {},
	) {
		el.setAttribute("role", "toolbar");
		el.setAttribute("aria-label", opts.name ?? "penDF");
		this.moreBtn = createEl("button", { cls: "pendf-icon-btn clickable-icon pendf-more is-hidden", attr: { "aria-label": "More" } });
		setIcon(this.moreBtn, "more-horizontal");
		setTooltip(this.moreBtn, "More", this.tipOpts());
		this.moreBtn.addEventListener("click", (e) => this.openMore(e));
		this.ro = new ResizeObserver(() => this.fit());
		this.ro.observe(el);
	}

	group(name: string): HTMLElement {
		return this.el.createDiv({ cls: `pendf-group pendf-group-${name}`, attr: { role: "group", "aria-label": name } });
	}

	spacer(): void {
		this.el.createDiv({ cls: "pendf-spacer" });
	}

	/** finish: the More button goes last */
	done(): void {
		this.el.appendChild(this.moreBtn);
		this.fit();
	}

	private tipOpts(): { placement: "top" } | undefined {
		return this.opts.above ? { placement: "top" } : undefined;
	}

	add(parent: HTMLElement, b: ToolButton): HTMLButtonElement {
		const el = parent.createEl("button", { cls: "pendf-icon-btn clickable-icon", attr: { "aria-label": b.label, "data-tool": b.id } });
		setIcon(el, b.icon);
		if (this.opts.labels) el.createSpan({ cls: "pendf-btn-label", text: b.short ?? b.label });
		setTooltip(el, b.label, this.tipOpts());
		pressLabel(el, () => b.label, { above: this.opts.above });
		el.addEventListener("click", (e) => {
			e.preventDefault();
			b.run();
		});
		b.el = el;
		this.buttons.push(b);
		return el;
	}

	/** Change a button's label (e.g. toggle state); keeps aria-label, tooltip and the More menu in sync. */
	relabel(id: string, label: string): void {
		const b = this.buttons.find((x) => x.id === id);
		if (!b?.el) return;
		b.label = label;
		b.el.setAttribute("aria-label", label);
		setTooltip(b.el, label, this.tipOpts());
	}

	/** The button for `id`. */
	button(id: string): HTMLButtonElement | undefined {
		return this.buttons.find((x) => x.id === id)?.el;
	}

	/** Mark the active button(s). */
	setActive(ids: Iterable<string>): void {
		this.activeIds = new Set(ids);
		for (const b of this.buttons) {
			b.el?.toggleClass("is-active", this.activeIds.has(b.id));
			b.el?.setAttribute("aria-pressed", String(this.activeIds.has(b.id)));
		}
		this.markMore();
	}

	/** An active button inside "More" lights up the More button. */
	private markMore(): void {
		this.moreBtn.toggleClass("is-active", this.buttons.some((b) => this.activeIds.has(b.id) && b.el?.hasClass("is-overflowed")));
	}

	/** Show everything, then move priority-3, then priority-2 buttons into More until one line fits. */
	fit(): void {
		if (this.fitting) return;
		this.fitting = true;
		try {
			this.fitInner();
		} finally {
			this.fitting = false;
			this.markMore();
		}
	}

	private fitInner(): void {
		{
			for (const b of this.buttons) b.el?.removeClass("is-overflowed");
			this.moreBtn.addClass("is-hidden");
			// labels first; icons only when they do not fit
			if (this.opts.labels) {
				this.el.addClass("has-labels");
				if (!this.overflowing()) return;
				this.el.removeClass("has-labels");
			}
			if (!this.overflowing()) return;
			this.moreBtn.removeClass("is-hidden");
			for (const prio of [3, 2] as const) {
				for (const b of [...this.buttons].reverse()) {
					if (b.priority !== prio || !b.el) continue;
					b.el.addClass("is-overflowed");
					if (!this.overflowing()) return;
				}
			}
		}
	}

	private overflowing(): boolean {
		return this.el.scrollWidth > this.el.clientWidth + 1;
	}

	/** Labels of the buttons currently in the More menu (tests). */
	overflowed(): string[] {
		return this.buttons.filter((b) => b.el?.hasClass("is-overflowed")).map((b) => b.id);
	}

	private openMore(e: MouseEvent): void {
		const menu = new Menu();
		for (const b of this.buttons) {
			if (!b.el?.hasClass("is-overflowed")) continue;
			menu.addItem((i) => i.setTitle(b.label).setIcon(b.icon).onClick(() => b.run()));
		}
		menu.showAtMouseEvent(e);
	}

	destroy(): void {
		this.ro.disconnect();
		activeTip?.remove();
		activeTip = null;
	}
}
