// Sidecar storage for one PDF: `<pdf path>.pendf.json` next to the PDF.
//
// - load → migrate → validate; a fingerprint mismatch makes the store
//   read-only and hides annotations (they belong to a different PDF)
// - changes are saved 1 s after the last edit (debounced), immediately on
//   flush() (view close, app hidden)
// - writes are "atomic enough": write `<path>.tmp`, then replace; a leftover
//   .tmp from an interrupted write is recovered on the next load
// - before every write and on checkExternal() the file's mtime is compared
//   with the last one we saw; if it changed (sync, another device) the two
//   versions are merged by id (see merge.ts) instead of overwritten

import { NewerSchemaError, migrate } from "./migrate";
import { dedupe, mergeSidecars, sameAnnotations } from "./merge";
import {
	type Annotation,
	type Sidecar,
	emptySidecar,
	parseSidecar,
	serializeSidecar,
	sidecarPathFor,
} from "./schema";

export interface SidecarFs {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	remove(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	/** mtime in ms, or null when the file does not exist */
	mtime(path: string): Promise<number | null>;
}

export type StoreStatus = "ok" | "fingerprint-mismatch" | "newer-schema" | "unreadable";

export interface StoreOptions {
	debounceMs?: number;
	setTimeout?: (fn: () => void, ms: number) => unknown;
	clearTimeout?: (h: unknown) => void;
	now?: () => number;
	onChange?: (source: "local" | "external") => void;
	onProblem?: (msg: string) => void;
}

export class SidecarStore {
	private sidecar: Sidecar;
	private _status: StoreStatus = "ok";
	private dirty = false;
	private timer: unknown = null;
	private lastMtime: number | null = null;
	private chain: Promise<unknown> = Promise.resolve();
	private readonly debounceMs: number;
	private readonly setT: (fn: () => void, ms: number) => unknown;
	private readonly clearT: (h: unknown) => void;
	private disposed = false;
	statusDetail = "";

	constructor(
		private readonly fs: SidecarFs,
		private pdfPath: string,
		readonly fingerprint: string,
		private readonly opts: StoreOptions = {},
	) {
		this.sidecar = emptySidecar(fingerprint);
		this.debounceMs = opts.debounceMs ?? 1000;
		this.setT = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
		this.clearT = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
	}

	get path(): string {
		return sidecarPathFor(this.pdfPath);
	}

	get status(): StoreStatus {
		return this._status;
	}

	/** Annotations may be shown and edited only when status is "ok". */
	get writable(): boolean {
		return this._status === "ok" && !this.disposed;
	}

	get isDirty(): boolean {
		return this.dirty;
	}

	/** The PDF was renamed/moved (the sidecar file is moved by the caller). */
	setPdfPath(p: string): void {
		this.pdfPath = p;
	}

	private now(): number {
		return this.opts.now ? this.opts.now() : Date.now();
	}

	/** Read and parse the file on disk. Returns null if it doesn't exist. */
	private async readDisk(): Promise<{ sidecar: Sidecar; problems: string[] } | null> {
		const path = this.path;
		const tmp = path + ".tmp";
		let text: string | null = null;
		if (await this.fs.exists(path)) text = await this.fs.read(path);
		else if (await this.fs.exists(tmp)) {
			// interrupted save: the tmp file is the newest complete copy
			text = await this.fs.read(tmp);
			this.opts.onProblem?.(`recovered ${tmp} from an interrupted save`);
		}
		if (text === null) return null;
		const raw = migrate(JSON.parse(text));
		return parseSidecar(raw);
	}

	async load(): Promise<void> {
		return this.enqueue(async () => {
			try {
				const res = await this.readDisk();
				this.lastMtime = await this.fs.mtime(this.path);
				if (!res) {
					this.sidecar = emptySidecar(this.fingerprint);
					this._status = "ok";
					return;
				}
				for (const p of res.problems) this.opts.onProblem?.(p);
				if (res.sidecar.pdfFingerprint !== this.fingerprint) {
					this._status = "fingerprint-mismatch";
					this.statusDetail = `sidecar belongs to PDF ${res.sidecar.pdfFingerprint}, this PDF is ${this.fingerprint}`;
					this.sidecar = emptySidecar(this.fingerprint);
					return;
				}
				this.sidecar = { ...res.sidecar, annotations: dedupe(res.sidecar.annotations) };
				this._status = "ok";
			} catch (e) {
				if (e instanceof NewerSchemaError) {
					this._status = "newer-schema";
					this.statusDetail = e.message;
				} else {
					this._status = "unreadable";
					this.statusDetail = e instanceof Error ? e.message : String(e);
				}
				this.sidecar = emptySidecar(this.fingerprint);
			}
		});
	}

	/** Live (non-deleted) annotations. */
	all(): Annotation[] {
		return this.sidecar.annotations.filter((a) => !a.deleted);
	}

	/** Including tombstones (for tests / debugging). */
	raw(): Sidecar {
		return this.sidecar;
	}

	get(id: string): Annotation | undefined {
		return this.sidecar.annotations.find((a) => a.id === id);
	}

	/** Insert or replace by id. Stamps updatedAt. */
	upsert(a: Annotation): Annotation {
		this.assertWritable();
		const stamped = { ...a, updatedAt: Math.max(this.now(), a.updatedAt) } as Annotation;
		const i = this.sidecar.annotations.findIndex((x) => x.id === a.id);
		if (i >= 0) this.sidecar.annotations[i] = stamped;
		else this.sidecar.annotations.push(stamped);
		this.touch();
		return stamped;
	}

	/** Tombstone an annotation (kept so the deletion syncs). */
	remove(id: string): void {
		this.assertWritable();
		const i = this.sidecar.annotations.findIndex((x) => x.id === id);
		if (i < 0) return;
		const cur = this.sidecar.annotations[i];
		this.sidecar.annotations[i] = { ...cur, deleted: true, updatedAt: Math.max(this.now(), cur.updatedAt + 1) };
		this.touch();
	}

	/** Restore a previous version verbatim (undo), with a fresh updatedAt. */
	restore(a: Annotation): Annotation {
		this.assertWritable();
		const cur = this.get(a.id);
		const updatedAt = Math.max(this.now(), (cur?.updatedAt ?? 0) + 1);
		return this.upsert({ ...a, updatedAt } as Annotation);
	}

	private assertWritable(): void {
		if (!this.writable) throw new Error(`sidecar is not writable (${this._status})`);
	}

	private touch(): void {
		this.dirty = true;
		this.opts.onChange?.("local");
		this.scheduleSave();
	}

	private scheduleSave(): void {
		if (this.timer !== null) this.clearT(this.timer);
		this.timer = this.setT(() => {
			this.timer = null;
			void this.flush();
		}, this.debounceMs);
	}

	/** Save now if there are unsaved changes. */
	async flush(): Promise<void> {
		if (this.timer !== null) {
			this.clearT(this.timer);
			this.timer = null;
		}
		if (!this.dirty || this._status !== "ok") return;
		await this.enqueue(() => this.saveNow());
	}

	private async saveNow(): Promise<void> {
		if (!this.dirty) return;
		// Someone else wrote the file since we last looked: merge, don't clobber.
		const mt = await this.fs.mtime(this.path);
		if (mt !== null && mt !== this.lastMtime) await this.mergeFromDisk();
		if (this._status !== "ok") return;
		const text = serializeSidecar(this.sidecar);
		const path = this.path;
		const tmp = path + ".tmp";
		this.dirty = false;
		try {
			await this.fs.write(tmp, text);
			try {
				// rename-over keeps a complete file on disk at every moment
				await this.fs.rename(tmp, path);
			} catch {
				// some adapters refuse to overwrite: delete, then rename
				if (await this.fs.exists(path)) await this.fs.remove(path);
				await this.fs.rename(tmp, path);
			}
			this.lastMtime = await this.fs.mtime(path);
		} catch (e) {
			this.dirty = true;
			this.opts.onProblem?.(`save failed: ${e instanceof Error ? e.message : String(e)}`);
			throw e;
		}
	}

	/** Returns true if the file changed outside and in-memory state was updated. */
	async checkExternal(): Promise<boolean> {
		if (this._status !== "ok") return false;
		return this.enqueue(async () => {
			const mt = await this.fs.mtime(this.path);
			if (mt === this.lastMtime || mt === null) return false;
			return this.mergeFromDisk();
		});
	}

	private async mergeFromDisk(): Promise<boolean> {
		let res: { sidecar: Sidecar; problems: string[] } | null;
		try {
			res = await this.readDisk();
		} catch (e) {
			if (e instanceof NewerSchemaError) {
				this._status = "newer-schema";
				this.statusDetail = e.message;
				this.opts.onChange?.("external");
				return true;
			}
			this.opts.onProblem?.(`could not read changed sidecar: ${e instanceof Error ? e.message : String(e)}`);
			return false;
		}
		this.lastMtime = await this.fs.mtime(this.path);
		if (!res) return false;
		if (res.sidecar.pdfFingerprint !== this.fingerprint) {
			this.opts.onProblem?.("sidecar on disk now has a different fingerprint; ignoring it");
			return false;
		}
		const merged = mergeSidecars(this.sidecar, res.sidecar);
		const changedLocal = !sameAnnotations(merged.annotations, this.sidecar.annotations);
		const differsFromDisk = !sameAnnotations(merged.annotations, res.sidecar.annotations);
		this.sidecar = merged;
		if (differsFromDisk) {
			this.dirty = true;
			if (this.timer === null) this.scheduleSave();
		}
		if (changedLocal) this.opts.onChange?.("external");
		return changedLocal;
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const p = this.chain.then(fn, fn);
		this.chain = p.catch(() => undefined);
		return p;
	}

	async dispose(): Promise<void> {
		try {
			await this.flush();
		} finally {
			this.disposed = true;
		}
	}
}

/**
 * Move the sidecar along with a renamed PDF. Never overwrites an existing
 * sidecar at the destination. Returns what happened, for logging.
 */
export async function moveSidecar(fs: SidecarFs, oldPdfPath: string, newPdfPath: string): Promise<"moved" | "none" | "target-exists"> {
	const from = sidecarPathFor(oldPdfPath);
	const to = sidecarPathFor(newPdfPath);
	if (from === to) return "none";
	if (!(await fs.exists(from))) return "none";
	if (await fs.exists(to)) return "target-exists";
	await fs.rename(from, to);
	return "moved";
}
