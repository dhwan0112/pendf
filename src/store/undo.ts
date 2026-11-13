// Per-document undo/redo over sidecar edits. An entry records the versions of
// the touched annotations before and after one user action; undo restores
// "before" (or tombstones annotations that did not exist), redo restores
// "after". Restored copies get a fresh updatedAt so they win merges.

import type { Annotation } from "./schema";
import type { SidecarStore } from "./sidecar";

export interface UndoEntry {
	label: string;
	before: Map<string, Annotation | null>;
	after: Map<string, Annotation>;
}

export class UndoStack {
	private undoList: UndoEntry[] = [];
	private redoList: UndoEntry[] = [];
	constructor(private readonly store: SidecarStore, private readonly limit = 200) {}

	/**
	 * Run `fn`, which edits the store, and record it as one undoable action.
	 * `ids` are the annotations the action touches (new ids included).
	 */
	record(label: string, ids: string[], fn: () => void): void {
		const before = new Map<string, Annotation | null>();
		for (const id of ids) {
			const a = this.store.get(id);
			before.set(id, a ? structuredClone(a) : null);
		}
		fn();
		const after = new Map<string, Annotation>();
		for (const id of ids) {
			const a = this.store.get(id);
			if (a) after.set(id, structuredClone(a));
		}
		this.undoList.push({ label, before, after });
		if (this.undoList.length > this.limit) this.undoList.shift();
		this.redoList = [];
	}

	get canUndo(): boolean {
		return this.undoList.length > 0;
	}
	get canRedo(): boolean {
		return this.redoList.length > 0;
	}

	undo(): UndoEntry | null {
		const e = this.undoList.pop();
		if (!e) return null;
		for (const [id, prev] of e.before) {
			if (prev) this.store.restore(prev);
			else if (this.store.get(id) && !this.store.get(id)!.deleted) this.store.remove(id);
		}
		this.redoList.push(e);
		return e;
	}

	redo(): UndoEntry | null {
		const e = this.redoList.pop();
		if (!e) return null;
		for (const a of e.after.values()) this.store.restore(a);
		this.undoList.push(e);
		return e;
	}

	clear(): void {
		this.undoList = [];
		this.redoList = [];
	}
}
