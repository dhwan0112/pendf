// Text-highlight tool (D-46): with the tool selected, a Pencil or mouse drag over text
// highlights it at once in the tool's colour. Fingers keep selecting as before (the
// selection palette appears).
//
// The Pencil path does not rely on the platform's own Pencil text selection (unknown in
// iPadOS WKWebView): it builds the range itself from the caret positions under the
// pointer, so the result is the same on every device.

export interface TextToolHost {
	root: HTMLElement;
	container: HTMLElement;
	/** highlight the current selection in the tool colour */
	highlight(): void;
	/** the store is writable (else the tool does nothing) */
	writable(): boolean;
	onActiveChange?(on: boolean): void;
}

interface Drag {
	pointerId: number;
	start: { node: Node; offset: number };
}

export class TextTool {
	private _active = false;
	private drag: Drag | null = null;
	private ac = new AbortController();

	constructor(private readonly host: TextToolHost) {
		const c = host.container;
		const opts = { capture: true, signal: this.ac.signal };
		c.addEventListener("pointerdown", (e) => this.onDown(e), opts);
		c.addEventListener("pointermove", (e) => this.onMove(e), opts);
		c.addEventListener("pointerup", (e) => this.onUp(e, false), opts);
		c.addEventListener("pointercancel", (e) => this.onUp(e, true), opts);
		c.addEventListener(
			"touchstart",
			(e) => {
				if (!this._active) return;
				if (Array.from(e.changedTouches).some((t) => (t as Touch & { touchType?: string }).touchType === "stylus")) e.preventDefault();
			},
			{ passive: false, capture: true, signal: this.ac.signal },
		);
	}

	get active(): boolean {
		return this._active;
	}

	setActive(on: boolean): void {
		if (on === this._active) return;
		this._active = on;
		this.drag = null;
		this.host.root.toggleClass("is-text-tool", on);
		this.host.onActiveChange?.(on);
	}

	private caretAt(x: number, y: number): { node: Node; offset: number } | null {
		const doc = this.host.root.ownerDocument as Document & {
			caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
		};
		let node: Node | null = null;
		let offset = 0;
		if (typeof doc.caretRangeFromPoint === "function") {
			const r = doc.caretRangeFromPoint(x, y);
			if (r) {
				node = r.startContainer;
				offset = r.startOffset;
			}
		} else if (typeof doc.caretPositionFromPoint === "function") {
			const p = doc.caretPositionFromPoint(x, y);
			if (p) {
				node = p.offsetNode;
				offset = p.offset;
			}
		}
		if (!node || node.nodeType !== Node.TEXT_NODE) return null;
		const el = node.parentElement;
		if (!el?.closest(".textLayer") || !this.host.container.contains(el)) return null;
		return { node, offset };
	}

	private onDown(e: PointerEvent): void {
		if (!this._active || this.drag) return;
		if ((e.target as HTMLElement | null)?.closest(".pendf-floating, a, button, input, textarea")) return;
		if (e.pointerType === "mouse") return; // native mouse selection; highlighted on pointerup
		if (e.pointerType !== "pen") return; // fingers: as before
		if (!this.host.writable()) return;
		const start = this.caretAt(e.clientX, e.clientY);
		if (!start) return;
		e.preventDefault();
		e.stopPropagation();
		try {
			this.host.container.setPointerCapture(e.pointerId);
		} catch {
			// synthetic pointer
		}
		this.drag = { pointerId: e.pointerId, start };
		this.host.root.ownerDocument.getSelection()?.removeAllRanges();
	}

	private onMove(e: PointerEvent): void {
		const d = this.drag;
		if (!d || e.pointerId !== d.pointerId) return;
		e.preventDefault();
		e.stopPropagation();
		const end = this.caretAt(e.clientX, e.clientY);
		if (!end) return;
		const doc = this.host.root.ownerDocument;
		const r = doc.createRange();
		r.setStart(d.start.node, d.start.offset);
		r.setEnd(end.node, end.offset);
		if (r.collapsed) {
			// dragged backwards
			r.setStart(end.node, end.offset);
			r.setEnd(d.start.node, d.start.offset);
		}
		const sel = doc.getSelection();
		if (!sel) return;
		sel.removeAllRanges();
		sel.addRange(r);
	}

	private onUp(e: PointerEvent, cancelled: boolean): void {
		if (!this._active) return;
		const d = this.drag;
		if (d && e.pointerId === d.pointerId) {
			this.drag = null;
			e.preventDefault();
			e.stopPropagation();
			const sel = this.host.root.ownerDocument.getSelection();
			if (cancelled || !sel || sel.isCollapsed) {
				sel?.removeAllRanges();
				return;
			}
			this.host.highlight();
			return;
		}
		if (e.pointerType === "mouse" && !cancelled && this.host.writable()) {
			const sel = this.host.root.ownerDocument.getSelection();
			if (sel && !sel.isCollapsed && sel.rangeCount > 0 && this.host.container.contains(sel.getRangeAt(0).commonAncestorContainer)) this.host.highlight();
		}
	}

	destroy(): void {
		this.ac.abort();
		this.host.root.removeClass("is-text-tool");
	}
}
