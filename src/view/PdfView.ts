// The penDF view: an independent FileView rendering PDFs with the bundled
// pdf.js. It never touches Obsidian's core PDF viewer or its DOM.

import { FileView, Modal, Notice, Platform, Scope, Setting, TFile, setIcon, setTooltip, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type PenDFPlugin from "../main";
import {
	AnnotationEditorType,
	AnnotationMode,
	EventBus,
	FindState,
	LinkTarget,
	PDFFindController,
	PDFLinkService,
	PDFViewer,
	TouchManager,
	openDocument,
	type OpenedDocument,
	workerMode,
} from "../pdfjs";
import { LayerManager, pageContentRect, svgEl } from "../layers";
import { HighlightController } from "../highlight/controller";
import { NoteController } from "../notes/controller";
import { InkController } from "../ink/controller";
import { PEN_COLORS, PEN_WIDTHS, type InkTool } from "../settings";
import { noteAnchor } from "../notes/model";
import type { Annotation, AreaAnnotation } from "../store/schema";
import { aliasFrom, buildSubpath, parseSubpath, type PdfTarget } from "../links/format";
import { defaultBookmarkTitle, orderAtEnd, reorder, sectionFor, sortedBookmarks, type OutlineEntry } from "../bookmarks/model";
import type { BookmarkAnnotation } from "../store/schema";
import { uuid } from "../store/schema";
import { promptText } from "../ui/prompt";
import { SidecarStore } from "../store/sidecar";
import { UndoStack } from "../store/undo";
import { adapterFs } from "../store/obsidianFs";
import { logger } from "../util/log";
import { DebugHud } from "../debug/hud";
import { ZoomController } from "../zoom/controller";
import { ZoomTimeline, summary as zoomSummary, type GestureRecord } from "../zoom/timeline";
import { renderConfig, type RenderConfig } from "../zoom/presets";
import { canvasBytes, pagesOverBudget, releasePage, type PageViewLike } from "../zoom/budget";
import { Toolbar } from "./toolbar";
import { DEFAULT_PANEL_STATE, InViewPanel, parsePanelState, type InViewPanelState } from "../panel/InViewPanel";
import type { PanelTab } from "../panel/tabs";
import { scrollToTopAnchor, topAnchor, type TopAnchor } from "../panel/layout";
import { MarginController, type MarginPageView } from "../margin/controller";
import { AreaController } from "../area/controller";
import { renderArea } from "../area/render";
import { quadBox, type TextItem } from "../area/model";
import { autoMargin, normalizeMargin, screenSide, type MarginConfig } from "../margin/model";

export const VIEW_TYPE = "pendf-view";
const log = logger("view");

interface ViewerState {
	page?: number;
	scale?: string;
}

/** Everything that exists only while a document is open. */
interface Session {
	file: TFile;
	opened: OpenedDocument;
	eventBus: EventBus;
	linkService: PDFLinkService;
	findController: PDFFindController;
	viewer: PDFViewer;
	layers: LayerManager;
	highlights: HighlightController;
	notes: NoteController;
	ink: InkController;
	store: SidecarStore | null;
	undo: UndoStack | null;
	ac: AbortController;
	ready: boolean;
	/** the PDF's own outline, resolved once on demand */
	outline: Promise<OutlineNode[]> | null;
	/** extracted page text for the search panel, by page */
	text: Map<number, Promise<PageText>>;
	/** pinch / trackpad zoom (0.7.2) */
	zoom: ZoomController;
	/** margin space beside the pages (0.8.0) */
	margin: MarginController;
	/** area excerpts (0.8.0) */
	area: AreaController;
	timeline: ZoomTimeline;
	render: RenderConfig;
}

/** A page's text for searching: items with their PDF-space boxes, and the joined, normalized text. */
interface PageText {
	items: TextItem[];
	/** normalized text of all items, joined with single spaces */
	joined: string;
}

export interface SearchHit {
	page: number;
	before: string;
	match: string;
	after: string;
	/** PDF-space box of the match (approximate) */
	rect: [number, number, number, number] | null;
}

/** Search normalization: case, width/compatibility forms and whitespace do not matter. */
export function normalizeForSearch(s: string): string {
	return s.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ");
}

/** An entry of the PDF's outline (its own bookmarks). */
export interface OutlineNode {
	title: string;
	/** pdf.js destination (name or explicit array) */
	dest: string | unknown[] | null;
	/** external URL instead of a destination */
	url: string | null;
	page: number | null;
	depth: number;
	items: OutlineNode[];
}

export class PenDFView extends FileView {
	/**
	 * Test hook (Obsidian harness only): render settings that replace the preset's for PDFs
	 * opened from now on, e.g. the mobile values on desktop. Never set by the plugin itself.
	 */
	static renderOverride: Partial<RenderConfig> | null = null;

	allowNoFile = false;
	navigation = true;

	private session: Session | null = null;
	private loadToken = 0;
	private pendingState: ViewerState | null = null;
	/** annotation / selection to go to once the document and its annotations are loaded */
	private pendingNav: PdfTarget | null = null;

	// DOM
	private toolbarEl!: HTMLElement;
	private toolbar: Toolbar | null = null;
	/** row holding the in-view panel and the pages */
	private bodyEl!: HTMLElement;
	/** panel inside the view (0.8.0) */
	panel: InViewPanel | null = null;
	private pendingPanel: InViewPanelState | null = null;
	/** the scale follows the view width ("Fit width"), tracked by penDF (pdf.js does not refit on resize) */
	private fitMode = true;
	private applyingFit = false;
	/** content at the top edge of the view, kept current while scrolling (restored after resizes) */
	private lastTop: TopAnchor | null = null;
	private topRaf: number | null = null;
	private containerRo: ResizeObserver | null = null;
	private widthTimer: number | null = null;
	private lastContainerWidth = 0;
	/** live thumbnail canvases (panels), counted against the canvas budget */
	private thumbs = new Set<HTMLCanvasElement>();
	private pageInput!: HTMLInputElement;
	private pageCountEl!: HTMLElement;
	private zoomLabel!: HTMLElement;
	private searchBar!: HTMLElement;
	private searchInput!: HTMLInputElement;
	private searchCount!: HTMLElement;
	private bannerEl!: HTMLElement;
	private viewerRoot!: HTMLElement;
	private container!: HTMLDivElement;
	private viewerEl!: HTMLDivElement;
	private hud: DebugHud | null = null;
	private saveStateTimer: number | null = null;
	private noteButton: HTMLButtonElement | null = null;
	private inkButton: HTMLButtonElement | null = null;
	private marginButton: HTMLButtonElement | null = null;
	private areaButton: HTMLButtonElement | null = null;
	private marginTimer: number | null = null;
	private inkBar!: HTMLElement;
	/** set while ink edits run, so the side panel is not re-rendered for every stroke */
	private quiet = false;
	private changeListeners = new Set<() => void>();
	private pageListeners = new Set<(page: number) => void>();

	constructor(leaf: WorkspaceLeaf, private readonly plugin: PenDFPlugin) {
		super(leaf);
		this.scope = new Scope(this.app.scope);
		this.scope.register(["Mod"], "f", () => {
			this.openSearch();
			return false;
		});
		this.scope.register(["Mod"], "z", () => {
			this.undo();
			return false;
		});
		this.scope.register(["Mod", "Shift"], "z", () => {
			this.redo();
			return false;
		});
		this.scope.register([], "Escape", () => {
			if (this.searchBar && !this.searchBar.hasClass("is-hidden")) {
				this.closeSearch();
				return false;
			}
			return true;
		});
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.file?.basename ?? "penDF";
	}

	getIcon(): string {
		return "book-open-text";
	}

	canAcceptExtension(extension: string): boolean {
		return extension === "pdf";
	}

	// ------------------------------------------------------------- DOM setup

	async onOpen(): Promise<void> {
		const el = this.contentEl;
		el.empty();
		el.addClass("pendf-view");

		this.toolbarEl = el.createDiv({ cls: "pendf-toolbar" });
		this.buildToolbar(this.toolbarEl);
		this.inkBar = el.createDiv({ cls: "pendf-inkbar is-hidden" });
		this.searchBar = el.createDiv({ cls: "pendf-searchbar is-hidden" });
		this.buildSearchBar(this.searchBar);
		this.bannerEl = el.createDiv({ cls: "pendf-banner is-hidden" });

		this.bodyEl = el.createDiv({ cls: "pendf-body" });
		this.viewerRoot = this.bodyEl.createDiv({ cls: "pendf-root" });
		this.container = this.viewerRoot.createDiv({ cls: "pendf-container" });
		this.container.tabIndex = 0;
		this.viewerEl = this.container.createDiv({ cls: "pdfViewer" });
		this.panel = new InViewPanel(this.app, this.bodyEl, this, () => this.app.workspace.requestSaveLayout());
		if (this.pendingPanel) {
			this.panel.setState(this.pendingPanel);
			this.pendingPanel = null;
		}
		this.installResizeKeeping();
		this.applySettings();
		this.showEngineWarning();

		this.registerDomEvent(window, "focus", () => void this.checkExternal());
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf === this.leaf) void this.checkExternal();
			}),
		);
	}

	private button(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement {
		const b = parent.createEl("button", { cls: "pendf-icon-btn clickable-icon", attr: { "aria-label": label } });
		setIcon(b, icon);
		setTooltip(b, label);
		b.addEventListener("click", (e) => {
			e.preventDefault();
			onClick();
		});
		return b;
	}

	private buildToolbar(tb: HTMLElement): void {
		const t = new Toolbar(tb);
		this.toolbar = t;
		// navigation & zoom
		const nav = t.group("navigate");
		t.add(nav, { id: "prev", icon: "chevron-up", label: "Previous page", priority: 2, run: () => this.session?.viewer.previousPage() });
		this.pageInput = nav.createEl("input", { cls: "pendf-page-input", attr: { type: "text", inputmode: "numeric", "aria-label": "Page" } });
		this.pageCountEl = nav.createSpan({ cls: "pendf-page-count", text: "/ –" });
		t.add(nav, { id: "next", icon: "chevron-down", label: "Next page", priority: 2, run: () => this.session?.viewer.nextPage() });
		this.pageInput.addEventListener("change", () => this.goToPage(Number(this.pageInput.value)));
		this.pageInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				this.goToPage(Number(this.pageInput.value));
				this.pageInput.blur();
			}
		});
		const zoom = t.group("zoom");
		t.add(zoom, { id: "zoom-out", icon: "zoom-out", label: "Zoom out", priority: 2, run: () => this.zoom(-1) });
		this.zoomLabel = zoom.createSpan({ cls: "pendf-zoom-label", text: "–" });
		t.add(zoom, { id: "zoom-in", icon: "zoom-in", label: "Zoom in", priority: 2, run: () => this.zoom(1) });
		t.add(zoom, { id: "fit-width", icon: "move-horizontal", label: "Fit width", priority: 3, run: () => this.setScale("page-width") });
		t.add(zoom, { id: "rotate", icon: "rotate-cw", label: "Rotate view", priority: 3, run: () => this.rotate(90) });
		t.spacer();
		// annotation tools
		const tools = t.group("annotate");
		t.add(tools, { id: "highlight", icon: "highlighter", label: "Highlight selection", priority: 2, run: () => this.session?.highlights.createFromSelection() });
		this.noteButton = t.add(tools, {
			id: "note",
			icon: "message-square-plus",
			label: "Add note (then tap the page)",
			priority: 1,
			run: () => {
				const n = this.session?.notes;
				if (n) n.setPlacing(!n.placing);
			},
		});
		this.inkButton = t.add(tools, { id: "ink", icon: "pen-line", label: "Handwriting tools (pen, highlighter, eraser)", priority: 1, run: () => this.toggleInk() });
		this.areaButton = t.add(tools, { id: "area", icon: "square-dashed", label: "Area excerpt (drag a rectangle)", priority: 2, run: () => this.toggleArea() });
		this.marginButton = t.add(tools, { id: "margin", icon: "panel-right-open", label: "Show margin", priority: 2, run: () => this.toggleMargin() });
		t.add(tools, { id: "bookmark", icon: "bookmark-plus", label: "Bookmark this spot", priority: 3, run: () => void this.addBookmark() });
		// history
		const history = t.group("history");
		t.add(history, { id: "undo", icon: "undo-2", label: "Undo", priority: 1, run: () => this.undo() });
		t.add(history, { id: "redo", icon: "redo-2", label: "Redo", priority: 2, run: () => this.redo() });
		// search, link, panel
		const misc = t.group("find");
		t.add(misc, { id: "search", icon: "search", label: "Find in PDF", priority: 2, run: () => this.openSearch() });
		t.add(misc, { id: "link", icon: "link", label: "Copy link to this page", priority: 3, run: () => this.copyPageLink() });
		t.add(misc, { id: "panel", icon: "list", label: "Outline, pages, bookmarks and annotations", priority: 1, run: () => this.togglePanel() });
		t.done();
	}

	/** Toolbar panel button: the panel in this view, or the sidebar panel (setting). */
	togglePanel(): void {
		if (this.plugin.settings.panelLocation === "sidebar") void this.plugin.showSidebarPanel();
		else this.panel?.toggle();
	}

	/** Open the in-view panel on a tab. */
	openPanel(tab?: PanelTab): void {
		this.panel?.setOpen(true, tab);
	}

	/** Labels of the toolbar buttons in the More menu (tests). */
	get toolbarOverflow(): string[] {
		return this.toolbar?.overflowed() ?? [];
	}

	private buildSearchBar(bar: HTMLElement): void {
		this.searchInput = bar.createEl("input", { cls: "pendf-search-input", attr: { type: "search", placeholder: "Find in PDF…", "aria-label": "Find in PDF" } });
		this.searchCount = bar.createSpan({ cls: "pendf-search-count" });
		this.button(bar, "arrow-up", "Previous match", () => this.find("again", true));
		this.button(bar, "arrow-down", "Next match", () => this.find("again", false));
		this.button(bar, "x", "Close", () => this.closeSearch());
		this.searchInput.addEventListener("input", () => this.find("", false));
		this.searchInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.find("again", e.shiftKey);
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.closeSearch();
			}
		});
	}

	applySettings(): void {
		if (!this.viewerRoot) return;
		this.viewerRoot.toggleClass("pendf-invert", this.plugin.settings.invertPages);
		if (this.plugin.settings.debugHud && !this.hud) {
			this.hud = new DebugHud(this.viewerRoot, () => this.hudData());
		} else if (!this.plugin.settings.debugHud && this.hud) {
			this.hud.destroy();
			this.hud = null;
		}
		// the zoom rendering preset is a PDFViewer construction option: reopen to apply it
		if (this.session && this.session.render.preset !== this.plugin.settings.zoomRendering && this.file) {
			void this.onLoadFile(this.file);
			return;
		}
		this.session?.layers.refresh();
		this.session?.ink.applyInputMode();
		if (this.session?.ink.active) this.renderInkBar();
	}

	// --------------------------------------------------- handwriting (Phase 6)

	toggleInk(on?: boolean): void {
		const ink = this.session?.ink;
		if (!ink) return;
		ink.setActive(on ?? !ink.active);
	}

	private setInk(patch: Partial<typeof this.plugin.settings.ink>): void {
		this.plugin.settings.ink = { ...this.plugin.settings.ink, ...patch };
		this.renderInkBar();
		void this.plugin.saveSettings();
	}

	private renderInkBar(): void {
		const bar = this.inkBar;
		const ink = this.plugin.settings.ink;
		bar.empty();
		const tools = bar.createDiv({ cls: "pendf-group" });
		const tool = (id: InkTool, icon: string, label: string) => {
			const b = this.button(tools, icon, label, () => this.setInk({ tool: id }));
			b.toggleClass("is-active", ink.tool === id);
		};
		tool("pen", "pen-line", "Pen");
		tool("highlighter", "highlighter", "Highlighter");
		tool("eraser", "eraser", "Stroke eraser");
		if (ink.tool !== "eraser") {
			const colors = bar.createDiv({ cls: "pendf-group pendf-ink-colors" });
			const list = ink.tool === "pen" ? PEN_COLORS : this.plugin.settings.colors.map((c) => c.hex);
			const current = ink.tool === "pen" ? ink.penColor : ink.highlighterColor;
			for (const hex of list) {
				const b = colors.createEl("button", { cls: "pendf-swatch pendf-ink-swatch", attr: { "aria-label": hex, title: hex } });
				b.setCssProps({ "--pendf-swatch": hex });
				b.toggleClass("is-active", hex.toLowerCase() === current.toLowerCase());
				b.addEventListener("click", () => this.setInk(ink.tool === "pen" ? { penColor: hex } : { highlighterColor: hex }));
			}
			const widths = bar.createDiv({ cls: "pendf-group pendf-ink-widths" });
			const wl = ink.tool === "pen" ? PEN_WIDTHS : [8, 12, 18];
			const cw = ink.tool === "pen" ? ink.penWidth : ink.highlighterWidth;
			wl.forEach((w, i) => {
				const b = widths.createEl("button", { cls: "pendf-icon-btn pendf-ink-width", attr: { "aria-label": `Width ${w} pt`, title: `${w} pt` } });
				b.createSpan({ cls: "pendf-ink-dot" }).setCssProps({ "--pendf-dot": `${4 + i * 4}px` });
				b.toggleClass("is-active", w === cw);
				b.addEventListener("click", () => this.setInk(ink.tool === "pen" ? { penWidth: w } : { highlighterWidth: w }));
			});
		}
		bar.createDiv({ cls: "pendf-spacer" });
		const done = bar.createEl("button", { cls: "pendf-ink-done", text: "Done" });
		done.addEventListener("click", () => this.toggleInk(false));
	}

	// ------------------------------------------------------------- file load

	async onLoadFile(file: TFile): Promise<void> {
		const token = ++this.loadToken;
		await this.teardown();
		if (!this.showEngineWarning()) this.setBanner(null);
		this.viewerEl.empty();
		const loading = this.viewerRoot.createDiv({ cls: "pendf-loading", text: "Loading…" });
		try {
			const data = await this.app.vault.readBinary(file);
			if (token !== this.loadToken) return;
			const opened = await this.openWithPassword(data, file);
			if (!opened) return;
			if (token !== this.loadToken) {
				await opened.close();
				return;
			}
			await this.startSession(file, opened, token);
		} catch (e) {
			log.error(`failed to open ${file.path}`, e);
			this.setBanner(`Could not open this PDF: ${e instanceof Error ? e.message : String(e)}`, "error");
		} finally {
			loading.remove();
		}
	}

	private async openWithPassword(data: ArrayBuffer, file: TFile): Promise<OpenedDocument | null> {
		let password: string | undefined;
		for (;;) {
			try {
				return await openDocument(data, password);
			} catch (e) {
				const name = (e as { name?: string })?.name;
				if (name !== "PasswordException") throw e;
				const pw = await askPassword(this.plugin, file.name, password !== undefined);
				if (pw === null) {
					this.setBanner("This PDF is password protected.", "warn");
					return null;
				}
				password = pw;
			}
		}
	}

	private async startSession(file: TFile, opened: OpenedDocument, token: number): Promise<void> {
		const ac = new AbortController();
		const eventBus = new EventBus();
		const linkService = new PDFLinkService({
			eventBus,
			externalLinkTarget: LinkTarget.BLANK,
			externalLinkRel: "noopener noreferrer nofollow",
		});
		const findController = new PDFFindController({ eventBus, linkService });
		const render: RenderConfig = { ...renderConfig(this.plugin.settings.zoomRendering, Platform.isMobile), ...(PenDFView.renderOverride ?? {}) };
		const viewer = new PDFViewer({
			container: this.container,
			viewer: this.viewerEl,
			eventBus,
			linkService,
			findController,
			textLayerMode: 1,
			annotationMode: AnnotationMode.ENABLE,
			annotationEditorMode: AnnotationEditorType.DISABLE,
			removePageBorders: false,
			// canvas size limits from the zoom rendering preset (D-38); undefined -> pdf.js's own
			...(render.maxCanvasPixels !== undefined ? { maxCanvasPixels: render.maxCanvasPixels } : {}),
			...(render.enableDetailCanvas !== undefined ? { enableDetailCanvas: render.enableDetailCanvas } : {}),
			abortSignal: ac.signal,
		} as ConstructorParameters<typeof PDFViewer>[0]);
		linkService.setViewer(viewer);

		const layers = new LayerManager(viewer, eventBus, this.container);
		const timeline = new ZoomTimeline({
			root: this.container,
			eventBus,
			signal: ac.signal,
			layerCounters: () => layers.counters,
			diagnostics: () => this.plugin.settings.debugHud,
		});
		const pageView = (n: number) => viewer.getPageView(n - 1) as unknown as PageViewLike | undefined;
		const zoom = new ZoomController({
			container: this.container,
			viewerEl: this.viewerEl,
			pagesCount: () => viewer.pagesCount,
			pageDiv: (n) => pageView(n)?.div ?? null,
			getScale: () => viewer.currentScale,
			setScale: (scale) => {
				viewer.currentScale = scale;
			},
			freezeLayers: (frozen) => layers.setFrozen(frozen),
			releaseOffscreen: render.releaseOffscreen ? (visible) => this.releaseCanvases(visible) : undefined,
			onBegin: () => {
				session.highlights.hidePalette();
				session.highlights.closeMenu();
			},
			timeline,
		});
		const memory = this.plugin.fileMemory(file.path);
		const margin = new MarginController(
			{
				root: this.viewerRoot,
				pagesCount: () => viewer.pagesCount,
				pageView: (n) => {
					const pv: unknown = viewer.getPageView(n - 1);
					return (pv as MarginPageView | undefined) ?? null;
				},
				viewRotation: () => viewer.pagesRotation,
				annotations: () => session.store?.all() ?? [],
			},
			normalizeMargin(memory?.margin, { on: false, side: this.plugin.settings.marginSide, ratio: this.plugin.settings.marginRatio }),
		);
		const session: Session = {
			file,
			opened,
			eventBus,
			linkService,
			findController,
			viewer,
			layers,
			highlights: null as unknown as HighlightController,
			notes: null as unknown as NoteController,
			ink: null as unknown as InkController,
			store: null,
			undo: null,
			ac,
			ready: false,
			outline: null,
			text: new Map(),
			zoom,
			timeline,
			render,
			margin,
			area: null as unknown as AreaController,
		};
		session.highlights = new HighlightController({
			root: this.viewerRoot,
			container: this.container,
			layers,
			store: () => session.store,
			undo: () => session.undo,
			colors: () => this.plugin.settings.colors,
			defaultColor: () => this.plugin.settings.defaultColor,
			notice: (m) => new Notice(m),
			copy: (t) => void navigator.clipboard.writeText(t),
			note: (a) => session.notes.noteOnHighlight(a),
			copyLink: (a, text) => this.copyLink({ page: a.page, id: a.id }, aliasFrom(text) || `p. ${a.page}`),
			copySelectionLink: (t) => this.copyLink({ page: t.page, rect: t.rect }, aliasFrom(t.text) || `p. ${t.page}`),
		});
		session.notes = new NoteController({
			app: this.app,
			root: this.viewerRoot,
			container: this.container,
			layers,
			store: () => session.store,
			undo: () => session.undo,
			sourcePath: () => session.file.path,
			notice: (m) => new Notice(m),
			onPlacingChange: (on) => {
				if (on) session.area?.setActive(false);
				this.noteButton?.toggleClass("is-active", on);
			},
			closeOthers: () => {
				session.highlights.hidePalette();
				session.highlights.closeMenu();
			},
			copyLink: (n) => this.copyLink({ page: n.page, id: n.id }, aliasFrom(n.body.split("\n").find((l) => l.trim()) ?? "") || `p. ${n.page}`),
		});
		session.ink = new InkController({
			root: this.viewerRoot,
			container: this.container,
			layers,
			store: () => session.store,
			undo: () => session.undo,
			settings: () => this.plugin.settings.ink,
			notice: (m) => new Notice(m),
			onActiveChange: (on) => {
				if (on) session.area?.setActive(false);
				this.inkButton?.toggleClass("is-active", on);
				this.inkBar.toggleClass("is-hidden", !on);
				if (on) this.renderInkBar();
			},
			busy: () => (session.notes?.placing ?? false) || (session.area?.active ?? false),
			quietly: (fn) => {
				this.quiet = true;
				try {
					fn();
				} finally {
					this.quiet = false;
				}
			},
		});
		session.area = new AreaController({
			root: this.viewerRoot,
			container: this.container,
			layers,
			store: () => session.store,
			undo: () => session.undo,
			colors: () => this.plugin.settings.colors,
			defaultColor: () => this.plugin.settings.defaultColor,
			notice: (m) => new Notice(m),
			pageText: (page) => this.pageText(session, page),
			note: (a) => session.notes.noteOnHighlight(a),
			copyLink: (a) => this.copyLink({ page: a.page, id: a.id }, aliasFrom(a.label || a.text) || `p. ${a.page}`),
			copyImage: (a) => this.copyAreaImage(a),
			saveImage: (a) => this.saveAreaImage(a),
			onActiveChange: (on) => {
				this.areaButton?.toggleClass("is-active", on);
				if (on) {
					session.ink.setActive(false);
					session.notes.setPlacing(false);
					session.highlights.hidePalette();
					session.highlights.closeMenu();
				}
			},
		});
		this.session = session;

		eventBus.on("pagesloaded", () => this.relayoutKeepingTop(), { signal: ac.signal });
		eventBus.on("rotationchanging", () => this.relayoutKeepingTop(), { signal: ac.signal });
		eventBus.on("pagesinit", () => {
			session.ready = true;
			margin.apply();
			if (session.store) window.setTimeout(() => this.session === session && this.autoOpenMargin(), 0);
			this.applyInitialState(file);
			this.tryNav();
		}, { signal: ac.signal });
		eventBus.on("pagechanging", (e: { pageNumber: number }) => {
			this.pageInput.value = String(e.pageNumber);
			this.scheduleStateSave();
			for (const fn of this.pageListeners) fn(e.pageNumber);
		}, { signal: ac.signal });
		eventBus.on("scalechanging", (e: { scale: number }) => {
			// a zoom commit corrects the scroll here, before pdf.js picks pages to render
			zoom.onScaleChanging();
			if (!this.applyingFit) this.fitMode = (e as { presetValue?: string }).presetValue === "page-width";
			this.zoomLabel.setText(`${Math.round(e.scale * 100)}%`);
			this.scheduleStateSave();
		}, { signal: ac.signal });
		eventBus.on("updatefindmatchescount", (e: { matchesCount: { current: number; total: number } }) => this.showMatches(e.matchesCount), { signal: ac.signal });
		eventBus.on("updatefindcontrolstate", (e: { state: number; matchesCount: { current: number; total: number } }) => {
			if (e.state === FindState.NOT_FOUND) this.searchCount.setText("No matches");
			else this.showMatches(e.matchesCount);
		}, { signal: ac.signal });

		eventBus.on("pagerendered", (e: { cssTransform?: boolean }) => {
			if (!e.cssTransform) zoom.onPageRendered();
		}, { signal: ac.signal });
		if (render.budgetMB !== null) {
			const budget = render.budgetMB * 1048576;
			eventBus.on("pagerendered", (e: { cssTransform?: boolean }) => {
				if (!e.cssTransform) this.enforceCanvasBudget(budget);
			}, { signal: ac.signal });
		}
		this.installInput(session);

		viewer.setDocument(opened.doc);
		linkService.setDocument(opened.doc, null);
		this.pageCountEl.setText(`/ ${opened.doc.numPages}`);
		this.hud?.attach(eventBus, ac.signal);
		log.info(`opened ${file.path} (${opened.doc.numPages} pages, worker: ${workerMode()})`);

		// annotations
		const store = new SidecarStore(adapterFs(this.app.vault.adapter), file.path, opened.fingerprint, {
			onChange: (source) => {
				// local edits re-render only what they touch (each controller refreshes its page)
				if (source === "external") {
					log.info(`merged external changes into ${store.path}`);
					layers.refresh();
				}
				if (store.status !== "ok") this.showStoreStatus(store);
				this.scheduleMarginRefresh();
				if (!this.quiet) this.notifyChange();
			},
			onProblem: (m) => log.warn(`${store.path}: ${m}`),
			canSave: () => !session.ink?.isDrawing,
		});
		await store.load();
		if (token !== this.loadToken || this.session !== session) {
			await store.dispose();
			return;
		}
		session.store = store;
		session.undo = new UndoStack(store);
		this.plugin.trackStore(store);
		this.showStoreStatus(store);
		layers.refresh();
		if (session.ready) this.autoOpenMargin();
		this.notifyChange();
		this.tryNav();
	}

	// ------------------------------------------------------- links (Phase 4)

	/** A link to this PDF (Obsidian's link format settings apply). */
	linkTo(target: PdfTarget, alias?: string): string | null {
		const file = this.session?.file ?? this.file;
		if (!file) return null;
		return this.app.fileManager.generateMarkdownLink(file, "", buildSubpath(target), alias);
	}

	copyLink(target: PdfTarget, alias?: string): void {
		const link = this.linkTo(target, alias);
		if (!link) return;
		void navigator.clipboard.writeText(link).then(
			() => new Notice("Link copied"),
			() => new Notice("penDF: could not copy the link"),
		);
	}

	copyPageLink(): void {
		const s = this.session;
		if (!s?.ready) return;
		const page = s.viewer.currentPageNumber;
		this.copyLink({ page }, `${s.file.basename}, p. ${page}`);
	}

	/** Go to a pending link target once the document and its annotations are there. */
	private tryNav(): void {
		const s = this.session;
		const nav = this.pendingNav;
		if (!nav || !s?.ready || !s.store) return;
		this.pendingNav = null;
		if (nav.id) {
			const a = s.store.get(nav.id);
			if (a && !a.deleted) {
				this.revealAnnotation(a);
				return;
			}
			log.info(`link target ${nav.id} not found; showing page ${nav.page ?? "?"}`);
		}
		if (nav.rect && nav.page) {
			this.revealRect(nav.page, nav.rect);
			return;
		}
		if (nav.page) this.goToPage(nav.page);
	}

	// --------------------------------------------------- outline & bookmarks

	/** The PDF's own outline with page numbers (empty if it has none). */
	outline(): Promise<OutlineNode[]> {
		const s = this.session;
		if (!s) return Promise.resolve([]);
		s.outline ??= this.loadOutline(s);
		return s.outline;
	}

	private async loadOutline(s: Session): Promise<OutlineNode[]> {
		const doc = s.opened.doc;
		let raw: Awaited<ReturnType<typeof doc.getOutline>> | null = null;
		try {
			raw = await doc.getOutline();
		} catch (e) {
			log.warn("could not read the outline", e);
		}
		if (!raw) return [];
		const pageOf = async (dest: unknown): Promise<number | null> => {
			try {
				const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
				if (!Array.isArray(explicit) || explicit.length === 0) return null;
				const ref: unknown = explicit[0];
				if (typeof ref === "number") return ref + 1;
				if (ref && typeof ref === "object") return (await doc.getPageIndex(ref as Parameters<typeof doc.getPageIndex>[0])) + 1;
			} catch {
				// unresolvable destination: listed without a page
			}
			return null;
		};
		type Raw = { title: string; dest: string | unknown[] | null; url: string | null; items: Raw[] };
		const walk = async (items: Raw[], depth: number): Promise<OutlineNode[]> =>
			Promise.all(
				items.map(async (it) => ({
					title: it.title,
					dest: it.dest ?? null,
					url: it.url ?? null,
					page: it.dest ? await pageOf(it.dest) : null,
					depth,
					items: await walk(it.items ?? [], depth + 1),
				})),
			);
		return walk(raw, 0);
	}

	goToOutline(node: OutlineNode): void {
		const s = this.session;
		if (!s?.ready) return;
		if (node.dest) void s.linkService.goToDestination(node.dest);
		else if (node.url) window.open(node.url, "_blank", "noopener");
	}

	bookmarks(): BookmarkAnnotation[] {
		return sortedBookmarks(this.annotations());
	}

	/** PDF position at the top of the view: page and y (a little below the top edge). */
	topPosition(): { page: number; y: number } | null {
		const s = this.session;
		if (!s?.ready) return null;
		const cr = this.container.getBoundingClientRect();
		const x = cr.left + cr.width / 2;
		for (const dy of [16, 48, 96]) {
			const pageDiv = this.container.ownerDocument
				.elementsFromPoint(x, cr.top + dy)
				.map((el) => el.closest<HTMLElement>(".page[data-page-number]"))
				.find((el) => !!el && this.container.contains(el));
			if (!pageDiv) continue;
			const page = Number(pageDiv.dataset.pageNumber);
			const geom = s.layers.geometry(page);
			if (!geom) continue;
			const pr = pageContentRect(pageDiv);
			const v = geom.clientToView(x, Math.max(cr.top + dy, pr.top), pr);
			const [, y] = geom.toPdf(v[0], v[1]);
			return { page, y: Math.round(y * 10) / 10 };
		}
		const page = s.viewer.currentPageNumber;
		const geom = s.layers.geometry(page);
		return { page, y: geom ? geom.viewBox[3] : 0 };
	}

	/** Bookmark the top of the view; asks for a title unless one is given. */
	async addBookmark(title?: string): Promise<string | null> {
		const s = this.session;
		const store = s?.store;
		if (!s || !store || !s.undo) return null;
		if (!store.writable) {
			new Notice("penDF: annotations for this PDF are read-only (see the banner).");
			return null;
		}
		const pos = this.topPosition();
		if (!pos) return null;
		const outline = await this.outline();
		const flat: OutlineEntry[] = [];
		const flatten = (nodes: OutlineNode[]) => nodes.forEach((n) => (flat.push({ title: n.title, page: n.page, depth: n.depth }), flatten(n.items)));
		flatten(outline);
		const suggested = defaultBookmarkTitle(pos.page, sectionFor(flat, pos.page));
		const name = title ?? (await promptText(this.app, "Bookmark this spot", suggested, "Add"));
		if (name === null || this.session !== s || !s.undo) return null;
		const now = Date.now();
		const b: BookmarkAnnotation = { id: uuid(), type: "bookmark", page: pos.page, createdAt: now, updatedAt: now, deleted: false, y: pos.y, title: name, order: orderAtEnd(this.bookmarks()) };
		s.undo.record("bookmark", [b.id], () => store.upsert(b));
		log.info(`bookmark on page ${b.page}`);
		return b.id;
	}

	async renameBookmark(b: BookmarkAnnotation, title?: string): Promise<void> {
		const name = title ?? (await promptText(this.app, "Rename bookmark", b.title));
		const s = this.session;
		const cur = s?.store?.get(b.id);
		if (name === null || !s?.undo || !s.store?.writable || !cur || cur.type !== "bookmark" || cur.title === name) return;
		const store = s.store;
		s.undo.record("rename bookmark", [b.id], () => store.upsert({ ...cur, title: name }));
	}

	/** Move a bookmark to position `to` in the list (0-based). */
	moveBookmark(id: string, to: number): void {
		const s = this.session;
		const store = s?.store;
		if (!s?.undo || !store?.writable) return;
		const changes = reorder(this.bookmarks(), id, to);
		if (changes.size === 0) return;
		s.undo.record("move bookmark", [...changes.keys()], () => {
			for (const [bid, order] of changes) {
				const cur = store.get(bid);
				if (cur && cur.type === "bookmark") store.upsert({ ...cur, order });
			}
		});
	}

	deleteBookmark(b: BookmarkAnnotation): void {
		const s = this.session;
		const store = s?.store;
		if (!s?.undo || !store?.writable) return;
		s.undo.record("delete bookmark", [b.id], () => store.remove(b.id));
	}

	// ------------------------------------------------- pages & search (panel)

	get pageCount(): number {
		return this.session?.ready ? this.session.viewer.pagesCount : 0;
	}

	get currentPage(): number {
		return this.session?.ready ? this.session.viewer.currentPageNumber : 0;
	}

	/** Subscribe to page changes. Returns the unsubscribe function. */
	onPageChange(fn: (page: number) => void): () => void {
		this.pageListeners.add(fn);
		return () => this.pageListeners.delete(fn);
	}

	/** height / width of a page as displayed (rotation included). */
	pageAspect(page: number): number {
		const pv = this.session?.viewer.getPageView(page - 1) as unknown as { viewport?: { width: number; height: number } } | undefined;
		const vp = pv?.viewport;
		return vp && vp.width > 0 ? vp.height / vp.width : 1.414;
	}

	/** Live annotation counts by page (thumbnails badge). */
	annotationCountsByPage(): Map<number, number> {
		const m = new Map<number, number>();
		for (const a of this.annotations()) if (a.type !== "bookmark") m.set(a.page, (m.get(a.page) ?? 0) + 1);
		return m;
	}

	/** Render a page thumbnail `cssWidth` pixels wide into `canvas`. cancel() stops it. */
	renderThumbnail(page: number, canvas: HTMLCanvasElement, cssWidth: number): { done: Promise<boolean>; cancel: () => void } {
		const s = this.session;
		let task: { promise: Promise<void>; cancel: () => void } | null = null;
		let cancelled = false;
		const done = (async () => {
			if (!s?.ready) return false;
			const pdfPage = await s.opened.doc.getPage(page);
			if (cancelled || this.session !== s) return false;
			const rotation = (pdfPage.rotate + s.viewer.pagesRotation) % 360;
			const base = pdfPage.getViewport({ scale: 1, rotation });
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			const viewport = pdfPage.getViewport({ scale: (cssWidth * dpr) / base.width, rotation });
			canvas.width = Math.max(1, Math.floor(viewport.width));
			canvas.height = Math.max(1, Math.floor(viewport.height));
			this.thumbs.add(canvas);
			task = pdfPage.render({ canvas, viewport, annotationMode: AnnotationMode.DISABLE });
			try {
				await task.promise;
				return !cancelled;
			} catch {
				return false;
			}
		})();
		return {
			done,
			cancel: () => {
				cancelled = true;
				task?.cancel();
			},
		};
	}

	/** Free a thumbnail canvas (scrolled away, panel closed). */
	releaseThumbnail(canvas: HTMLCanvasElement): void {
		this.thumbs.delete(canvas);
		canvas.width = 0;
		canvas.height = 0;
		canvas.remove();
	}

	/** Memory of the live thumbnail canvases (w×h×4), bytes. */
	thumbnailBytes(): number {
		let b = 0;
		for (const c of [...this.thumbs]) {
			if (!c.isConnected || !c.width) {
				this.thumbs.delete(c);
				continue;
			}
			b += c.width * c.height * 4;
		}
		return b;
	}

	/** Outline entries the user left expanded in this file (null: never changed). */
	outlineOpenKeys(): Set<string> | null {
		const m = this.file ? this.plugin.fileMemory(this.file.path) : undefined;
		return m?.outline ? new Set(m.outline) : null;
	}

	setOutlineOpenKeys(keys: string[]): void {
		if (this.file) this.plugin.patchFileMemory(this.file.path, { outline: keys });
	}

	private pageText(s: Session, page: number): Promise<PageText> {
		let p = s.text.get(page);
		if (!p) {
			p = (async () => {
				const pdfPage = await s.opened.doc.getPage(page);
				const tc = await pdfPage.getTextContent();
				const items: PageText["items"] = [];
				let joined = "";
				for (const it of tc.items) {
					if (!("str" in it)) continue;
					const str = normalizeForSearch(it.str);
					if (!str.trim()) continue;
					if (joined && !joined.endsWith(" ")) joined += " ";
					const t = it.transform as number[];
					const n = Math.hypot(t[0], t[1]) || 1;
					items.push({ x: t[4], y: t[5], w: it.width, h: it.height || Math.hypot(t[2], t[3]), ux: t[0] / n, uy: t[1] / n, start: joined.length, len: str.length, raw: it.str.normalize("NFKC").replace(/\s+/g, " ").trim() });
					joined += str;
				}
				return { items, joined };
			})();
			s.text.set(page, p);
		}
		return p;
	}

	/**
	 * Find `query` in every page, page by page (yielding to the UI). Calls
	 * `onHits` per page with matches, `onProgress` after each page.
	 */
	async searchAll(
		query: string,
		opts: { signal: AbortSignal; limit?: number; onHits: (hits: SearchHit[]) => void; onProgress?: (page: number, total: number) => void },
	): Promise<number> {
		const s = this.session;
		const q = normalizeForSearch(query).trim();
		if (!s?.ready || !q) return 0;
		const total = s.viewer.pagesCount;
		const limit = opts.limit ?? 500;
		let count = 0;
		for (let page = 1; page <= total && count < limit; page++) {
			if (opts.signal.aborted || this.session !== s) return count;
			const pt = await this.pageText(s, page);
			const hits: SearchHit[] = [];
			for (let i = pt.joined.indexOf(q); i >= 0 && count < limit; i = pt.joined.indexOf(q, i + q.length)) {
				const item = pt.items.find((it) => i >= it.start && i < it.start + it.len) ?? null;
				let rect: SearchHit["rect"] = null;
				if (item) {
					const f0 = (i - item.start) / item.len;
					const f1 = Math.min(1, (i - item.start + q.length) / item.len);
					rect = [item.x + item.w * f0, item.y - item.h * 0.25, item.x + item.w * f1, item.y + item.h * 0.95];
				}
				hits.push({ page, before: pt.joined.slice(Math.max(0, i - 40), i), match: pt.joined.slice(i, i + q.length), after: pt.joined.slice(i + q.length, i + q.length + 60), rect });
				count++;
			}
			if (hits.length) opts.onHits(hits);
			opts.onProgress?.(page, total);
			if (page % 8 === 0) await new Promise((r) => window.setTimeout(r, 0));
		}
		return count;
	}

	/** Go to a search hit and flash it. */
	revealHit(hit: SearchHit): void {
		if (hit.rect) this.revealRect(hit.page, hit.rect);
		else this.goToPage(hit.page);
	}

	/** Scroll a PDF-space box into view and flash it. */
	revealRect(page: number, rect: [number, number, number, number]): void {
		const s = this.session;
		if (!s?.ready) return;
		const [x0, y0, x1, y1] = rect;
		s.viewer.scrollPageIntoView({ pageNumber: page, destArray: [null, { name: "XYZ" }, x0 - 24, y1 + 48, null], allowNegativeOffset: true, ignoreDestinationZoom: true });
		let tries = 0;
		const draw = () => {
			if (this.session !== s) return;
			const layer = s.layers.getLayer(page);
			if (!layer) {
				if (++tries < 20) window.setTimeout(draw, 100);
				return;
			}
			const pts = [layer.geom.toView(x0, y1), layer.geom.toView(x1, y1), layer.geom.toView(x1, y0), layer.geom.toView(x0, y0)];
			const poly = svgEl("polygon", { class: "pendf-flash", points: pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" ") });
			layer.overlay.appendChild(poly);
			window.setTimeout(() => poly.remove(), 2200);
		};
		window.setTimeout(draw, 150);
	}

	// ------------------------------------------------- annotations (panel API)

	/** Subscribe to annotation changes and document switches. Returns the unsubscribe function. */
	onAnnotationsChange(fn: () => void): () => void {
		this.changeListeners.add(fn);
		return () => this.changeListeners.delete(fn);
	}

	private notifyChange(): void {
		this.panel?.refresh();
		this.scheduleMarginRefresh();
		for (const fn of this.changeListeners) {
			try {
				fn();
			} catch (e) {
				log.error("annotation listener failed", e);
			}
		}
	}

	/** The open document's live annotations (empty while loading or read-only). */
	annotations(): Annotation[] {
		const store = this.session?.store;
		return store && store.writable ? store.all() : [];
	}

	/** Scroll an annotation into view; a note also opens its popover. */
	revealAnnotation(a: Annotation): void {
		const s = this.session;
		const store = s?.store;
		if (!s?.ready || !store) return;
		let at: [number, number] | null = null;
		if (a.type === "highlight") {
			const xs = a.quads.flatMap((q) => [q[0], q[2], q[4], q[6]]);
			const ys = a.quads.flatMap((q) => [q[1], q[3], q[5], q[7]]);
			at = [Math.min(...xs), Math.max(...ys)];
		} else if (a.type === "note") {
			at = noteAnchor(a, (id) => store.get(id));
		} else if (a.type === "bookmark") {
			at = [0, a.y];
		} else if (a.type === "area") {
			this.revealRect(a.page, quadBox(a.quad));
			return;
		}
		const dest = at ? [null, { name: "XYZ" }, at[0] - 24, at[1] + 48, null] : undefined;
		s.viewer.scrollPageIntoView({ pageNumber: a.page, destArray: dest, allowNegativeOffset: true, ignoreDestinationZoom: true });
		if (a.type === "highlight") s.highlights.flash(a.id);
		if (a.type === "note") {
			// once the page layer is (re)attached, open the popover over the marker
			window.setTimeout(() => {
				const layer = s.layers.getLayer(a.page);
				const marker = layer?.overlay.querySelector(`.pendf-note[data-id="${a.id}"]`);
				const r = marker?.getBoundingClientRect();
				if (r && this.session === s) s.notes.openPopover(a, r.left + r.width / 2, r.top + r.height / 2);
			}, 350);
		}
	}

	private showEngineWarning(): boolean {
		const e = this.plugin.engine;
		if (e.ok) return false;
		this.setBanner(`This device’s JavaScript engine lacks: ${e.missing.join(", ")}. PDFs may fail to render; updating iPadOS / the Obsidian app should fix it.`, "error");
		return true;
	}

	private showStoreStatus(store: SidecarStore): void {
		switch (store.status) {
			case "ok":
				if (!this.showEngineWarning()) this.setBanner(null);
				break;
			case "fingerprint-mismatch":
				this.setBanner(`Annotations hidden: ${store.path} belongs to a different PDF. Nothing will be written to it.`, "warn");
				log.warn(store.statusDetail);
				break;
			case "newer-schema":
				this.setBanner(`Annotations read-only: ${store.statusDetail}`, "warn");
				break;
			case "unreadable":
				this.setBanner(`Annotations read-only: ${store.path} could not be read (${store.statusDetail}). It was not changed.`, "error");
				break;
		}
	}

	private setBanner(text: string | null, kind: "warn" | "error" = "warn"): void {
		if (!this.bannerEl) return;
		this.bannerEl.empty();
		this.bannerEl.toggleClass("is-hidden", !text);
		this.bannerEl.toggleClass("is-error", kind === "error");
		if (text) this.bannerEl.setText(text);
	}

	private installInput(session: Session): void {
		const { ac } = session;
		const signal = ac.signal;
		// external links → system browser; internal links are pdf.js's
		this.container.addEventListener(
			"click",
			(e) => {
				const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
				if (!a) return;
				const href = a.getAttribute("href") ?? "";
				if (/^(https?|mailto|tel):/i.test(href)) {
					e.preventDefault();
					e.stopPropagation();
					window.open(href, "_blank", "noopener");
				}
			},
			{ capture: true, signal },
		);
		// desktop: ctrl/⌘ + wheel zoom — a trackpad pinch composites like touch, a mouse notch is one step
		this.container.addEventListener("wheel", (e) => void session.zoom.wheel(e), { passive: false, signal });
		// touch: pinch zoom. pdf.js's TouchManager (bundled copy) recognises the gesture; penDF only
		// composites a transform while the fingers move and commits once when they lift (D-38).
		const zoom = session.zoom;
		let center: [number, number] | null = null;
		const track = (e: TouchEvent) => {
			if (e.touches.length < 2) return;
			const a = e.touches[0];
			const b = e.touches[1];
			center = [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2];
		};
		this.container.addEventListener("touchstart", track, { capture: true, passive: true, signal });
		this.container.addEventListener("touchmove", track, { capture: true, passive: true, signal });
		let factor = 1;
		new TouchManager({
			container: this.container,
			// a palm resting while the Pencil writes is a second touch: no zooming mid-stroke
			isPinchingDisabled: () => session.ink.isDrawing || session.area.isDrawing,
			onPinchStart: () => {
				factor = 1;
			},
			onPinching: (origin: [number, number], prevDistance: number, distance: number) => {
				if (prevDistance <= 0) return;
				if (session.ink.isDrawing) {
					zoom.cancel();
					return;
				}
				if (!zoom.active) zoom.begin("pinch", origin[0], origin[1]);
				factor *= distance / prevDistance;
				const c = center ?? origin;
				zoom.update(factor, c[0], c[1]);
			},
			onPanning: (dx: number, dy: number) => {
				// two fingers moving without pinching: the preview follows them (committed as a scroll)
				if (!center || session.ink.isDrawing) return;
				if (!zoom.active) zoom.begin("pinch", center[0] - dx, center[1] - dy);
				zoom.update(factor, center[0], center[1]);
			},
			onPinchEnd: () => {
				if (zoom.active) zoom.end();
				factor = 1;
				center = null;
			},
			signal,
		});
	}

	/** Free the canvases of pages outside `visible` (zoom commit, before pdf.js renders at the new scale). */
	private releaseCanvases(visible: Set<number>): number {
		const s = this.session;
		if (!s) return 0;
		let n = 0;
		for (const div of Array.from(this.viewerEl.querySelectorAll<HTMLElement>(".page[data-page-number]"))) {
			const id = Number(div.dataset.pageNumber);
			if (visible.has(id) || !div.querySelector("canvas")) continue;
			const pv = s.viewer.getPageView(id - 1) as unknown as PageViewLike | undefined;
			if (pv && releasePage(pv)) n++;
		}
		return n;
	}

	/** Keep rendered pages' canvases under the preset's budget: free the pages farthest from the view. */
	private enforceCanvasBudget(budgetBytes: number): void {
		const s = this.session;
		if (!s || s.zoom.active) return;
		const pages: { id: number; bytes: number }[] = [];
		const seen = new Set<number>();
		for (const cv of Array.from(this.viewerEl.querySelectorAll("canvas"))) {
			const div = cv.closest<HTMLElement>(".page[data-page-number]");
			if (!div) continue;
			const id = Number(div.dataset.pageNumber);
			if (seen.has(id)) continue;
			seen.add(id);
			pages.push({ id, bytes: canvasBytes(div) });
		}
		// thumbnails in the panels share the budget with the pages
		const over = pagesOverBudget(pages, s.zoom.visiblePages(this.container.getBoundingClientRect()), Math.max(0, budgetBytes - this.thumbnailBytes()));
		let freed = 0;
		for (const id of over) {
			const pv = s.viewer.getPageView(id - 1) as unknown as PageViewLike | undefined;
			if (pv && releasePage(pv)) freed++;
		}
		if (freed) log.debug(`canvas budget: freed ${freed} page(s)`);
	}

	/** The last zoom gesture's timeline (debug overlay, export command, harness). */
	lastZoomTimeline(): (GestureRecord & { preset: string; maxCanvasPixels: number | null; dpr: number; mobile: boolean }) | null {
		const s = this.session;
		const r = s?.timeline.lastRecord();
		if (!s || !r) return null;
		return { ...r, preset: s.render.preset, maxCanvasPixels: (s.viewer as unknown as { maxCanvasPixels?: number }).maxCanvasPixels ?? null, dpr: window.devicePixelRatio, mobile: Platform.isMobile };
	}

	// ------------------------------------------------------------ navigation

	private applyInitialState(file: TFile): void {
		const s = this.session;
		if (!s) return;
		const remembered = this.plugin.settings.rememberPosition ? this.plugin.settings.positions[file.path] : undefined;
		const state: ViewerState = this.pendingState ?? (remembered ? { page: remembered.page, scale: remembered.scale } : {});
		this.pendingState = null;
		const scale = state.scale && isScaleValue(state.scale) ? state.scale : "page-width";
		if (scale === "page-width") this.fitWidth();
		else s.viewer.currentScaleValue = scale;
		if (state.page && state.page >= 1 && state.page <= s.viewer.pagesCount) s.viewer.currentPageNumber = state.page;
		this.pageInput.value = String(s.viewer.currentPageNumber);
		s.layers.schedule();
	}

	goToPage(n: number): void {
		const s = this.session;
		if (!s || !Number.isFinite(n)) return;
		const page = Math.min(Math.max(1, Math.round(n)), s.viewer.pagesCount);
		s.viewer.currentPageNumber = page;
		this.pageInput.value = String(page);
	}

	zoom(steps: number): void {
		this.session?.viewer.updateScale({ steps, drawingDelay: 0 });
	}

	setScale(value: string): void {
		if (!this.session) return;
		if (value === "page-width") this.fitWidth();
		else this.session.viewer.currentScaleValue = value;
	}

	/**
	 * Extra page-box width beyond the page, as a share of the page width (margin, 0.8.0).
	 * 0 when the margin sits above or below the page on screen (view rotated a quarter turn).
	 */
	private extraWidthRatio(): number {
		const s = this.session;
		const m = s?.margin.cfg;
		if (!s || !m?.on) return 0;
		const side = screenSide(m.side, s.viewer.pagesRotation);
		return side === "left" || side === "right" ? m.ratio : 0;
	}

	/** Margin state of the open PDF (tests, panel). */
	get marginConfig(): MarginConfig | null {
		return this.session ? { ...this.session.margin.cfg } : null;
	}

	/** The "Area excerpt" tool on / off. */
	toggleArea(on?: boolean): void {
		const a = this.session?.area;
		if (a) a.setActive(on ?? !a.active);
	}

	/** Most pixels an area image may use now: the canvas budget left over, iOS's canvas limit, the preset's page limit. */
	private areaPixelCap(): number {
		const s = this.session;
		const iosLimit = 16_777_216;
		let cap = Math.min(iosLimit, s?.render.maxCanvasPixels ?? 2 ** 24);
		if (s?.render.budgetMB) {
			const used = s.timeline.canvasMemory().mb * 1048576 + this.thumbnailBytes();
			cap = Math.min(cap, Math.max(1_000_000, (s.render.budgetMB * 1048576 - used) / 4));
		}
		return Math.floor(cap);
	}

	/** Render an area from the PDF (scale × 100 % zoom; default from settings). */
	async renderAreaImage(a: AreaAnnotation, scale = this.plugin.settings.areaImageScale): Promise<HTMLCanvasElement | null> {
		const s = this.session;
		if (!s) return null;
		const page = await s.opened.doc.getPage(a.page);
		const r = await renderArea(page, a.quad, { scale, maxPixels: this.areaPixelCap(), doc: this.containerEl.doc }).done;
		return r?.canvas ?? null;
	}

	private async areaPng(a: AreaAnnotation): Promise<Blob | null> {
		const canvas = await this.renderAreaImage(a);
		if (!canvas) return null;
		const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
		canvas.width = canvas.height = 0;
		return blob;
	}

	/** Copy an area's image to the clipboard. false: the platform does not allow it (iPad: use Save image). */
	async copyAreaImage(a: AreaAnnotation): Promise<boolean> {
		try {
			const blob = await this.areaPng(a);
			if (!blob || typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false;
			await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
			new Notice("penDF: image copied");
			return true;
		} catch (e) {
			log.warn("copy image failed", e);
			return false;
		}
	}

	/** Save an area's image as an attachment (Obsidian's attachment location for this PDF). Returns the path. */
	async saveAreaImage(a: AreaAnnotation): Promise<string | null> {
		const s = this.session;
		if (!s) return null;
		const blob = await this.areaPng(a);
		if (!blob) {
			new Notice("penDF: could not render the image");
			return null;
		}
		const name = `${s.file.basename} p${a.page} excerpt.png`;
		const path = await this.app.fileManager.getAvailablePathForAttachment(name, s.file.path);
		await this.app.vault.createBinary(path, await blob.arrayBuffer());
		new Notice(`penDF: image saved to ${path}`);
		log.info(`area image saved: ${path}`);
		return path;
	}

	/** Small image of an area for the panel (`cssWidth` px wide), counted as a thumbnail. */
	renderAreaThumbnail(a: AreaAnnotation, canvas: HTMLCanvasElement, cssWidth: number): { done: Promise<boolean>; cancel: () => void } {
		const s = this.session;
		let job: { cancel(): void } | null = null;
		let cancelled = false;
		const done = (async () => {
			if (!s?.ready) return false;
			const page = await s.opened.doc.getPage(a.page);
			if (cancelled) return false;
			const [x0, , x1] = quadBox(a.quad);
			const widthPt = Math.max(1, x1 - x0);
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			const scale = (cssWidth * dpr) / ((widthPt * 96) / 72);
			const r = renderArea(page, a.quad, { scale: Math.min(4, scale), maxPixels: 400_000, canvas, doc: this.containerEl.doc });
			job = r;
			this.thumbs.add(canvas);
			const out = await r.done;
			return !!out && !cancelled;
		})();
		return {
			done,
			cancel: () => {
				cancelled = true;
				job?.cancel();
			},
		};
	}

	/** Show or hide the margin beside the pages ("Toggle margin"). */
	toggleMargin(on?: boolean): void {
		const s = this.session;
		if (!s) return;
		this.setMargin({ on: on ?? !s.margin.cfg.on });
	}

	/** Change the margin (on, side, width), remember it for this file and keep the reading position. */
	setMargin(patch: Partial<MarginConfig>): void {
		const s = this.session;
		if (!s) return;
		s.margin.cfg = normalizeMargin({ ...s.margin.cfg, ...patch }, s.margin.cfg);
		this.plugin.patchFileMemory(s.file.path, { margin: { ...s.margin.cfg } });
		this.toolbar?.relabel("margin", s.margin.cfg.on ? "Hide margin" : "Show margin");
		this.marginButton?.toggleClass("is-active", s.margin.cfg.on);
		this.relayoutKeepingTop();
	}

	/** Margin content changed (any edit, ink included): refresh the hidden-content marks. The margin never closes by itself. */
	private scheduleMarginRefresh(): void {
		if (!this.session || this.marginTimer !== null) return;
		this.marginTimer = window.setTimeout(() => {
			this.marginTimer = null;
			const s = this.session;
			if (!s) return;
			s.margin.recompute();
			s.margin.apply();
		}, 200);
	}

	/** Re-apply the margin (page box widths) and refit in fit-width mode, keeping the content at the top edge. */
	private relayoutKeepingTop(): void {
		const s = this.session;
		if (!s?.ready) {
			s?.margin.apply();
			return;
		}
		const anchor = this.captureTop();
		// the page pdf.js calls current, taken before the layout shifts under it
		const fitPage = s.viewer.currentPageNumber;
		s.margin.recompute();
		s.margin.apply();
		if (this.fitMode) this.fitWidth(fitPage);
		if (anchor) this.restoreTop(anchor);
		this.lastTop = this.captureTop();
	}

	/** After the annotations load: a PDF with margin content opens its margin, wide enough for it. */
	private autoOpenMargin(): void {
		const s = this.session;
		if (!s) return;
		s.margin.recompute();
		const next = autoMargin(s.margin.documentExtent(), s.margin.cfg);
		if (next.on !== s.margin.cfg.on || next.side !== s.margin.cfg.side || next.ratio !== s.margin.cfg.ratio) {
			log.info(`margin content found: showing the ${next.side} margin at ${Math.round(next.ratio * 100)} %`);
			s.margin.cfg = next;
			this.marginButton?.toggleClass("is-active", next.on);
			this.toolbar?.relabel("margin", next.on ? "Hide margin" : "Show margin");
			this.relayoutKeepingTop();
		} else s.margin.apply();
	}

	/**
	 * Fit the width of `page` (default: pdf.js's current page) and its margin, when shown, to the
	 * view width — one scale change. pdf.js's own "page-width" formula (view width minus its
	 * 40 px padding, over the page width), divided by 1 + the margin share. Re-layouts pass the
	 * current page as it was before the layout shifted (pdf.js updates it only after a scroll).
	 */
	fitWidth(page?: number): void {
		const s = this.session;
		if (!s) return;
		this.applyingFit = true;
		try {
			const n = page ?? s.viewer.currentPageNumber;
			const pv = s.viewer.getPageView(Math.max(0, n - 1)) as unknown as { viewport?: { width: number } } | undefined;
			const w = pv?.viewport?.width;
			if (w && w > 0) {
				const perUnit = w / s.viewer.currentScale;
				s.viewer.currentScale = Math.max(0.1, (this.container.clientWidth - 40) / perUnit / (1 + this.extraWidthRatio()));
			} else s.viewer.currentScaleValue = "page-width";
		} finally {
			this.applyingFit = false;
		}
		this.fitMode = true;
	}

	/** Scale as remembered: "page-width" while the scale follows the view width. */
	scaleValueForState(): string {
		const v = this.session?.viewer;
		if (!v) return "page-width";
		return this.fitMode ? "page-width" : v.currentScaleValue;
	}

	/** pdf.js page div of page n (1-based). */
	pageDivOf(n: number): HTMLElement | null {
		const pv = this.session?.viewer.getPageView(n - 1) as unknown as PageViewLike | undefined;
		return pv?.div ?? null;
	}

	/** Content at the top edge of the view. */
	private captureTop(): TopAnchor | null {
		const s = this.session;
		if (!s?.ready) return null;
		const cr = this.container.getBoundingClientRect();
		const vis = [...s.zoom.visiblePages(cr)];
		if (!vis.length) return null;
		const page = Math.min(...vis);
		const r = this.pageDivOf(page)?.getBoundingClientRect();
		return r ? topAnchor(page, r.top, r.height, cr.top) : null;
	}

	private restoreTop(a: TopAnchor): void {
		const r = this.pageDivOf(a.page)?.getBoundingClientRect();
		if (!r) return;
		this.container.scrollTop += scrollToTopAnchor(a, r.top, r.height, this.container.getBoundingClientRect().top);
	}

	/**
	 * When the view width changes (panel opened, closed or resized, window, Split View):
	 * refit in fit-width mode and keep the content at the top edge where it was.
	 */
	private installResizeKeeping(): void {
		this.container.addEventListener(
			"scroll",
			() => {
				if (this.topRaf !== null) return;
				this.topRaf = window.requestAnimationFrame(() => {
					this.topRaf = null;
					this.lastTop = this.captureTop();
				});
			},
			{ passive: true },
		);
		// a drag (window, Split View, panel edge) changes the width every frame: refit once it settles
		this.containerRo = new ResizeObserver(() => {
			const w = this.container.clientWidth;
			if (w === this.lastContainerWidth) return;
			if (this.lastContainerWidth === 0) {
				this.lastContainerWidth = w;
				return;
			}
			this.lastContainerWidth = w;
			if (this.widthTimer !== null) window.clearTimeout(this.widthTimer);
			this.widthTimer = window.setTimeout(() => {
				this.widthTimer = null;
				this.onWidthChange();
			}, 120);
		});
		this.containerRo.observe(this.container);
	}

	/** Refit (fit-width mode) and restore the reading position. Public for tests. */
	onWidthChange(): void {
		const s = this.session;
		if (!s?.ready || s.zoom.active) return;
		const anchor = this.lastTop ?? this.captureTop();
		if (this.fitMode) this.fitWidth(s.viewer.currentPageNumber);
		if (anchor) this.restoreTop(anchor);
		this.lastTop = this.captureTop();
	}

	rotate(delta: number): void {
		const v = this.session?.viewer;
		if (v) v.pagesRotation = (((v.pagesRotation + delta) % 360) + 360) % 360;
	}

	undo(): void {
		const s = this.session;
		if (!s?.undo || !s.store?.writable) return;
		const e = s.undo.undo();
		if (e) s.layers.refresh();
	}

	redo(): void {
		const s = this.session;
		if (!s?.undo || !s.store?.writable) return;
		const e = s.undo.redo();
		if (e) s.layers.refresh();
	}

	get highlights(): HighlightController | null {
		return this.session?.highlights ?? null;
	}

	/** For tests/diagnostics. */
	get debugSession(): Session | null {
		return this.session;
	}

	// ----------------------------------------------------------------- find

	openSearch(): void {
		this.searchBar.removeClass("is-hidden");
		const sel = this.contentEl.ownerDocument.getSelection()?.toString().trim();
		if (sel && sel.length < 200 && !sel.includes("\n")) this.searchInput.value = sel;
		this.searchInput.focus();
		this.searchInput.select();
		if (this.searchInput.value) this.find("", false);
	}

	closeSearch(): void {
		this.searchBar.addClass("is-hidden");
		this.searchCount.setText("");
		this.session?.eventBus.dispatch("findbarclose", { source: this });
		this.container.focus();
	}

	private find(type: "" | "again", previous: boolean): void {
		const s = this.session;
		if (!s) return;
		const query = this.searchInput.value;
		if (!query) {
			this.searchCount.setText("");
			s.eventBus.dispatch("findbarclose", { source: this });
			return;
		}
		s.eventBus.dispatch("find", {
			source: this,
			type,
			query,
			caseSensitive: false,
			entireWord: false,
			highlightAll: true,
			findPrevious: previous,
			matchDiacritics: false,
		});
	}

	private showMatches(m: { current: number; total: number } | undefined): void {
		if (!m) return;
		this.searchCount.setText(m.total > 0 ? `${m.current} / ${m.total}` : this.searchInput.value ? "No matches" : "");
	}

	// ---------------------------------------------------------------- state

	getState(): Record<string, unknown> {
		const state = super.getState();
		const v = this.session?.ready ? this.session.viewer : null;
		state.panel = this.panel?.state ?? this.pendingPanel ?? DEFAULT_PANEL_STATE;
		if (v) {
			state.page = v.currentPageNumber;
			state.scale = this.scaleValueForState();
		} else if (this.pendingState) {
			if (this.pendingState.page) state.page = this.pendingState.page;
			if (this.pendingState.scale) state.scale = this.pendingState.scale;
		}
		return state;
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const st = (state ?? {}) as { page?: unknown; scale?: unknown; panel?: unknown };
		if (st.panel !== undefined) {
			const ps = parsePanelState(st.panel);
			if (this.panel) this.panel.setState(ps);
			else this.pendingPanel = ps;
		}
		const vs: ViewerState = {};
		if (typeof st.page === "number") vs.page = st.page;
		if (typeof st.scale === "string" || typeof st.scale === "number") vs.scale = String(st.scale);
		const v = this.session?.ready ? this.session.viewer : null;
		const sameFile = typeof (state as { file?: unknown })?.file === "string" && this.file?.path === (state as { file: string }).file;
		if (!sameFile || !v) this.pendingState = vs.page || vs.scale ? vs : null;
		await super.setState(state, result);
		if (sameFile && v) {
			if (vs.scale && isScaleValue(vs.scale)) this.setScale(vs.scale);
			if (vs.page) this.goToPage(vs.page);
		}
	}

	setEphemeralState(state: unknown): void {
		const st = state as { page?: unknown; subpath?: unknown } | null;
		// links like [[file.pdf#page=3&pendf=<id>]] arrive as { subpath: "#page=3&pendf=<id>" }
		const target: PdfTarget = typeof st?.subpath === "string" ? parseSubpath(st.subpath) : {};
		const page = target.page ?? (typeof st?.page === "number" ? st.page : undefined);
		if (target.id || target.rect) {
			this.pendingNav = { ...target, page };
			if (page && !this.session?.ready) this.pendingState = { ...(this.pendingState ?? {}), page };
			this.tryNav();
		} else if (typeof page === "number") {
			if (this.session?.ready) this.goToPage(page);
			else this.pendingState = { ...(this.pendingState ?? {}), page };
		}
		super.setEphemeralState(state);
	}

	private scheduleStateSave(): void {
		if (this.saveStateTimer !== null) window.clearTimeout(this.saveStateTimer);
		this.saveStateTimer = window.setTimeout(() => {
			this.saveStateTimer = null;
			const s = this.session;
			if (!s?.ready) return;
			this.app.workspace.requestSaveLayout();
			this.plugin.rememberPosition(s.file.path, s.viewer.currentPageNumber, this.scaleValueForState());
		}, 800);
	}

	private async checkExternal(): Promise<void> {
		const store = this.session?.store;
		if (!store) return;
		try {
			await store.checkExternal();
		} catch (e) {
			log.warn("checkExternal failed", e);
		}
	}

	/** Flush pending annotation writes (visibility change, quit). */
	async flush(): Promise<void> {
		await this.session?.store?.flush();
	}

	// ------------------------------------------------------------- teardown

	async onUnloadFile(file: TFile): Promise<void> {
		log.debug(`unload ${file.path}`);
		await this.teardown();
	}

	/** Close the open document now (plugin unload). */
	async closeSession(): Promise<void> {
		this.loadToken++;
		await this.teardown();
	}

	private async teardown(): Promise<void> {
		const s = this.session;
		if (!s) return;
		this.session = null;
		if (this.saveStateTimer !== null) {
			window.clearTimeout(this.saveStateTimer);
			this.saveStateTimer = null;
			if (s.ready) this.plugin.rememberPosition(s.file.path, s.viewer.currentPageNumber, this.fitMode ? "page-width" : s.viewer.currentScaleValue);
		}
		try {
			if (s.store) {
				this.plugin.untrackStore(s.store);
				await s.store.dispose();
			}
		} catch (e) {
			log.error("saving annotations on close failed", e);
			new Notice("penDF: could not save annotations — see the log (command: Export log).");
		}
		s.highlights.destroy();
		s.notes.destroy();
		s.ink.destroy();
		s.area.destroy();
		s.zoom.cancel();
		this.inkBar?.addClass("is-hidden");
		this.inkButton?.removeClass("is-active");
		s.layers.destroy();
		this.hud?.detach();
		s.ac.abort();
		s.eventBus.dispatch("findbarclose", { source: this });
		try {
			s.viewer.cleanup();
			s.viewer.setDocument(null);
			s.linkService.setDocument(null, null);
		} catch (e) {
			log.debug("viewer cleanup", e);
		}
		this.viewerEl?.empty();
		this.closeSearch();
		this.pageCountEl?.setText("/ –");
		this.zoomLabel?.setText("–");
		await s.opened.close();
		this.notifyChange();
	}

	async onClose(): Promise<void> {
		this.loadToken++;
		await this.teardown();
		this.containerRo?.disconnect();
		if (this.widthTimer !== null) window.clearTimeout(this.widthTimer);
		if (this.topRaf !== null) window.cancelAnimationFrame(this.topRaf);
		this.panel?.destroy();
		this.panel = null;
		this.toolbar?.destroy();
		this.toolbar = null;
		this.hud?.destroy();
		this.hud = null;
		this.changeListeners.clear();
		this.pageListeners.clear();
		this.contentEl.empty();
	}

	private hudData(): Record<string, string | number> {
		const s = this.session;
		const out: Record<string, string | number> = { worker: workerMode() };
		if (!s) return out;
		const pvs: { renderingState: number }[] = [];
		for (let i = 0; i < s.viewer.pagesCount; i++) {
			const pv = s.viewer.getPageView(i) as unknown as { renderingState: number } | undefined;
			if (pv) pvs.push(pv);
		}
		out.rendering = pvs.filter((p) => p.renderingState === 1).length;
		out.rendered = pvs.filter((p) => p.renderingState === 3).length;
		out.canvases = this.container.querySelectorAll("canvas").length;
		out.layers = s.layers.attachedPages.join(",") || "–";
		out.annotations = s.store?.all().length ?? 0;
		out.store = s.store?.status ?? "–";
		out.page = `${s.viewer.currentPageNumber}/${s.viewer.pagesCount}`;
		out.scale = Math.round(s.viewer.currentScale * 100) + "%";
		out.canvasMB = s.timeline.canvasMemory().mb.toFixed(1);
		out.thumbMB = (this.thumbnailBytes() / 1048576).toFixed(1);
		out.zoomPreset = s.render.preset;
		const z = s.timeline.lastRecord();
		if (z) out.lastZoom = zoomSummary(z);
		return out;
	}
}

function isScaleValue(v: string): boolean {
	return ["page-width", "page-fit", "page-actual", "auto"].includes(v) || (Number.isFinite(Number(v)) && Number(v) > 0);
}

function askPassword(plugin: PenDFPlugin, name: string, retry: boolean): Promise<string | null> {
	return new Promise((resolve) => {
		const m = new (class extends Modal {
			value = "";
			done = false;
			onOpen() {
				this.titleEl.setText(`Password for ${name}`);
				if (retry) this.contentEl.createEl("p", { text: "Wrong password, try again." });
				new Setting(this.contentEl).setName("Password").addText((t) => {
					t.inputEl.type = "password";
					t.onChange((v) => (this.value = v));
					t.inputEl.addEventListener("keydown", (e) => {
						if (e.key === "Enter") this.submit();
					});
				});
				new Setting(this.contentEl).addButton((b) => b.setButtonText("Open").setCta().onClick(() => this.submit()));
			}
			submit() {
				this.done = true;
				resolve(this.value);
				this.close();
			}
			onClose() {
				if (!this.done) resolve(null);
			}
		})(plugin.app);
		m.open();
	});
}
