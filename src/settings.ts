import { type App, PluginSettingTab, Setting, type SettingDefinition, type SettingDefinitionItem } from "obsidian";
import type PenDFPlugin from "./main";
import { ZOOM_PRESETS, isZoomPreset, type ZoomPreset } from "./zoom/presets";
import { MARGIN_RATIOS, type MarginConfig, type MarginSide } from "./margin/model";

export interface HighlightColor {
	name: string;
	hex: string;
}

export interface PenDFSettings {
	colors: HighlightColor[];
	defaultColor: number;
	/** open every PDF in penDF instead of Obsidian's PDF viewer */
	openPdfsInPenDF: boolean;
	/** invert page colors (canvas only) — for dark mode reading */
	invertPages: boolean;
	debugHud: boolean;
	penProbe: boolean;
	/** canvas size / memory preset for zoom rendering (0.7.2, diagnostics) */
	zoomRendering: ZoomPreset;
	/** remember page/zoom per file across views */
	rememberPosition: boolean;
	/** per-file view memory (plugin data, never the sidecar): position, outline folding, margin */
	positions: Record<string, FileViewMemory>;
	/** where the toolbar's panel button and the panel commands open the panel (0.8.0) */
	panelLocation: "view" | "sidebar";
	/** default side and width of a newly opened margin (0.8.0) */
	marginSide: MarginSide;
	marginRatio: number;
	/** handwriting (Phase 6) */
	ink: InkSettings;
}

export interface FileViewMemory {
	page?: number;
	scale?: string;
	/** last change, ms (the oldest entries are dropped beyond MAX_POSITIONS) */
	t: number;
	/** keys of the outline entries the user left expanded */
	outline?: string[];
	/** margin shown / side / width for this file (a view setting — never in the sidecar) */
	margin?: MarginConfig;
}

export type InkTool = "pen" | "highlighter" | "eraser";

export interface InkSettings {
	tool: InkTool;
	penColor: string;
	/** pt */
	penWidth: number;
	highlighterColor: string;
	/** pt */
	highlighterWidth: number;
	/**
	 * "stylus": Apple Pencil draws, fingers scroll and select (default).
	 * "exclusive": in ink mode every pointer draws and the page does not scroll by touch
	 * (fallback for devices where the Pencil would otherwise scroll the page).
	 */
	input: "stylus" | "exclusive";
	/** the Apple Pencil writes whenever it touches a page, without turning on ink mode */
	pencilAlways: boolean;
}

export const PEN_COLORS = ["#1f1f1f", "#1f5fbf", "#c62828", "#2e7d32"];
export const PEN_WIDTHS = [0.75, 1.5, 3];

export const DEFAULT_SETTINGS: PenDFSettings = {
	colors: [
		{ name: "Yellow", hex: "#ffd400" },
		{ name: "Green", hex: "#5fb236" },
		{ name: "Blue", hex: "#2ea8e5" },
		{ name: "Pink", hex: "#ff6680" },
	],
	defaultColor: 0,
	openPdfsInPenDF: true,
	invertPages: false,
	debugHud: false,
	penProbe: false,
	zoomRendering: "default",
	rememberPosition: true,
	positions: {},
	panelLocation: "view",
	marginSide: "right",
	marginRatio: 0.5,
	ink: { tool: "pen", penColor: "#1f1f1f", penWidth: 1.5, highlighterColor: "#ffd400", highlighterWidth: 12, input: "stylus", pencilAlways: true },
};

export const MAX_POSITIONS = 300;

type BoolKey = "openPdfsInPenDF" | "invertPages" | "rememberPosition" | "debugHud" | "penProbe";

const TEXT = {
	highlights: "Highlights",
	defaultColor: ["Default color", "Used by the highlight command and keyboard shortcut."],
	viewer: "Viewer",
	openPdfsInPenDF: ["Open PDFs in penDF", "Use penDF instead of Obsidian's PDF viewer whenever a PDF is opened. Embeds in notes and hover previews still use Obsidian's viewer."],
	invertPages: ["Invert page colors", "Dark reading mode: inverts the rendered pages (not your highlights)."],
	rememberPosition: ["Remember position", "Reopen each PDF at the page and zoom you left it."],
	margin: ["Margin", "Space beside the page for notes and handwriting (toolbar button or command “Toggle margin”). Side and width of a new margin; each PDF remembers its own."],
	panelLocation: ["Panel location", "Where the panel button and the panel commands (outline, page thumbnails, search, bookmarks, annotations) open the panel: inside the penDF view, or in Obsidian's right sidebar."],
	handwriting: "Handwriting",
	inkPencilAlways: ["Apple Pencil always writes", "The Pencil writes whenever it touches a page, with the last tool you picked (pen, highlighter or eraser); fingers scroll and select text. Off: the Pencil writes only in ink mode (toolbar pen button)."],
	inkInput: ["Pencil and finger", "Default: the Pencil writes, fingers scroll and select text. If the Pencil scrolls the page instead of writing on your device, choose “Everything writes” (then leave ink mode to scroll)."],
	diagnostics: "Diagnostics",
	debugHud: ["Debug overlay", "Shows pages being rendered, render time, canvas count and annotation count."],
	penProbe: ["Pen probe", "Enables the 'Open pen probe' command: measures Apple Pencil / touch input in this webview."],
	zoomRendering: [
		"Zoom rendering",
		"How large page canvases may get, and how much canvas memory penDF keeps. Try another preset if zooming flashes or the app restarts on your device. \"0.7.1 canvas cap\" is for diagnosis only (it brings back 0.7.1's large canvases and no memory limit) — not for everyday use. Open PDFs reopen when you change it.",
	],
} as const;

/**
 * Obsidian 1.13+ renders this tab from getSettingDefinitions() (which also
 * makes the settings searchable); older versions call display().
 * Control keys: the boolean setting names, "defaultColor", and
 * "color.<i>.name" / "color.<i>.hex" for the four highlight colors.
 */
export class PenDFSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: PenDFPlugin) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.plugin.settings;
		const toggle = (key: BoolKey): SettingDefinition => ({
			name: TEXT[key][0],
			desc: TEXT[key][1],
			control: { type: "toggle", key },
		});
		return [
			{
				type: "group",
				heading: TEXT.highlights,
				items: [
					...s.colors.flatMap((_, i) => [
						{ name: `Color ${i + 1} name`, control: { type: "text" as const, key: `color.${i}.name` } },
						{ name: `Color ${i + 1}`, control: { type: "color" as const, key: `color.${i}.hex` } },
					]),
					{
						name: TEXT.defaultColor[0],
						desc: TEXT.defaultColor[1],
						control: { type: "dropdown", key: "defaultColor", options: Object.fromEntries(s.colors.map((c, i) => [String(i), c.name])) },
					},
				],
			},
			{
				type: "group",
				heading: TEXT.viewer,
				items: [
					toggle("openPdfsInPenDF"),
					toggle("invertPages"),
					toggle("rememberPosition"),
					{ name: TEXT.panelLocation[0], desc: TEXT.panelLocation[1], control: { type: "dropdown", key: "panelLocation", options: { view: "In the penDF view", sidebar: "Obsidian sidebar" } } },
					{ name: TEXT.margin[0], desc: TEXT.margin[1], control: { type: "dropdown", key: "marginSide", options: { right: "Right of the page", left: "Left of the page" } } },
					{ name: "Margin width", desc: "Share of the page width.", control: { type: "dropdown", key: "marginRatio", options: Object.fromEntries(MARGIN_RATIOS.map((r) => [String(r), `${Math.round(r * 100)} %`])) } },
				],
			},
			{
				type: "group",
				heading: TEXT.handwriting,
				items: [
					{ name: TEXT.inkPencilAlways[0], desc: TEXT.inkPencilAlways[1], control: { type: "toggle", key: "inkPencilAlways" } },
					{
						name: TEXT.inkInput[0],
						desc: TEXT.inkInput[1],
						control: { type: "dropdown", key: "inkInput", options: { stylus: "Pencil writes, finger scrolls", exclusive: "Everything writes (in ink mode)" } },
					},
				],
			},
			{
				type: "group",
				heading: TEXT.diagnostics,
				items: [
					toggle("debugHud"),
					toggle("penProbe"),
					{ name: TEXT.zoomRendering[0], desc: TEXT.zoomRendering[1], control: { type: "dropdown", key: "zoomRendering", options: { ...ZOOM_PRESETS } } },
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		const m = /^color\.(\d)\.(name|hex)$/.exec(key);
		if (m) return s.colors[Number(m[1])]?.[m[2] as "name" | "hex"];
		if (key === "defaultColor") return String(s.defaultColor);
		if (key === "inkInput") return s.ink.input;
		if (key === "inkPencilAlways") return s.ink.pencilAlways;
		if (key === "zoomRendering") return s.zoomRendering;
		if (key === "panelLocation") return s.panelLocation;
		if (key === "marginSide") return s.marginSide;
		if (key === "marginRatio") return String(s.marginRatio);
		return s[key as BoolKey];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		this.apply(key, value);
		// A renamed color shows up in the default-color dropdown the next time
		// the tab is opened (getSettingDefinitions() runs on every display).
		await this.plugin.saveSettings();
	}

	private apply(key: string, value: unknown): void {
		const s = this.plugin.settings;
		const m = /^color\.(\d)\.(name|hex)$/.exec(key);
		if (m) {
			const c = s.colors[Number(m[1])];
			if (!c) return;
			if (m[2] === "name") c.name = String(value).trim() || c.name;
			else c.hex = String(value);
		} else if (key === "defaultColor") {
			s.defaultColor = Number(value);
		} else if (key === "inkPencilAlways") {
			s.ink = { ...s.ink, pencilAlways: Boolean(value) };
		} else if (key === "inkInput") {
			s.ink = { ...s.ink, input: value === "exclusive" ? "exclusive" : "stylus" };
		} else if (key === "marginSide") {
			s.marginSide = value === "left" ? "left" : "right";
		} else if (key === "marginRatio") {
			const r = Number(value);
			s.marginRatio = (MARGIN_RATIOS as readonly number[]).includes(r) ? r : 0.5;
		} else if (key === "panelLocation") {
			s.panelLocation = value === "sidebar" ? "sidebar" : "view";
		} else if (key === "zoomRendering") {
			s.zoomRendering = isZoomPreset(value) ? value : "default";
		} else {
			const k = key as BoolKey;
			s[k] = Boolean(value);
			if (k === "rememberPosition" && !s[k]) s.positions = {};
		}
	}

	/** Fallback for Obsidian < 1.13. */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const set = (key: string, value: unknown): void => {
			this.apply(key, value);
			void this.plugin.saveSettings();
		};

		new Setting(containerEl).setName(TEXT.highlights).setHeading();
		s.colors.forEach((c, i) => {
			new Setting(containerEl)
				.setName(`Color ${i + 1}`)
				.addText((t) => t.setValue(c.name).onChange((v) => set(`color.${i}.name`, v)))
				.addColorPicker((cp) => cp.setValue(c.hex).onChange((v) => set(`color.${i}.hex`, v)));
		});
		new Setting(containerEl)
			.setName(TEXT.defaultColor[0])
			.setDesc(TEXT.defaultColor[1])
			.addDropdown((d) => {
				for (const [i, c] of s.colors.entries()) d.addOption(String(i), c.name);
				d.setValue(String(s.defaultColor)).onChange((v) => set("defaultColor", v));
			});

		const toggle = (key: BoolKey): void => {
			new Setting(containerEl)
				.setName(TEXT[key][0])
				.setDesc(TEXT[key][1])
				.addToggle((t) => t.setValue(s[key]).onChange((v) => set(key, v)));
		};
		new Setting(containerEl).setName(TEXT.viewer).setHeading();
		toggle("openPdfsInPenDF");
		toggle("invertPages");
		toggle("rememberPosition");
		new Setting(containerEl)
			.setName(TEXT.panelLocation[0])
			.setDesc(TEXT.panelLocation[1])
			.addDropdown((d) =>
				d
					.addOption("view", "In the penDF view")
					.addOption("sidebar", "Obsidian sidebar")
					.setValue(s.panelLocation)
					.onChange((v) => set("panelLocation", v)),
			);
		new Setting(containerEl)
			.setName(TEXT.margin[0])
			.setDesc(TEXT.margin[1])
			.addDropdown((d) =>
				d
					.addOption("right", "Right of the page")
					.addOption("left", "Left of the page")
					.setValue(s.marginSide)
					.onChange((v) => set("marginSide", v)),
			)
			.addDropdown((d) => {
				for (const r of MARGIN_RATIOS) d.addOption(String(r), `${Math.round(r * 100)} %`);
				d.setValue(String(s.marginRatio)).onChange((v) => set("marginRatio", v));
			});
		new Setting(containerEl).setName(TEXT.handwriting).setHeading();
		new Setting(containerEl)
			.setName(TEXT.inkPencilAlways[0])
			.setDesc(TEXT.inkPencilAlways[1])
			.addToggle((t) => t.setValue(s.ink.pencilAlways).onChange((v) => set("inkPencilAlways", v)));
		new Setting(containerEl)
			.setName(TEXT.inkInput[0])
			.setDesc(TEXT.inkInput[1])
			.addDropdown((d) =>
				d
					.addOption("stylus", "Pencil writes, finger scrolls")
					.addOption("exclusive", "Everything writes (in ink mode)")
					.setValue(s.ink.input)
					.onChange((v) => set("inkInput", v)),
			);
		new Setting(containerEl).setName(TEXT.diagnostics).setHeading();
		toggle("debugHud");
		toggle("penProbe");
		new Setting(containerEl)
			.setName(TEXT.zoomRendering[0])
			.setDesc(TEXT.zoomRendering[1])
			.addDropdown((d) => {
				for (const [k, label] of Object.entries(ZOOM_PRESETS)) d.addOption(k, label);
				d.setValue(s.zoomRendering).onChange((v) => set("zoomRendering", v));
			});
	}
}
