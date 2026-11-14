// Remembers which PDF link the user just pressed, so that when Obsidian opens
// the PDF (in its own viewer) and penDF takes the tab over, the link's
// position (#page=…&pendf=…) can be handed to penDF. Obsidian gives that
// position only to its own viewer, which does not expose it (DECISIONS D-23).
//
// It only listens: the click itself is left to Obsidian (modifier keys, new
// tabs, hover previews all behave as usual).
//   - reading view, backlinks, search…: the <a class="internal-link"> pressed
//   - live preview / source mode: a CodeMirror extension (public API) that
//     reads the link under the pointer from the editor text

import { type App, MarkdownView, editorInfoField, parseLinktext } from "obsidian";
import { EditorView } from "@codemirror/view";
import { linkAt } from "./format";

/** how long a pressed link may wait for its tab to open */
const FRESH_MS = 3000;

interface Pending {
	path: string;
	subpath: string;
	t: number;
}

export class LinkRecorder {
	private pending: Pending | null = null;

	constructor(private readonly app: App) {}

	/** Record a link target ("path#subpath") pressed in a note at `sourcePath`. */
	record(linktext: string, sourcePath: string): void {
		const { path, subpath } = parseLinktext(linktext);
		if (!subpath) return;
		const file = this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
		if (!file || file.extension.toLowerCase() !== "pdf") return;
		this.pending = { path: file.path, subpath, t: Date.now() };
	}

	/** The subpath of a link to `path` pressed moments ago, once. */
	take(path: string): string | null {
		const p = this.pending;
		if (!p || p.path !== path || Date.now() - p.t > FRESH_MS) return null;
		this.pending = null;
		return p.subpath;
	}

	/** Listener for pointer presses anywhere in a window (capture phase). */
	readonly onPointerDown = (e: PointerEvent | MouseEvent): void => {
		const a = (e.target as Element | null)?.closest?.("a.internal-link");
		if (!a) return;
		const href = a.getAttribute("data-href") ?? a.getAttribute("href");
		if (!href) return;
		const source = this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? this.app.workspace.getActiveFile()?.path ?? "";
		this.record(href, source);
	};

	/** CodeMirror extension: record the link under the pointer in the editor. */
	editorExtension() {
		return EditorView.domEventHandlers({
			mousedown: (e, view) => {
				const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
				if (pos === null) return false;
				const line = view.state.doc.lineAt(pos);
				const target = linkAt(line.text, pos - line.from);
				if (target) {
					const source = view.state.field(editorInfoField, false)?.file?.path ?? "";
					this.record(target, source);
				}
				return false;
			},
		});
	}
}
