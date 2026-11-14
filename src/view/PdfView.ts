// The penDF view: an independent FileView rendering PDFs with the bundled
// pdf.js. It never touches Obsidian's core PDF viewer or its DOM.

import { FileView, Modal, Notice, Platform, Scope, Setting, TFile, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
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
import type { Annotation } from "../store/schema";
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
	allowNoFile = false;
	navigation = true;

	private session: Session | null = null;
	private loadToken = 0;
	private pendingState: ViewerState | null = null;
	/** annotation / selection to go to once the document and its annotations are loaded */
	private pendingNav: PdfTarget | null = null;

	// DOM
	private toolbarEl!: HTMLElement;
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
	private inkBar!: HTMLElement;
	/** set while ink edits run, so the side panel is not re-rendered for every stroke */
	private quiet = false;
	private changeListeners = new Set<() => void>();

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

		this.viewerRoot = el.createDiv({ cls: "pendf-root" });
		this.container = this.viewerRoot.createDiv({ cls: "pendf-container" });
		this.container.tabIndex = 0;
		this.viewerEl = this.container.createDiv({ cls: "pdfViewer" });
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
		const b = parent.createEl("button", { cls: "pendf-icon-btn clickable-icon", attr: { "aria-label": label, title: label } });
		setIcon(b, icon);
		b.addEventListener("click", (e) => {
			e.preventDefault();
			onClick();
		});
		return b;
	}

	private buildToolbar(tb: HTMLElement): void {
		const nav = tb.createDiv({ cls: "pendf-group" });
		this.button(nav, "chevron-up", "Previous page", () => this.session?.viewer.previousPage());
		this.pageInput = nav.createEl("input", { cls: "pendf-page-input", attr: { type: "text", inputmode: "numeric", "aria-label": "Page" } });
		this.pageCountEl = nav.createSpan({ cls: "pendf-page-count", text: "/ –" });
		this.button(nav, "chevron-down", "Next page", () => this.session?.viewer.nextPage());
		this.pageInput.addEventListener("change", () => this.goToPage(Number(this.pageInput.value)));
		this.pageInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				this.goToPage(Number(this.pageInput.value));
				this.pageInput.blur();
			}
		});

		const zoom = tb.createDiv({ cls: "pendf-group" });
		this.button(zoom, "zoom-out", "Zoom out", () => this.zoom(-1));
		this.zoomLabel = zoom.createSpan({ cls: "pendf-zoom-label", text: "–" });
		this.button(zoom, "zoom-in", "Zoom in", () => this.zoom(1));
		this.button(zoom, "move-horizontal", "Fit width", () => this.setScale("page-width"));
		this.button(zoom, "rotate-cw", "Rotate view", () => this.rotate(90));

		tb.createDiv({ cls: "pendf-spacer" });
		const tools = tb.createDiv({ cls: "pendf-group" });
		this.button(tools, "highlighter", "Highlight selection", () => this.session?.highlights.createFromSelection());
		this.button(tools, "bookmark-plus", "Bookmark this spot", () => void this.addBookmark());
		this.inkButton = this.button(tools, "pen-line", "Handwriting tools (pen, highlighter, eraser)", () => this.toggleInk());
		this.noteButton = this.button(tools, "message-square-plus", "Add note (then tap the page)", () => {
			const n = this.session?.notes;
			if (n) n.setPlacing(!n.placing);
		});
		this.button(tools, "undo-2", "Undo", () => this.undo());
		this.button(tools, "redo-2", "Redo", () => this.redo());
		this.button(tools, "search", "Find in PDF", () => this.openSearch());
		this.button(tools, "link", "Copy link to this page", () => this.copyPageLink());
		this.button(tools, "list", "Outline, bookmarks and annotations", () => void this.plugin.showAnnotationsPanel());
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
			// iOS caps canvas memory hard; keep each page canvas modest there
			maxCanvasPixels: Platform.isMobile ? 2 ** 23 : 2 ** 25,
			abortSignal: ac.signal,
		} as ConstructorParameters<typeof PDFViewer>[0]);
		linkService.setViewer(viewer);

		const layers = new LayerManager(viewer, eventBus, this.container);
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
			onPlacingChange: (on) => this.noteButton?.toggleClass("is-active", on),
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
				this.inkButton?.toggleClass("is-active", on);
				this.inkBar.toggleClass("is-hidden", !on);
				if (on) this.renderInkBar();
			},
			busy: () => session.notes?.placing ?? false,
			quietly: (fn) => {
				this.quiet = true;
				try {
					fn();
				} finally {
					this.quiet = false;
				}
			},
		});
		this.session = session;

		eventBus.on("pagesinit", () => {
			session.ready = true;
			this.applyInitialState(file);
			this.tryNav();
		}, { signal: ac.signal });
		eventBus.on("pagechanging", (e: { pageNumber: number }) => {
			this.pageInput.value = String(e.pageNumber);
			this.scheduleStateSave();
		}, { signal: ac.signal });
		eventBus.on("scalechanging", (e: { scale: number }) => {
			this.zoomLabel.setText(`${Math.round(e.scale * 100)}%`);
			this.scheduleStateSave();
		}, { signal: ac.signal });
		eventBus.on("updatefindmatchescount", (e: { matchesCount: { current: number; total: number } }) => this.showMatches(e.matchesCount), { signal: ac.signal });
		eventBus.on("updatefindcontrolstate", (e: { state: number; matchesCount: { current: number; total: number } }) => {
			if (e.state === FindState.NOT_FOUND) this.searchCount.setText("No matches");
			else this.showMatches(e.matchesCount);
		}, { signal: ac.signal });

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
		const { ac, viewer } = session;
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
		// desktop: ctrl/⌘ + wheel zoom
		this.container.addEventListener(
			"wheel",
			(e) => {
				if (!(e.ctrlKey || e.metaKey)) return;
				e.preventDefault();
				const steps = e.deltaY < 0 ? 1 : -1;
				viewer.updateScale({ steps, origin: [e.clientX, e.clientY], drawingDelay: 300 });
			},
			{ passive: false, signal },
		);
		// touch: pinch zoom (pdf.js TouchManager from our bundled copy)
		let accumulated = 1;
		new TouchManager({
			container: this.container,
			// a palm resting while the Pencil writes is a second touch: no zooming mid-stroke
			isPinchingDisabled: () => session.ink.isDrawing,
			onPinchStart: () => {
				accumulated = 1;
			},
			onPinching: (origin: [number, number], prevDistance: number, distance: number) => {
				if (prevDistance <= 0) return;
				accumulated *= distance / prevDistance;
				const cur = viewer.currentScale;
				const next = Math.round(cur * accumulated * 100) / 100;
				if (next === cur) return;
				viewer.updateScale({ scaleFactor: next / cur, origin, drawingDelay: 400 });
				accumulated = 1;
			},
			onPinchEnd: () => {
				accumulated = 1;
			},
			signal,
		});
	}

	// ------------------------------------------------------------ navigation

	private applyInitialState(file: TFile): void {
		const s = this.session;
		if (!s) return;
		const remembered = this.plugin.settings.rememberPosition ? this.plugin.settings.positions[file.path] : undefined;
		const state = this.pendingState ?? (remembered ? { page: remembered.page, scale: remembered.scale } : {});
		this.pendingState = null;
		s.viewer.currentScaleValue = state.scale && isScaleValue(state.scale) ? state.scale : "page-width";
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
		if (this.session) this.session.viewer.currentScaleValue = value;
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
		if (v) {
			state.page = v.currentPageNumber;
			state.scale = v.currentScaleValue;
		} else if (this.pendingState) {
			if (this.pendingState.page) state.page = this.pendingState.page;
			if (this.pendingState.scale) state.scale = this.pendingState.scale;
		}
		return state;
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const st = (state ?? {}) as { page?: unknown; scale?: unknown };
		const vs: ViewerState = {};
		if (typeof st.page === "number") vs.page = st.page;
		if (typeof st.scale === "string" || typeof st.scale === "number") vs.scale = String(st.scale);
		const v = this.session?.ready ? this.session.viewer : null;
		const sameFile = typeof (state as { file?: unknown })?.file === "string" && this.file?.path === (state as { file: string }).file;
		if (!sameFile || !v) this.pendingState = vs.page || vs.scale ? vs : null;
		await super.setState(state, result);
		if (sameFile && v) {
			if (vs.scale && isScaleValue(vs.scale)) v.currentScaleValue = vs.scale;
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
			this.plugin.rememberPosition(s.file.path, s.viewer.currentPageNumber, s.viewer.currentScaleValue);
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
			if (s.ready) this.plugin.rememberPosition(s.file.path, s.viewer.currentPageNumber, s.viewer.currentScaleValue);
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
		this.hud?.destroy();
		this.hud = null;
		this.changeListeners.clear();
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
