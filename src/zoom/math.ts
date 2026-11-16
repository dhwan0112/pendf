// Zoom math (0.7.2). Pure — no DOM, no pdf.js.
//
// During a gesture the pages are only *composited*: the .pdfViewer element gets
//   transform-origin: O;  transform: translate(t) scale(f)
// where O is the gesture's starting centre in the element's own (untransformed)
// coordinates. A content point p ends up on screen at  elementOrigin + O + f·(p − O) + t,
// so the point that was under the starting centre (p = O) stays under the current
// centre when t = currentCentre − startCentre.

/** gesture limits; a gesture starting outside them (toolbar zoom goes 0.1–25) keeps its start scale reachable */
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 10;

export function clampScale(scale: number, min = MIN_SCALE, max = MAX_SCALE): number {
	return Math.min(max, Math.max(min, scale));
}

/** The gesture factor f actually allowed, so that startScale·f stays within the limits. */
export function clampFactor(startScale: number, factor: number, min = MIN_SCALE, max = MAX_SCALE): number {
	if (!(startScale > 0) || !Number.isFinite(factor) || factor <= 0) return 1;
	return clampScale(startScale * factor, min, max) / startScale;
}

export interface CompositeState {
	/** gesture origin in the transformed element's own coordinates (CSS px) */
	originX: number;
	originY: number;
	/** translation that follows the moving gesture centre (CSS px) */
	tx: number;
	ty: number;
	/** scale factor relative to the scale at gesture start */
	factor: number;
}

export function transformCss(st: CompositeState): { origin: string; transform: string } {
	const f = st.factor;
	return {
		origin: `${st.originX.toFixed(2)}px ${st.originY.toFixed(2)}px`,
		transform: `translate(${st.tx.toFixed(2)}px, ${st.ty.toFixed(2)}px) scale(${f.toFixed(5)})`,
	};
}

/** Where a point of the element (its own coordinates) appears on screen under the composite transform. */
export function projectPoint(st: CompositeState, elLeft: number, elTop: number, px: number, py: number): [number, number] {
	return [elLeft + st.originX + st.factor * (px - st.originX) + st.tx, elTop + st.originY + st.factor * (py - st.originY) + st.ty];
}

export interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * Keep the composited preview within what scrolling can show after the commit,
 * so releasing the fingers does not make the view jump:
 * - vertically the document's top/bottom cannot come off the container's edges
 *   (a document shorter than the container sits at its top);
 * - horizontally a page narrower than the container is centred by pdf.js, and a
 *   wider one cannot come off the container's left/right edges.
 * `el` is the transformed element's untransformed client box (height = its full
 * content height); `page` is the anchored page in the element's coordinates.
 */
export function clampTranslate(st: CompositeState, el: { left: number; top: number; height: number }, page: { left: number; width: number } | null, view: Box): { tx: number; ty: number } {
	const f = st.factor;
	let { tx, ty } = st;
	// vertical: transformed element top = el.top + originY·(1−f) + ty
	const h = f * el.height;
	const top = el.top + st.originY * (1 - f) + ty;
	if (h <= view.height) ty += view.top - top;
	else if (top > view.top) ty += view.top - top;
	else if (top + h < view.top + view.height) ty += view.top + view.height - (top + h);
	if (page) {
		const w = f * page.width;
		const left = el.left + st.originX + f * (page.left - st.originX) + tx;
		if (w <= view.width) tx += view.left + (view.width - w) / 2 - left;
		else if (left > view.left) tx += view.left - left;
		else if (left + w < view.left + view.width) tx += view.left + view.width - (left + w);
	}
	return { tx, ty };
}

/** A content point as a fraction of a page box (stable across scale changes). */
export interface PageAnchor {
	page: number;
	fx: number;
	fy: number;
}

export function anchorIn(rect: { left: number; top: number; width: number; height: number }, x: number, y: number): { fx: number; fy: number } {
	return { fx: rect.width ? (x - rect.left) / rect.width : 0, fy: rect.height ? (y - rect.top) / rect.height : 0 };
}

/**
 * Scroll change that puts the anchored content point back under (x, y) once the
 * page has its new size at `rect` (client coordinates, after the scale change).
 */
export function scrollCorrection(anchor: { fx: number; fy: number }, rect: { left: number; top: number; width: number; height: number }, x: number, y: number): { dx: number; dy: number } {
	return { dx: rect.left + anchor.fx * rect.width - x, dy: rect.top + anchor.fy * rect.height - y };
}

// ---------------------------------------------------------------- wheel

/** DOM_DELTA_PIXEL / LINE / PAGE */
export const DELTA_PIXEL = 0;
export const DELTA_LINE = 1;
export const DELTA_PAGE = 2;
const PIXELS_PER_LINE = 30;
const PIXELS_PER_PAGE = 800;

/** Wheel delta in pixels, whatever the event's deltaMode. */
export function wheelPixels(deltaY: number, deltaMode: number): number {
	if (deltaMode === DELTA_LINE) return deltaY * PIXELS_PER_LINE;
	if (deltaMode === DELTA_PAGE) return deltaY * PIXELS_PER_PAGE;
	return deltaY;
}

/**
 * Trackpad pinch (and precise wheels) send ctrl+wheel with small pixel deltas;
 * a mouse wheel notch is a line delta or a large pixel delta (~100).
 */
export function isContinuousWheel(deltaY: number, deltaMode: number): boolean {
	return deltaMode === DELTA_PIXEL && Math.abs(deltaY) < 50;
}

/** Multiplicative zoom factor for one ctrl+wheel event (as pdf.js's own viewer does for pinch). */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
	return Math.exp(-wheelPixels(deltaY, deltaMode) / 100);
}
