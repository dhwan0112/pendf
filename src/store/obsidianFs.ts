import type { DataAdapter } from "obsidian";
import type { SidecarFs } from "./sidecar";

/** SidecarFs on top of Obsidian's public DataAdapter (vault.adapter). */
export function adapterFs(adapter: DataAdapter): SidecarFs {
	return {
		exists: (p) => adapter.exists(p, true),
		read: (p) => adapter.read(p),
		write: (p, d) => adapter.write(p, d),
		remove: (p) => adapter.remove(p),
		rename: (a, b) => adapter.rename(a, b),
		mtime: async (p) => (await adapter.stat(p))?.mtime ?? null,
	};
}
