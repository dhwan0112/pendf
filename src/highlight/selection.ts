// DOM side of highlighting: read the current text selection inside our
// viewer and split it into per-page pieces (client rects + text).

export interface PagePiece {
	pageNumber: number;
	pageDiv: HTMLElement;
	rects: DOMRect[];
	text: string;
}

function pageOf(node: Node): { pageNumber: number; pageDiv: HTMLElement } | null {
	const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
	if (!el) return null;
	if (!el.closest(".textLayer")) return null;
	const pageDiv = el.closest<HTMLElement>(".page[data-page-number]");
	if (!pageDiv) return null;
	const n = Number(pageDiv.dataset.pageNumber);
	return Number.isInteger(n) && n > 0 ? { pageNumber: n, pageDiv } : null;
}

/** Split a selection range into per-page pieces. Only text inside pdf.js text layers counts. */
export function piecesFromRange(range: Range, root: HTMLElement): PagePiece[] {
	const pieces = new Map<number, PagePiece>();
	let ancestor: Node = range.commonAncestorContainer;
	if (ancestor.nodeType === Node.TEXT_NODE && ancestor.parentNode) ancestor = ancestor.parentNode;
	if (!root.contains(ancestor) && ancestor !== root && !ancestor.contains(root)) return [];
	const scope = root.contains(ancestor) ? ancestor : root;
	const doc = root.ownerDocument;
	const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
		acceptNode(n) {
			if (n.nodeType === Node.ELEMENT_NODE) return (n as Element).tagName === "BR" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
			return range.intersectsNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
		},
	});
	let last: PagePiece | null = null;
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		if (n.nodeType === Node.ELEMENT_NODE) {
			// line break inside a text layer
			if (last && range.intersectsNode(n)) last.text += "\n";
			continue;
		}
		const text = n as Text;
		const where = pageOf(text);
		if (!where) continue;
		const start = text === range.startContainer ? range.startOffset : 0;
		const end = text === range.endContainer ? range.endOffset : text.data.length;
		if (end <= start) continue;
		const sub = doc.createRange();
		sub.setStart(text, start);
		sub.setEnd(text, end);
		let piece = pieces.get(where.pageNumber);
		if (!piece) {
			piece = { ...where, rects: [], text: "" };
			pieces.set(where.pageNumber, piece);
		}
		for (const r of Array.from(sub.getClientRects())) piece.rects.push(r);
		piece.text += text.data.slice(start, end);
		last = piece;
	}
	return [...pieces.values()].filter((p) => p.rects.length > 0).sort((a, b) => a.pageNumber - b.pageNumber);
}

/** The current selection's range, if it is non-empty and inside root. */
export function currentRange(root: HTMLElement): Range | null {
	const sel = root.ownerDocument.getSelection();
	if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
	const range = sel.getRangeAt(0);
	if (!root.contains(range.commonAncestorContainer) && !range.intersectsNode(root)) return null;
	return range;
}
