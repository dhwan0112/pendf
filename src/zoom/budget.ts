// Canvas memory for rendered pages (0.7.2). No Obsidian imports: the WebKit
// smoke bundles this with the engine.
//
// pdf.js keeps the canvases of up to max(10, 2·visible+1) recently rendered
// pages. At high zoom each can be maxCanvasPixels·4 bytes, and iOS kills or
// blanks canvases past its limit, so penDF frees (a) every non-visible page's
// canvas right after a zoom commit — before new canvases are created — and
// (b) the pages farthest from the view whenever a render pushes the total
// over the preset's budget. A freed page is simply rendered again when it
// becomes visible (pdf.js treats it as never rendered).

/** The bits of a pdf.js PDFPageView used here. */
export interface PageViewLike {
	id: number;
	div: HTMLElement;
	/** 0 initial, 1 running, 2 paused, 3 finished */
	renderingState: number;
	reset(opts?: { keepAnnotationLayer?: boolean; keepAnnotationEditorLayer?: boolean; keepXfaLayer?: boolean; keepTextLayer?: boolean }): void;
}

const RUNNING = 1;

export function canvasBytes(div: Element): number {
	let b = 0;
	for (const cv of Array.from(div.querySelectorAll("canvas"))) b += cv.width * cv.height * 4;
	return b;
}

/** Free a page's canvases (pdf.js state goes back to "not rendered"); text and annotation layers stay. */
export function releasePage(pv: PageViewLike): boolean {
	if (pv.renderingState === RUNNING) return false;
	if (!pv.div.querySelector("canvas")) return false;
	pv.reset({ keepAnnotationLayer: true, keepAnnotationEditorLayer: true, keepXfaLayer: true, keepTextLayer: true });
	return true;
}

/**
 * Pages to free so the total fits `budgetBytes`, farthest from the visible range
 * first. Never a visible page, and never the page right before or after the
 * visible range: pdf.js renders that one ahead of time once the visible pages
 * are done, so freeing it would make pdf.js render it again at once — an
 * endless loop whenever the budget is smaller than what is on screen (0.7.3).
 * The budget can therefore be exceeded by what is visible plus one page.
 * `pages` holds every page that has canvases.
 */
export function pagesOverBudget(pages: { id: number; bytes: number }[], visible: Set<number>, budgetBytes: number): number[] {
	let total = pages.reduce((a, p) => a + p.bytes, 0);
	if (total <= budgetBytes) return [];
	const vis = [...visible];
	const lo = vis.length ? Math.min(...vis) : 1;
	const hi = vis.length ? Math.max(...vis) : 1;
	const dist = (id: number) => (id < lo ? lo - id : id > hi ? id - hi : 0);
	const out: number[] = [];
	for (const p of [...pages].filter((p) => !visible.has(p.id) && dist(p.id) > 1).sort((a, b) => dist(b.id) - dist(a.id))) {
		if (total <= budgetBytes) break;
		out.push(p.id);
		total -= p.bytes;
	}
	return out;
}
