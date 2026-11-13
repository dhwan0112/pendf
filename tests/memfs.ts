import type { SidecarFs } from "../src/store/sidecar";

/** In-memory SidecarFs with controllable mtimes and failure injection. */
export class MemFs implements SidecarFs {
	files = new Map<string, { data: string; mtime: number }>();
	clock = 1000;
	writes = 0;
	renameOverwrite = true;
	failNextWrite = false;

	async exists(p: string) {
		return this.files.has(p);
	}
	async read(p: string) {
		const f = this.files.get(p);
		if (!f) throw new Error(`ENOENT ${p}`);
		return f.data;
	}
	async write(p: string, d: string) {
		if (this.failNextWrite) {
			this.failNextWrite = false;
			throw new Error("disk full");
		}
		this.writes++;
		this.files.set(p, { data: d, mtime: ++this.clock });
	}
	async remove(p: string) {
		this.files.delete(p);
	}
	async rename(a: string, b: string) {
		const f = this.files.get(a);
		if (!f) throw new Error(`ENOENT ${a}`);
		if (this.files.has(b) && !this.renameOverwrite) throw new Error("Destination file already exists!");
		this.files.delete(a);
		this.files.set(b, { ...f, mtime: ++this.clock });
	}
	async mtime(p: string) {
		return this.files.get(p)?.mtime ?? null;
	}
	/** Simulate another device writing the file. */
	externalWrite(p: string, d: string) {
		this.files.set(p, { data: d, mtime: ++this.clock });
	}
}

/** Timer stub so debounced saves are explicit in tests. */
export function manualTimers() {
	const pending = new Set<() => void>();
	return {
		setTimeout: (fn: () => void) => {
			pending.add(fn);
			return fn;
		},
		clearTimeout: (h: unknown) => {
			pending.delete(h as () => void);
		},
		async runAll() {
			const fns = [...pending];
			pending.clear();
			for (const f of fns) f();
			await new Promise((r) => setTimeout(r, 0));
		},
		get size() {
			return pending.size;
		},
	};
}
