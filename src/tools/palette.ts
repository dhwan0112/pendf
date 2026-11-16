// The bottom tool palette ("pencil case", D-46): a bar floating at the bottom centre of the
// page area — no tool, pen, highlighter, stroke eraser, text highlight, area excerpt, note,
// undo / redo — with an options popover (pressing the selected tool again) and a fold handle.
//
// It lives outside the scrolling container and outside `.pendf-root`, so taps on it never
// reach the page's pointer, click and pinch handlers.

import { setIcon, setTooltip } from "obsidian";
import { PEN_COLORS, PEN_WIDTHS, type HighlightColor, type PenDFSettings } from "../settings";
import { Toolbar, pressLabel } from "../view/toolbar";
import { HIGHLIGHTER_OPACITIES, hasOptions, type ToolId } from "./model";

export interface PaletteHost {
	/** the area the bar is centred on (the page area: right of a docked panel) */
	viewArea: HTMLElement;
	settings(): PenDFSettings;
	/** the tool in effect now (derived from the controllers) */
	tool(): ToolId;
	select(tool: ToolId): void;
	undo(): void;
	redo(): void;
	/** persist settings without re-rendering the views, and show the change in every open view */
	save(): void;
}

const PEN_COLOR_NAMES: Record<string, string> = { "#1f1f1f": "Black", "#1f5fbf": "Blue", "#c62828": "Red", "#2e7d32": "Green" };
const HIGHLIGHTER_WIDTHS = [8, 12, 18];
/** gap between the bar and the bottom of the page area, px (plus the safe area) */
export const PALETTE_GAP = 12;

export const TOOL_LABELS: Record<ToolId, { icon: string; label: string; short: string }> = {
	none: { icon: "mouse-pointer-2", label: "No tool (read and select)", short: "Select" },
	pen: { icon: "pen-line", label: "Pen", short: "Pen" },
	highlighter: { icon: "highlighter", label: "Highlighter (freehand)", short: "Marker" },
	eraser: { icon: "eraser", label: "Stroke eraser", short: "Eraser" },
	text: { icon: "text-select", label: "Highlight text", short: "Text" },
	area: { icon: "square-dashed", label: "Area excerpt (drag a rectangle)", short: "Area" },
	note: { icon: "message-square-plus", label: "Add note (then tap the page)", short: "Note" },
};

export class ToolPalette {
	readonly el: HTMLElement;
	private bar: HTMLElement;
	private handle: HTMLButtonElement;
	private popover: HTMLElement | null = null;
	private popoverTool: ToolId | null = null;
	private toolbar: Toolbar;
	private ro: ResizeObserver;
	private ac = new AbortController();

	constructor(
		parent: HTMLElement,
		private readonly host: PaletteHost,
	) {
		const doc = parent.ownerDocument;
		this.el = parent.createDiv({ cls: "pendf-tools" });
		this.bar = this.el.createDiv({ cls: "pendf-tools-bar" });
		const t = new Toolbar(this.bar, { name: "Annotation tools", labels: true, above: true });
		this.toolbar = t;
		const tools = t.group("tools");
		const add = (id: ToolId, priority: 1 | 2 | 3) => {
			const l = TOOL_LABELS[id];
			const b = t.add(tools, { id, icon: l.icon, label: l.label, short: l.short, priority, run: () => this.press(id) });
			if (id !== "none" && id !== "eraser" && id !== "note") b.createSpan({ cls: "pendf-tool-color" });
		};
		// narrow (Slide Over, 320 px): area and note go into "More" first, then redo, text and the eraser
		add("none", 1);
		add("pen", 1);
		add("highlighter", 1);
		add("eraser", 2);
		add("text", 2);
		add("area", 3);
		add("note", 3);
		const history = t.group("history");
		t.add(history, { id: "undo", icon: "undo-2", label: "Undo", short: "Undo", priority: 1, run: () => host.undo() });
		t.add(history, { id: "redo", icon: "redo-2", label: "Redo", short: "Redo", priority: 2, run: () => host.redo() });
		const fold = t.group("fold");
		t.add(fold, { id: "collapse", icon: "chevron-down", label: "Hide the tool palette", short: "Hide", priority: 1, run: () => this.setCollapsed(true) });
		t.done();

		this.handle = this.el.createEl("button", { cls: "pendf-tools-handle clickable-icon", attr: { "aria-label": "Show the tool palette", "data-tool": "expand" } });
		setTooltip(this.handle, "Show the tool palette", { placement: "top" });
		pressLabel(this.handle, () => "Show the tool palette", { above: true });
		this.handle.addEventListener("click", (e) => {
			e.preventDefault();
			this.setCollapsed(false);
		});

		// close the options when the user works elsewhere
		doc.addEventListener(
			"pointerdown",
			(e) => {
				if (this.popover && !this.el.contains(e.target as Node)) this.closeOptions();
			},
			{ capture: true, signal: this.ac.signal },
		);
		doc.addEventListener(
			"keydown",
			(e) => {
				if (e.key === "Escape" && this.popover) this.closeOptions();
			},
			{ signal: this.ac.signal },
		);

		this.ro = new ResizeObserver(() => this.layout());
		this.ro.observe(host.viewArea);
		this.ro.observe(this.el);
		this.refresh();
	}

	get collapsed(): boolean {
		return this.host.settings().tools.collapsed;
	}

	setCollapsed(on: boolean): void {
		if (on) this.closeOptions();
		this.host.settings().tools.collapsed = on;
		this.host.save();
		this.refresh();
		if (!on) this.toolbar.fit();
		this.layout();
	}

	/** A tool button was pressed: select it, or open its options when it is already selected. */
	press(id: ToolId): void {
		if (this.host.tool() === id && hasOptions(id)) {
			if (this.popoverTool === id) this.closeOptions();
			else this.openOptions(id);
			return;
		}
		this.closeOptions();
		this.host.select(id);
	}

	/** Re-read the state: active tool, colours on the buttons, folded or not. */
	refresh(): void {
		const s = this.host.settings();
		const tool = this.host.tool();
		this.toolbar.setActive([tool]);
		const colorOf: Partial<Record<ToolId, string>> = { pen: s.ink.penColor, highlighter: s.ink.highlighterColor, text: s.tools.textColor, area: s.tools.areaColor };
		for (const [id, hex] of Object.entries(colorOf)) this.toolbar.button(id)?.setCssProps({ "--pendf-tool-color": hex });
		const collapsed = s.tools.collapsed;
		this.el.toggleClass("is-collapsed", collapsed);
		this.bar.toggleClass("is-hidden", collapsed);
		this.handle.toggleClass("is-hidden", !collapsed);
		setIcon(this.handle, collapsed && tool !== "none" ? TOOL_LABELS[tool].icon : "chevron-up");
		this.handle.toggleClass("is-active", tool !== "none");
		if (this.popoverTool && this.popoverTool !== tool) this.closeOptions();
		else if (this.popoverTool) this.renderOptions(this.popoverTool);
	}

	/** Centre on the page area; reserve room at the end of the scroll for the bar. */
	layout(): void {
		const area = this.host.viewArea;
		const parent = this.el.parentElement;
		if (!parent) return;
		const pr = parent.getBoundingClientRect();
		const ar = area.getBoundingClientRect();
		this.el.setCssProps({
			"--pendf-tools-x": `${Math.round(ar.left - pr.left + ar.width / 2)}px`,
			"--pendf-tools-max": `${Math.max(120, Math.round(ar.width - 2 * 16))}px`,
		});
		// from the bar's top to the bottom of the page area, + pdf.js's −8 px bottom margin on the
		// last page, + 8 px clear of the bar
		const top = this.el.getBoundingClientRect().top;
		const space = top > ar.top ? ar.bottom - top : this.el.offsetHeight + PALETTE_GAP;
		area.setCssProps({ "--pendf-tools-space": `${Math.ceil(space + 16)}px` });
		if (!this.collapsed) this.toolbar.fit();
	}

	/** Labels of tools in the More menu (tests). */
	get overflowed(): string[] {
		return this.toolbar.overflowed();
	}

	get optionsOpenFor(): ToolId | null {
		return this.popoverTool;
	}

	openOptions(id: ToolId): void {
		this.closeOptions();
		this.popoverTool = id;
		this.popover = this.el.createDiv({ cls: "pendf-tools-options", attr: { role: "dialog", "aria-label": `${TOOL_LABELS[id].label} options` } });
		this.renderOptions(id);
	}

	closeOptions(): void {
		this.popover?.remove();
		this.popover = null;
		this.popoverTool = null;
	}

	private renderOptions(id: ToolId): void {
		const pop = this.popover;
		if (!pop) return;
		pop.empty();
		const s = this.host.settings();
		const set = (fn: () => void) => {
			fn();
			this.host.save();
			this.refresh();
		};
		const swatches = (list: { hex: string; name: string }[], current: string, pick: (hex: string) => void) => {
			const row = pop.createDiv({ cls: "pendf-tools-row pendf-tools-colors", attr: { role: "group", "aria-label": "Colour" } });
			for (const c of list) {
				const b = row.createEl("button", { cls: "pendf-swatch pendf-tools-swatch", attr: { "aria-label": c.name, "data-hex": c.hex } });
				b.setCssProps({ "--pendf-swatch": c.hex });
				setTooltip(b, c.name, { placement: "top" });
				pressLabel(b, () => c.name, { above: true });
				const on = c.hex.toLowerCase() === current.toLowerCase();
				b.toggleClass("is-active", on);
				b.setAttribute("aria-pressed", String(on));
				b.addEventListener("click", () => set(() => pick(c.hex)));
			}
		};
		const widths = (list: number[], current: number, pick: (w: number) => void) => {
			const row = pop.createDiv({ cls: "pendf-tools-row pendf-tools-widths", attr: { role: "group", "aria-label": "Width" } });
			list.forEach((w, i) => {
				const label = `Width ${w} pt`;
				const b = row.createEl("button", { cls: "pendf-icon-btn pendf-tools-width", attr: { "aria-label": label, "data-width": String(w) } });
				b.createSpan({ cls: "pendf-ink-dot" }).setCssProps({ "--pendf-dot": `${4 + i * 4}px` });
				setTooltip(b, label, { placement: "top" });
				pressLabel(b, () => label, { above: true });
				b.toggleClass("is-active", w === current);
				b.setAttribute("aria-pressed", String(w === current));
				b.addEventListener("click", () => set(() => pick(w)));
			});
		};
		const named = (cs: HighlightColor[]) => cs.map((c) => ({ hex: c.hex, name: c.name }));
		if (id === "pen") {
			swatches(PEN_COLORS.map((hex) => ({ hex, name: PEN_COLOR_NAMES[hex] ?? hex })), s.ink.penColor, (hex) => (s.ink.penColor = hex));
			widths(PEN_WIDTHS, s.ink.penWidth, (w) => (s.ink.penWidth = w));
		} else if (id === "highlighter") {
			swatches(named(s.colors), s.ink.highlighterColor, (hex) => (s.ink.highlighterColor = hex));
			widths(HIGHLIGHTER_WIDTHS, s.ink.highlighterWidth, (w) => (s.ink.highlighterWidth = w));
			const row = pop.createDiv({ cls: "pendf-tools-row pendf-tools-opacity", attr: { role: "group", "aria-label": "Opacity" } });
			for (const o of HIGHLIGHTER_OPACITIES) {
				const label = `Opacity ${Math.round(o * 100)} %`;
				const b = row.createEl("button", { cls: "pendf-icon-btn pendf-tools-op", text: `${Math.round(o * 100)}%`, attr: { "aria-label": label, "data-opacity": String(o) } });
				setTooltip(b, label, { placement: "top" });
				pressLabel(b, () => label, { above: true });
				const on = Math.abs(o - s.ink.highlighterOpacity) < 1e-6;
				b.toggleClass("is-active", on);
				b.setAttribute("aria-pressed", String(on));
				b.addEventListener("click", () => set(() => (s.ink.highlighterOpacity = o)));
			}
		} else if (id === "text") {
			swatches(named(s.colors), s.tools.textColor, (hex) => (s.tools.textColor = hex));
		} else if (id === "area") {
			swatches(named(s.colors), s.tools.areaColor, (hex) => (s.tools.areaColor = hex));
		}
	}

	destroy(): void {
		this.ac.abort();
		this.ro.disconnect();
		this.toolbar.destroy();
		this.el.remove();
	}
}
