import { FuzzySuggestModal, Notice, Plugin, TFile, normalizePath, type App, type TAbstractFile, type WorkspaceLeaf } from "obsidian";
import { TOOL_IDS, isToolId, normalizeOpacity } from "./tools/model";
import { TOOL_LABELS } from "./tools/palette";
import { PenDFView, VIEW_TYPE } from "./view/PdfView";
import { PEN_PROBE_VIEW, PenProbeView } from "./probe/PenProbeView";
import { ANNOTATIONS_VIEW, AnnotationsView, type PanelTab } from "./panel/AnnotationsView";
import { DEFAULT_SETTINGS, MAX_POSITIONS, PenDFSettingTab, type FileViewMemory, type PenDFSettings } from "./settings";
import { destroyWorker } from "./pdfjs";
import { checkEngine, type EngineReport } from "./pdfjs/engine";
import { moveSidecar, type SidecarStore } from "./store/sidecar";
import { adapterFs } from "./store/obsidianFs";
import { sidecarPathFor } from "./store/schema";
import { formatLog, logger } from "./util/log";
import { describePlatform } from "./util/platform";
import { LinkRecorder } from "./links/recorder";
import { aliasFrom } from "./links/format";
import { isZoomPreset } from "./zoom/presets";
import { MARGIN_RATIOS } from "./margin/model";
import { VaultAnnotationIndex } from "./index/service";
import { AnnotationSearchModal } from "./index/SearchModal";
import { buildSubpath } from "./links/format";
import type { SearchResult } from "./index/model";

const log = logger("plugin");

export default class PenDFPlugin extends Plugin {
	settings: PenDFSettings = structuredClone(DEFAULT_SETTINGS);
	engine: EngineReport = { ok: true, missing: [], ponyfilled: {} };
	private stores = new Set<SidecarStore>();
	private saveSettingsTimer: number | null = null;
	/** vault-wide annotation index (0.8.0) */
	annotationIndex: VaultAnnotationIndex | null = null;
	/** Leaves the user deliberately opened in Obsidian's PDF viewer, with that file's path. */
	private keepCore = new WeakMap<WorkspaceLeaf, string>();
	private takingOver = new WeakSet<WorkspaceLeaf>();
	private links!: LinkRecorder;
	/** link position handed to a tab; reused if Obsidian's own, slower open puts its viewer back once more */
	private leafLink = new WeakMap<WorkspaceLeaf, { path: string; subpath: string; t: number }>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.engine = checkEngine();
		log.info(`engine: ${JSON.stringify(describePlatform())} → ${JSON.stringify(this.engine)}`);
		if (!this.engine.ok) log.warn(`missing JavaScript features: ${this.engine.missing.join(", ")}`);
		this.registerView(VIEW_TYPE, (leaf) => new PenDFView(leaf, this));
		this.registerView(PEN_PROBE_VIEW, (leaf) => new PenProbeView(leaf));
		this.registerView(ANNOTATIONS_VIEW, (leaf) => new AnnotationsView(leaf));
		this.addSettingTab(new PenDFSettingTab(this.app, this));

		// Entry points. PDF is a core extension, so a plugin cannot register
		// itself as the view for ".pdf". With "Open PDFs in penDF" on, a tab
		// that Obsidian opens in its PDF viewer is switched to penDF right away
		// (public WorkspaceLeaf API only; the core viewer is left untouched).
		// The file menu offers the other viewer either way.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "pdf") return;
				if (this.settings.openPdfsInPenDF) {
					menu.addItem((item) =>
						item
							.setTitle("Open in Obsidian's PDF viewer")
							.setIcon("file-text")
							.setSection("open")
							.onClick(() => void this.openInCoreViewer(file)),
					);
				} else {
					menu.addItem((item) =>
						item
							.setTitle("Open in penDF")
							.setIcon("book-open-text")
							.setSection("open")
							.onClick(() => void this.openPdf(file)),
					);
				}
			}),
		);
		// remember which PDF link was pressed, so its position survives the takeover (Phase 4)
		this.links = new LinkRecorder(this.app);
		this.registerEditorExtension(this.links.editorExtension());
		this.registerDomEvent(activeDocument, "pointerdown", this.links.onPointerDown, { capture: true });
		this.registerEvent(
			this.app.workspace.on("window-open", (_w, win) => {
				this.registerDomEvent(win.document, "pointerdown", this.links.onPointerDown, { capture: true });
			}),
		);
		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => leaf && this.takeOver(leaf)));
			this.registerEvent(
				this.app.workspace.on("file-open", (file) => {
					const leaf = this.app.workspace.getMostRecentLeaf();
					if (file?.extension === "pdf" && leaf) this.takeOver(leaf);
				}),
			);
			const leaf = this.app.workspace.getMostRecentLeaf();
			if (leaf) this.takeOver(leaf);
		});

		this.addCommand({
			id: "open-current-pdf",
			name: "Open current PDF",
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
		this.addCommand({ id: "export-zoom-timeline", name: "Export last zoom timeline to vault", checkCallback: (c) => this.withView(c, (v) => void this.exportZoomTimeline(v)) });
		this.addCommand({ id: "show-annotations", name: "Show annotations panel", callback: () => void this.showAnnotationsPanel("annotations") });
		this.addCommand({ id: "show-outline", name: "Show outline", callback: () => void this.showAnnotationsPanel("outline") });
		this.addCommand({ id: "show-pages", name: "Show page thumbnails", callback: () => void this.showAnnotationsPanel("pages") });
		this.addCommand({ id: "search-all", name: "Search the whole PDF", callback: () => void this.showAnnotationsPanel("search") });
		this.addCommand({ id: "show-bookmarks", name: "Show bookmarks", callback: () => void this.showAnnotationsPanel("bookmarks") });
		this.addCommand({ id: "toggle-ink", name: "Toggle handwriting (last ink tool ↔ no tool)", checkCallback: (c) => this.withView(c, (v) => v.toggleInk()) });
		// one command per palette tool (D-46): hotkeys on a desktop or an iPad keyboard
		for (const t of TOOL_IDS) {
			this.addCommand({ id: `select-tool-${t}`, name: `Select tool: ${TOOL_LABELS[t].label}`, checkCallback: (c) => this.withView(c, (v) => v.setTool(t)) });
		}
		this.addCommand({ id: "toggle-tool-palette", name: "Show or hide the tool palette", checkCallback: (c) => this.withView(c, (v) => v.palette?.setCollapsed(!v.palette.collapsed)) });
		this.addCommand({ id: "toggle-margin", name: "Toggle margin", checkCallback: (c) => this.withView(c, (v) => v.toggleMargin()) });
		this.addCommand({ id: "area-excerpt", name: "Area excerpt", checkCallback: (c) => this.withView(c, (v) => v.toggleArea()) });
		this.addCommand({ id: "add-bookmark", name: "Bookmark this spot", checkCallback: (c) => this.withView(c, (v) => void v.addBookmark()) });
		this.addCommand({ id: "copy-page-link", name: "Copy link to current page", checkCallback: (c) => this.withView(c, (v) => v.copyPageLink()) });
		this.addCommand({
			id: "copy-selection-link",
			name: "Copy link to selection",
			checkCallback: (c) =>
				this.withView(c, (v) => {
					const t = v.highlights?.selectionTarget();
					if (t) v.copyLink({ page: t.page, rect: t.rect }, aliasFrom(t.text) || `p. ${t.page}`);
					else new Notice("penDF: select some text first");
				}),
		});
		this.addCommand({
			id: "add-note",
			name: "Add note (then tap the page)",
			checkCallback: (c) => this.withView(c, (v) => v.setTool("note")),
		});
		this.addCommand({
			id: "open-pen-probe",
			name: "Open pen probe (diagnostics)",
			checkCallback: (checking) => {
				if (!this.settings.penProbe) return false;
				if (!checking) void this.app.workspace.getLeaf("tab").setViewState({ type: PEN_PROBE_VIEW, active: true });
				return true;
			},
		});

		// Vault-wide annotation index (Phase 8 groundwork): lazy build, then kept current by vault events.
		this.annotationIndex = new VaultAnnotationIndex(this.app, this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`);
		const index = this.annotationIndex;
		this.registerEvent(this.app.vault.on("create", (f) => index.onCreateOrModify(f)));
		this.registerEvent(this.app.vault.on("modify", (f) => index.onCreateOrModify(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => index.onDelete(f)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => index.onRename(f, old)));
		this.app.workspace.onLayoutReady(() => {
			window.setTimeout(() => void index.ensure(), 4000);
		});
		this.addCommand({
			id: "search-vault-annotations",
			name: "Search annotations in vault",
			callback: () => new AnnotationSearchModal(this.app, (q) => index.search(q), () => this.settings.colors, (r) => void this.openAnnotation(r)).open(),
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
		const doc = activeDocument;
		this.registerDomEvent(doc, "visibilitychange", () => {
			if (doc.visibilityState === "hidden") void this.flushAll();
		});
		this.registerDomEvent(window, "pagehide", () => void this.flushAll());
	}

	onunload(): void {
		// Obsidian does not await onunload; the work is async, so run it detached.
		void this.annotationIndex?.dispose();
		void this.shutdown();
	}

	private async shutdown(): Promise<void> {
		// Close every open document (saves annotations) before the worker goes
		// away; Obsidian detaches the leaves afterwards.
		const views = this.app.workspace
			.getLeavesOfType(VIEW_TYPE)
			.map((l) => l.view)
			.filter((v): v is PenDFView => v instanceof PenDFView);
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

	private withView(checking: boolean, fn: (v: PenDFView) => void): boolean {
		const v = this.app.workspace.getActiveViewOfType(PenDFView);
		if (!v) return false;
		if (!checking) fn(v);
		return true;
	}

	/** Open penDF at an indexed annotation (its PDF's current path). */
	async openAnnotation(r: Pick<SearchResult, "paths" | "path" | "page" | "id">): Promise<void> {
		const path = r.path || r.paths[0];
		const f = path ? this.app.vault.getAbstractFileByPath(path) : null;
		if (!(f instanceof TFile)) {
			new Notice(`penDF: the PDF of this annotation is not in the vault (${path ?? "no path"})`);
			return;
		}
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE, state: { file: f.path }, active: true });
		leaf.setEphemeralState({ subpath: buildSubpath({ page: r.page, id: r.id }) });
	}

	async openPdf(file: TFile, newTab = true): Promise<void> {
		const leaf = newTab ? this.app.workspace.getLeaf("tab") : this.app.workspace.getLeaf(false);
		await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
	}

	/** Reveal the panel in the right sidebar (creating it once), optionally on a tab. */
	/**
	 * Open the panel where the "Panel location" setting says: inside the active (or most
	 * recent) penDF view, or Obsidian's right sidebar. Without a penDF view: the sidebar.
	 */
	async showAnnotationsPanel(tab?: PanelTab): Promise<void> {
		if (this.settings.panelLocation === "view") {
			const recent = this.app.workspace.getMostRecentLeaf();
			const view = recent?.view instanceof PenDFView ? recent.view : this.app.workspace.getLeavesOfType(VIEW_TYPE).map((l) => l.view).find((v): v is PenDFView => v instanceof PenDFView);
			if (view) {
				view.openPanel(tab);
				return;
			}
		}
		await this.showSidebarPanel(tab);
	}

	/** The panel in Obsidian's right sidebar. */
	async showSidebarPanel(tab?: PanelTab): Promise<void> {
		const ws = this.app.workspace;
		let leaf: WorkspaceLeaf | null = ws.getLeavesOfType(ANNOTATIONS_VIEW)[0] ?? null;
		if (!leaf) {
			leaf = ws.getRightLeaf(false);
			if (!leaf) return;
			await leaf.setViewState({ type: ANNOTATIONS_VIEW, active: true });
		}
		// revealLeaf() changed signature in 1.7.2 (minAppVersion is 1.5.7): open the sidebar and
		// activate the leaf with APIs from before 1.0 instead. Both sidebar kinds (desktop dock,
		// mobile drawer) have expand().
		const side: { expand(): void } = ws.rightSplit;
		side.expand();
		ws.setActiveLeaf(leaf, { focus: true });
		if (tab && leaf.view instanceof AnnotationsView) leaf.view.showTab(tab);
	}

	/** Open a PDF in Obsidian's own viewer, exempt from "Open PDFs in penDF". */
	async openInCoreViewer(file: TFile): Promise<void> {
		const leaf = this.app.workspace.getLeaf("tab");
		this.keepCore.set(leaf, file.path);
		await leaf.openFile(file, { active: true });
	}

	/**
	 * Switch a tab showing a PDF in Obsidian's viewer to penDF. Runs as soon as
	 * the tab opens, before Obsidian hands it the link's position (e.g.
	 * `#page=3`), so that position reaches penDF's setEphemeralState().
	 */
	private takeOver(leaf: WorkspaceLeaf): void {
		if (!this.settings.openPdfsInPenDF || this.takingOver.has(leaf)) return;
		const vs = leaf.getViewState();
		const path = (vs.state as { file?: unknown } | undefined)?.file;
		if (vs.type !== "pdf" || typeof path !== "string" || !path.toLowerCase().endsWith(".pdf")) return;
		if (this.keepCore.get(leaf) === path) return;
		this.keepCore.delete(leaf);
		this.takingOver.add(leaf);
		let subpath = this.links.take(path);
		const prev = this.leafLink.get(leaf);
		if (subpath) this.leafLink.set(leaf, { path, subpath, t: Date.now() });
		else if (prev && prev.path === path && Date.now() - prev.t < 5000) subpath = prev.subpath;
		log.info(`opening ${path}${subpath ?? ""} in penDF instead of the core PDF viewer`);
		leaf
			.setViewState({ type: VIEW_TYPE, state: { file: path }, active: vs.active ?? true }, subpath ? { subpath } : undefined)
			.catch((e) => log.error(`switching ${path} to penDF failed`, e))
			.finally(() => this.takingOver.delete(leaf));
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
				new Notice(`penDF: ${sidecarPathFor(file.path)} already exists; annotations stayed in ${sidecarPathFor(oldPath)}.`);
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
		this.patchFileMemory(path, { page, scale });
	}

	/** Per-file view memory (plugin data). */
	fileMemory(path: string): FileViewMemory | undefined {
		return this.settings.positions[path];
	}

	/** Merge into a file's view memory (keeps the other fields), drop the oldest entries beyond the cap. */
	patchFileMemory(path: string, patch: Partial<FileViewMemory>): void {
		this.settings.positions[path] = { ...(this.settings.positions[path] ?? {}), ...patch, t: Date.now() };
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
		const data = ((await this.loadData()) ?? {}) as Partial<PenDFSettings>;
		this.settings = { ...structuredClone(DEFAULT_SETTINGS), ...data };
		if (!Array.isArray(this.settings.colors) || this.settings.colors.length !== 4) this.settings.colors = structuredClone(DEFAULT_SETTINGS.colors);
		if (typeof this.settings.positions !== "object" || !this.settings.positions) this.settings.positions = {};
		this.settings.ink = { ...structuredClone(DEFAULT_SETTINGS.ink), ...(typeof data.ink === "object" && data.ink ? data.ink : {}) };
		this.settings.ink.highlighterOpacity = normalizeOpacity(this.settings.ink.highlighterOpacity);
		const t = { ...structuredClone(DEFAULT_SETTINGS.tools), ...(typeof data.tools === "object" && data.tools ? data.tools : {}) };
		if (!isToolId(t.last) || t.last === "note") t.last = "none";
		if (t.lastPen !== "highlighter") t.lastPen = "pen";
		for (const k of ["textColor", "areaColor"] as const) if (typeof t[k] !== "string" || !/^#[0-9a-f]{6}$/i.test(t[k])) t[k] = DEFAULT_SETTINGS.tools[k];
		t.collapsed = t.collapsed === true;
		this.settings.tools = t;
		if (!isZoomPreset(this.settings.zoomRendering)) this.settings.zoomRendering = DEFAULT_SETTINGS.zoomRendering;
		if (this.settings.panelLocation !== "sidebar") this.settings.panelLocation = "view";
		if (this.settings.marginSide !== "left") this.settings.marginSide = "right";
		if (![1, 2, 3, 4].includes(this.settings.areaImageScale)) this.settings.areaImageScale = 2;
		if (!(MARGIN_RATIOS as readonly number[]).includes(this.settings.marginRatio)) this.settings.marginRatio = 0.5;
	}

	private quietSaveTimer: number | null = null;

	/** Show a tool palette change in every open penDF view. */
	refreshToolViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof PenDFView) leaf.view.refreshTools();
		}
	}

	/** Save settings without re-applying them to the views (tool palette state), debounced. */
	saveQuietly(): void {
		if (this.quietSaveTimer !== null) window.clearTimeout(this.quietSaveTimer);
		this.quietSaveTimer = window.setTimeout(() => {
			this.quietSaveTimer = null;
			void this.saveData(this.settings);
		}, 250);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof PenDFView) leaf.view.applySettings();
		}
	}

	private async exportZoomTimeline(v: PenDFView): Promise<void> {
		const t = v.lastZoomTimeline();
		if (!t) {
			new Notice("penDF: no zoom gesture recorded yet in this view — pinch, then run the command again.");
			return;
		}
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const path = normalizePath(`pendf-zoom-${stamp}.json`);
		await this.app.vault.create(path, JSON.stringify(t, null, "\t"));
		new Notice(`penDF zoom timeline saved to ${path}`);
	}

	private async exportLog(): Promise<void> {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const path = normalizePath(`pendf-log-${stamp}.md`);
		const body = "```\n" + formatLog() + "\n```\n";
		await this.app.vault.create(path, `# penDF log ${stamp}\n\n${body}`);
		new Notice(`penDF log saved to ${path}`);
	}
}

class PdfSuggestModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private readonly onPick: (f: TFile) => void) {
		super(app);
		this.setPlaceholder("Open a PDF in penDF");
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
