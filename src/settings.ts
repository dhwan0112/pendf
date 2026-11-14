import { type App, PluginSettingTab, Setting, requireApiVersion, type SettingDefinition, type SettingDefinitionItem } from "obsidian";
import type PenDFPlugin from "./main";

export interface HighlightColor {
	name: string;
	hex: string;
}

export interface PenDFSettings {
	colors: HighlightColor[];
	defaultColor: number;
	/** invert page colors (canvas only) — for dark mode reading */
	invertPages: boolean;
	debugHud: boolean;
	penProbe: boolean;
	/** remember page/zoom per file across views */
	rememberPosition: boolean;
	positions: Record<string, { page: number; scale: string; t: number }>;
}

export const DEFAULT_SETTINGS: PenDFSettings = {
	colors: [
		{ name: "Yellow", hex: "#ffd400" },
		{ name: "Green", hex: "#5fb236" },
		{ name: "Blue", hex: "#2ea8e5" },
		{ name: "Pink", hex: "#ff6680" },
	],
	defaultColor: 0,
	invertPages: false,
	debugHud: false,
	penProbe: false,
	rememberPosition: true,
	positions: {},
};

export const MAX_POSITIONS = 300;

type BoolKey = "invertPages" | "rememberPosition" | "debugHud" | "penProbe";

const TEXT = {
	highlights: "Highlights",
	defaultColor: ["Default color", "Used by the highlight command and keyboard shortcut."],
	viewer: "Viewer",
	invertPages: ["Invert page colors", "Dark reading mode: inverts the rendered pages (not your highlights)."],
	rememberPosition: ["Remember position", "Reopen each PDF at the page and zoom you left it."],
	diagnostics: "Diagnostics",
	debugHud: ["Debug overlay", "Shows pages being rendered, render time, canvas count and annotation count."],
	penProbe: ["Pen probe", "Enables the 'Open pen probe' command: measures Apple Pencil / touch input in this webview."],
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
			{ type: "group", heading: TEXT.viewer, items: [toggle("invertPages"), toggle("rememberPosition")] },
			{ type: "group", heading: TEXT.diagnostics, items: [toggle("debugHud"), toggle("penProbe")] },
		];
	}

	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		const m = /^color\.(\d)\.(name|hex)$/.exec(key);
		if (m) return s.colors[Number(m[1])]?.[m[2] as "name" | "hex"];
		if (key === "defaultColor") return String(s.defaultColor);
		return s[key as BoolKey];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		this.apply(key, value);
		await this.plugin.saveSettings();
		// color names feed the default-color dropdown (update() is 1.13+, like this method)
		if (key.endsWith(".name") && requireApiVersion("1.13.0")) this.update();
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
		toggle("invertPages");
		toggle("rememberPosition");
		new Setting(containerEl).setName(TEXT.diagnostics).setHeading();
		toggle("debugHud");
		toggle("penProbe");
	}
}
