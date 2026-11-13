import { type App, PluginSettingTab, Setting } from "obsidian";
import type PdfPppPlugin from "./main";

export interface HighlightColor {
	name: string;
	hex: string;
}

export interface PdfPppSettings {
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

export const DEFAULT_SETTINGS: PdfPppSettings = {
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

export class PdfPppSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: PdfPppPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		new Setting(containerEl).setName("Highlights").setHeading();
		s.colors.forEach((c, i) => {
			new Setting(containerEl)
				.setName(`Color ${i + 1}`)
				.addText((t) =>
					t.setValue(c.name).onChange(async (v) => {
						c.name = v.trim() || c.name;
						await this.plugin.saveSettings();
					}),
				)
				.addColorPicker((cp) =>
					cp.setValue(c.hex).onChange(async (v) => {
						c.hex = v;
						await this.plugin.saveSettings();
					}),
				);
		});
		new Setting(containerEl).setName("Default color").setDesc("Used by the highlight command and keyboard shortcut.").addDropdown((d) => {
			s.colors.forEach((c, i) => d.addOption(String(i), c.name));
			d.setValue(String(s.defaultColor)).onChange(async (v) => {
				s.defaultColor = Number(v);
				await this.plugin.saveSettings();
			});
		});

		new Setting(containerEl).setName("Viewer").setHeading();
		new Setting(containerEl)
			.setName("Invert page colors")
			.setDesc("Dark reading mode: inverts the rendered pages (not your highlights).")
			.addToggle((t) =>
				t.setValue(s.invertPages).onChange(async (v) => {
					s.invertPages = v;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("Remember position")
			.setDesc("Reopen each PDF at the page and zoom you left it.")
			.addToggle((t) =>
				t.setValue(s.rememberPosition).onChange(async (v) => {
					s.rememberPosition = v;
					if (!v) s.positions = {};
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName("Diagnostics").setHeading();
		new Setting(containerEl)
			.setName("Debug overlay")
			.setDesc("Shows pages being rendered, render time, canvas count and annotation count.")
			.addToggle((t) =>
				t.setValue(s.debugHud).onChange(async (v) => {
					s.debugHud = v;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("Pen probe")
			.setDesc("Enables the 'Open pen probe' command: measures Apple Pencil / touch input in this webview.")
			.addToggle((t) =>
				t.setValue(s.penProbe).onChange(async (v) => {
					s.penProbe = v;
					await this.plugin.saveSettings();
				}),
			);
	}
}
