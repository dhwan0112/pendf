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
import { LayerManager } from "../layers";
import { HighlightController } from "../highlight/controller";
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
	store: SidecarStore | null;
	undo: UndoStack | null;
	ac: AbortController;
	ready: boolean;
}

export class PenDFView extends FileView {
	allowNoFile = false;
	navigation = true;

	private session: Session | null = null;
	private loadToken = 0;
	private pendingState: ViewerState | null = null;

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
		this.button(tools, "undo-2", "Undo", () => this.undo());
		this.button(tools, "redo-2", "Redo", () => this.redo());
		this.button(tools, "search", "Find in PDF", () => this.openSearch());
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
			store: null,
			undo: null,
			ac,
			ready: false,
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
		});
		this.session = session;

		eventBus.on("pagesinit", () => {
			session.ready = true;
			this.applyInitialState(file);
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
				if (source === "external") log.info(`merged external changes into ${store.path}`);
				layers.refresh();
				if (store.status !== "ok") this.showStoreStatus(store);
			},
			onProblem: (m) => log.warn(`${store.path}: ${m}`),
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
			isPinchingDisabled: () => false,
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
		const page = (state as { page?: unknown } | null)?.page;
		if (typeof page === "number") {
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
		s.layers.destroy();
		this.hud?.detach();
		s.ac.abort();
		s.eventBus.dispatch("findbarclose", { source: this });
		try {
			s.viewer.cleanup();
			s.viewer.setDocument(null as never);
			s.linkService.setDocument(null, null);
		} catch (e) {
			log.debug("viewer cleanup", e);
		}
		this.viewerEl?.empty();
		this.closeSearch();
		this.pageCountEl?.setText("/ –");
		this.zoomLabel?.setText("–");
		await s.opened.close();
	}

	async onClose(): Promise<void> {
		this.loadToken++;
		await this.teardown();
		this.hud?.destroy();
		this.hud = null;
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
