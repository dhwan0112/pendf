import { FuzzySuggestModal, Notice, Plugin, TFile, normalizePath, type App, type TAbstractFile } from "obsidian";
import { PdfPppView, VIEW_TYPE } from "./view/PdfView";
import { PEN_PROBE_VIEW, PenProbeView } from "./probe/PenProbeView";
import { DEFAULT_SETTINGS, MAX_POSITIONS, PdfPppSettingTab, type PdfPppSettings } from "./settings";
import { destroyWorker } from "./pdfjs";
import { checkEngine, type EngineReport } from "./pdfjs/engine";
import { moveSidecar, type SidecarStore } from "./store/sidecar";
import { adapterFs } from "./store/obsidianFs";
import { sidecarPathFor } from "./store/schema";
import { formatLog, logger } from "./util/log";

const log = logger("plugin");

export default class PdfPppPlugin extends Plugin {
	settings: PdfPppSettings = structuredClone(DEFAULT_SETTINGS);
	engine: EngineReport = { ok: true, missing: [], ponyfilled: {} };
	private stores = new Set<SidecarStore>();
	private saveSettingsTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.engine = checkEngine();
		log.info(`engine: ${navigator.userAgent} → ${JSON.stringify(this.engine)}`);
		if (!this.engine.ok) log.warn(`missing JavaScript features: ${this.engine.missing.join(", ")}`);
		this.registerView(VIEW_TYPE, (leaf) => new PdfPppView(leaf, this));
		this.registerView(PEN_PROBE_VIEW, (leaf) => new PenProbeView(leaf));
		this.addSettingTab(new PdfPppSettingTab(this.app, this));

		// Entry points. PDF is a core extension, so plugins cannot become its
		// default view through the public API; we offer explicit "open with".
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "pdf") return;
				menu.addItem((item) =>
					item
						.setTitle("Open in PDF+++")
						.setIcon("book-open-text")
						.setSection("open")
						.onClick(() => void this.openPdf(file)),
				);
			}),
		);

		this.addCommand({
			id: "open-current-pdf",
			name: "Open current PDF in PDF+++",
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				if (!f || f.extension !== "pdf") return false;
				if (!checking) void this.openPdf(f, false);
				return true;
			},
		});
		this.addCommand({
			id: "open-pdf",
			name: "Open a PDF…",
			callback: () => new PdfSuggestModal(this.app, (f) => void this.openPdf(f)).open(),
		});
		this.addCommand({
			id: "find",
			name: "Find in PDF",
			checkCallback: (checking) => this.withView(checking, (v) => v.openSearch()),
		});
		this.addCommand({
			id: "highlight-selection",
			name: "Highlight selection (default color)",
			checkCallback: (checking) => this.withView(checking, (v) => v.highlights?.createFromSelection()),
		});
		this.addCommand({
			id: "undo",
			name: "Undo annotation change",
			checkCallback: (checking) => this.withView(checking, (v) => v.undo()),
		});
		this.addCommand({
			id: "redo",
			name: "Redo annotation change",
			checkCallback: (checking) => this.withView(checking, (v) => v.redo()),
		});
		this.addCommand({ id: "zoom-in", name: "Zoom in", checkCallback: (c) => this.withView(c, (v) => v.zoom(1)) });
		this.addCommand({ id: "zoom-out", name: "Zoom out", checkCallback: (c) => this.withView(c, (v) => v.zoom(-1)) });
		this.addCommand({ id: "fit-width", name: "Fit width", checkCallback: (c) => this.withView(c, (v) => v.setScale("page-width")) });
		this.addCommand({ id: "export-log", name: "Export log to vault", callback: () => void this.exportLog() });
		this.addCommand({
			id: "open-pen-probe",
			name: "Open pen probe (diagnostics)",
			checkCallback: (checking) => {
				if (!this.settings.penProbe) return false;
				if (!checking) void this.app.workspace.getLeaf("tab").setViewState({ type: PEN_PROBE_VIEW, active: true });
				return true;
			},
		});

		// Keep sidecars next to their PDFs.
		const fs = adapterFs(this.app.vault.adapter);
		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				if (!(file instanceof TFile) || file.extension !== "pdf") return;
				void this.onPdfRenamed(fs, file, oldPath);
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				if (file instanceof TFile && file.extension === "pdf") {
					log.info(`PDF deleted: ${file.path}; its sidecar ${sidecarPathFor(file.path)} (if any) is kept`);
				}
			}),
		);

		// Flush annotation writes when the app goes to the background (iPad).
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "hidden") void this.flushAll();
		});
		this.registerDomEvent(window, "pagehide", () => void this.flushAll());
	}

	async onunload(): Promise<void> {
		// Close every open document (saves annotations) before the worker goes
		// away; Obsidian detaches the leaves afterwards.
		const views = this.app.workspace
			.getLeavesOfType(VIEW_TYPE)
			.map((l) => l.view)
			.filter((v): v is PdfPppView => v instanceof PdfPppView);
		await Promise.all(views.map((v) => v.closeSession().catch((e) => log.error("closing view failed", e))));
		await this.flushAll();
		if (this.saveSettingsTimer !== null) {
			window.clearTimeout(this.saveSettingsTimer);
			this.saveSettingsTimer = null;
			await this.saveData(this.settings);
		}
		destroyWorker(true);
	}

	/** Log ring buffer as text (diagnostics; also used by the dev harness). */
	getLogText(): string {
		return formatLog();
	}

	private withView(checking: boolean, fn: (v: PdfPppView) => void): boolean {
		const v = this.app.workspace.getActiveViewOfType(PdfPppView);
		if (!v) return false;
		if (!checking) fn(v);
		return true;
	}

	async openPdf(file: TFile, newTab = true): Promise<void> {
		const leaf = newTab ? this.app.workspace.getLeaf("tab") : this.app.workspace.getLeaf(false);
		await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
	}

	trackStore(s: SidecarStore): void {
		this.stores.add(s);
	}
	untrackStore(s: SidecarStore): void {
		this.stores.delete(s);
	}

	private async flushAll(): Promise<void> {
		await Promise.all(
			[...this.stores].map((s) =>
				s.flush().catch((e) => log.error(`flush ${s.path} failed`, e)),
			),
		);
	}

	private async onPdfRenamed(fs: ReturnType<typeof adapterFs>, file: TFile, oldPath: string): Promise<void> {
		// Flush first so the moved file has the latest edits.
		const open = [...this.stores].filter((s) => s.path === sidecarPathFor(oldPath));
		for (const s of open) await s.flush().catch(() => undefined);
		try {
			const r = await moveSidecar(fs, oldPath, file.path);
			if (r === "moved") log.info(`moved sidecar ${sidecarPathFor(oldPath)} → ${sidecarPathFor(file.path)}`);
			if (r === "target-exists") {
				log.warn(`not moving sidecar: ${sidecarPathFor(file.path)} already exists`);
				new Notice(`PDF+++: ${sidecarPathFor(file.path)} already exists; annotations stayed in ${sidecarPathFor(oldPath)}.`);
			}
		} catch (e) {
			log.error(`moving sidecar for ${oldPath} failed`, e);
		}
		for (const s of open) s.setPdfPath(file.path);
		const pos = this.settings.positions[oldPath];
		if (pos) {
			delete this.settings.positions[oldPath];
			this.settings.positions[file.path] = pos;
			this.saveSettingsSoon();
		}
	}

	rememberPosition(path: string, page: number, scale: string): void {
		if (!this.settings.rememberPosition) return;
		this.settings.positions[path] = { page, scale, t: Date.now() };
		const keys = Object.keys(this.settings.positions);
		if (keys.length > MAX_POSITIONS) {
			keys.sort((a, b) => this.settings.positions[a].t - this.settings.positions[b].t);
			for (const k of keys.slice(0, keys.length - MAX_POSITIONS)) delete this.settings.positions[k];
		}
		this.saveSettingsSoon();
	}

	private saveSettingsSoon(): void {
		if (this.saveSettingsTimer !== null) window.clearTimeout(this.saveSettingsTimer);
		this.saveSettingsTimer = window.setTimeout(() => {
			this.saveSettingsTimer = null;
			void this.saveData(this.settings);
		}, 2000);
	}

	async loadSettings(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as Partial<PdfPppSettings>;
		this.settings = { ...structuredClone(DEFAULT_SETTINGS), ...data };
		if (!Array.isArray(this.settings.colors) || this.settings.colors.length !== 4) this.settings.colors = structuredClone(DEFAULT_SETTINGS.colors);
		if (typeof this.settings.positions !== "object" || !this.settings.positions) this.settings.positions = {};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof PdfPppView) leaf.view.applySettings();
		}
	}

	private async exportLog(): Promise<void> {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const path = normalizePath(`pdf-ppp-log-${stamp}.md`);
		const body = "```\n" + formatLog() + "\n```\n";
		await this.app.vault.create(path, `# PDF+++ log ${stamp}\n\n${body}`);
		new Notice(`PDF+++ log saved to ${path}`);
	}
}

class PdfSuggestModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private readonly onPick: (f: TFile) => void) {
		super(app);
		this.setPlaceholder("Open a PDF in PDF+++");
	}
	getItems(): TFile[] {
		return this.app.vault.getFiles().filter((f) => f.extension === "pdf");
	}
	getItemText(f: TFile): string {
		return f.path;
	}
	onChooseItem(f: TFile): void {
		this.onPick(f);
	}
}
