// The vault-wide annotation index as a plugin service (0.8.0, D-45).
//
// - built lazily (a few seconds after the layout is ready, or on first use),
//   in slices that yield to the UI so the main thread is never held for long
// - kept current from vault events (create, modify, rename, delete) on sidecars
// - cached in the plugin's own folder (rebuildable data — never in the notes
//   area of the vault); a cached sidecar is re-read only when its mtime changed

import { TFile, type App, type TAbstractFile } from "obsidian";
import { AnnotationIndex, isSidecarPath, type AnnotationRef, type SearchQuery, type SearchResult } from "./model";
import { migrate } from "../store/migrate";
import { parseSidecar } from "../store/schema";
import { logger } from "../util/log";

const log = logger("index");
const CACHE_FILE = "annotation-index.json";
/** longest stretch of work before yielding to the UI, ms */
const SLICE_MS = 12;
const SAVE_DELAY_MS = 5000;

export interface IndexBuildStats {
	ms: number;
	sidecars: number;
	annotations: number;
	read: number;
	fromCache: number;
	/** longest uninterrupted stretch on the main thread, ms */
	maxSliceMs: number;
	slices: number;
}

export class VaultAnnotationIndex {
	private idx = new AnnotationIndex();
	private building: Promise<void> | null = null;
	private built = false;
	private saveTimer: number | null = null;
	private pending = new Map<string, number>();
	lastBuild: IndexBuildStats | null = null;

	constructor(
		private readonly app: App,
		/** the plugin's folder (manifest.dir) */
		private readonly dir: string,
	) {}

	get cachePath(): string {
		return `${this.dir}/${CACHE_FILE}`;
	}

	get ready(): boolean {
		return this.built;
	}

	/** Build once (later calls wait for the same build). */
	ensure(): Promise<void> {
		if (this.built) return Promise.resolve();
		this.building ??= this.build().finally(() => {
			this.building = null;
		});
		return this.building;
	}

	/** Drop everything and build from the sidecars again (tests, "rebuild"). */
	async rebuild(useCache = false): Promise<IndexBuildStats | null> {
		await this.building?.catch(() => {});
		this.idx = new AnnotationIndex();
		this.built = false;
		this.skipCacheOnce = !useCache;
		await this.ensure();
		return this.lastBuild;
	}

	private skipCacheOnce = false;

	private async build(): Promise<void> {
		const t0 = performance.now();
		const adapter = this.app.vault.adapter;
		let fromCache = 0;
		if (!this.skipCacheOnce) {
			try {
				if (await adapter.exists(this.cachePath)) {
					this.idx = AnnotationIndex.fromCache(JSON.parse(await adapter.read(this.cachePath)));
					fromCache = this.idx.sidecarCount;
				}
			} catch (e) {
				log.warn("index cache unreadable; rebuilding", e);
				this.idx = new AnnotationIndex();
			}
		}
		this.skipCacheOnce = false;
		const files = this.app.vault.getFiles().filter((f) => isSidecarPath(f.path));
		const present = new Set(files.map((f) => f.path));
		for (const p of this.idx.paths()) if (!present.has(p)) this.idx.remove(p);
		let read = 0;
		let slices = 1;
		let maxSlice = 0;
		let sliceStart = performance.now();
		for (const f of files) {
			if (this.idx.mtimeOf(f.path) === f.stat.mtime) continue;
			await this.indexFile(f);
			read++;
			const now = performance.now();
			if (now - sliceStart > SLICE_MS) {
				maxSlice = Math.max(maxSlice, now - sliceStart);
				await new Promise((r) => window.setTimeout(r, 0));
				slices++;
				sliceStart = performance.now();
			}
		}
		maxSlice = Math.max(maxSlice, performance.now() - sliceStart);
		this.built = true;
		this.lastBuild = { ms: Math.round(performance.now() - t0), sidecars: this.idx.sidecarCount, annotations: this.idx.annotationCount, read, fromCache, maxSliceMs: Math.round(maxSlice * 10) / 10, slices };
		log.info(`annotation index: ${this.lastBuild.annotations} annotations in ${this.lastBuild.sidecars} sidecars, ${this.lastBuild.ms} ms (${read} read, ${fromCache} cached)`);
		if (read || fromCache !== this.idx.sidecarCount) this.saveSoon();
	}

	private async indexFile(f: TFile): Promise<void> {
		try {
			const text = await this.app.vault.cachedRead(f);
			const { sidecar } = parseSidecar(migrate(JSON.parse(text)));
			this.idx.upsert(f.path, sidecar, f.stat.mtime);
		} catch (e) {
			// unreadable or foreign JSON: not indexed (penDF's own store reports problems when the PDF is opened)
			this.idx.remove(f.path);
			log.debug(`not indexed: ${f.path}`, e);
		}
	}

	// ------------------------------------------------------------ vault events

	onCreateOrModify(file: TAbstractFile): void {
		if (!(file instanceof TFile) || !isSidecarPath(file.path) || !this.built) return;
		this.queue(file);
	}

	onDelete(file: TAbstractFile): void {
		if (!isSidecarPath(file.path) || !this.built) return;
		this.idx.remove(file.path);
		this.saveSoon();
	}

	onRename(file: TAbstractFile, oldPath: string): void {
		if (!this.built) return;
		if (isSidecarPath(oldPath)) {
			if (isSidecarPath(file.path)) this.idx.rename(oldPath, file.path);
			else this.idx.remove(oldPath);
			this.saveSoon();
		}
		if (file instanceof TFile && isSidecarPath(file.path)) this.queue(file);
	}

	/** Re-read a changed sidecar shortly (penDF saves in bursts). */
	private queue(file: TFile): void {
		const prev = this.pending.get(file.path);
		if (prev !== undefined) window.clearTimeout(prev);
		this.pending.set(
			file.path,
			window.setTimeout(() => {
				this.pending.delete(file.path);
				void this.indexFile(file).then(() => this.saveSoon());
			}, 300),
		);
	}

	/** Changes still waiting to be indexed (tests). */
	get pendingCount(): number {
		return this.pending.size;
	}

	// ------------------------------------------------------------------- query

	async resolve(ref: AnnotationRef): Promise<SearchResult | null> {
		await this.ensure();
		return this.idx.resolve(ref);
	}

	async search(q: SearchQuery): Promise<SearchResult[]> {
		await this.ensure();
		return this.idx.search(q);
	}

	get stats(): { sidecars: number; annotations: number } {
		return { sidecars: this.idx.sidecarCount, annotations: this.idx.annotationCount };
	}

	// ------------------------------------------------------------------- cache

	private saveSoon(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.save();
		}, SAVE_DELAY_MS);
	}

	async save(): Promise<void> {
		if (!this.built) return;
		try {
			await this.app.vault.adapter.write(this.cachePath, JSON.stringify(this.idx.toCache()));
		} catch (e) {
			log.warn("could not write the index cache", e);
		}
	}

	async dispose(): Promise<void> {
		for (const t of this.pending.values()) window.clearTimeout(t);
		this.pending.clear();
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
			await this.save();
		}
	}
}
