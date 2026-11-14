// Coordinate conversion between PDF user space and on-screen page space.
//
// Storage coordinates are always PDF user space of the page: points (1/72 in),
// origin at the bottom-left of the coordinate system the page content uses
// (MediaBox space — a CropBox with a non-zero origin is handled through the
// view box). They do not depend on zoom, rotation or device pixel ratio.
//
// "View space" is the page as displayed by pdf.js at a given scale and
// rotation: CSS pixels, origin top-left of the page box, y down. The math is
// the same as pdf.js's PageViewport, re-implemented here so it can be unit
// tested in isolation (tests/geometry.test.ts cross-checks it against pdf.js).
//
// Every other module converts coordinates through this module only.

export type Matrix = [number, number, number, number, number, number];
export type Point = [number, number];
/** [x1, y1, x2, y2] in PDF user space (pdf.js `page.view`). */
export type ViewBox = [number, number, number, number];
/**
 * Quadrilateral in PDF space, Acrobat QuadPoints order relative to the
 * displayed text: upper-left, upper-right, lower-left, lower-right.
 */
export type Quad = [number, number, number, number, number, number, number, number];

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export function normalizeRotation(r: number): 0 | 90 | 180 | 270 {
	const n = ((Math.round(r / 90) * 90) % 360 + 360) % 360;
	return n as 0 | 90 | 180 | 270;
}

/** pdf.js PageViewport transform (PDF space → view space). */
export function viewportTransform(viewBox: ViewBox, scale: number, rotation: number, offsetX = 0, offsetY = 0): Matrix {
	const [x1, y1, x2, y2] = viewBox;
	const centerX = (x1 + x2) / 2;
	const centerY = (y1 + y2) / 2;
	let a: number, b: number, c: number, d: number;
	switch (normalizeRotation(rotation)) {
		case 180:
			a = -1; b = 0; c = 0; d = 1;
			break;
		case 90:
			a = 0; b = 1; c = 1; d = 0;
			break;
		case 270:
			a = 0; b = -1; c = -1; d = 0;
			break;
		default:
			a = 1; b = 0; c = 0; d = -1;
	}
	let offsetCanvasX: number, offsetCanvasY: number;
	if (a === 0) {
		offsetCanvasX = Math.abs(centerY - y1) * scale + offsetX;
		offsetCanvasY = Math.abs(centerX - x1) * scale + offsetY;
	} else {
		offsetCanvasX = Math.abs(centerX - x1) * scale + offsetX;
		offsetCanvasY = Math.abs(centerY - y1) * scale + offsetY;
	}
	return [
		a * scale,
		b * scale,
		c * scale,
		d * scale,
		offsetCanvasX - a * scale * centerX - c * scale * centerY,
		offsetCanvasY - b * scale * centerX - d * scale * centerY,
	];
}

export function applyMatrix(m: Matrix, x: number, y: number): Point {
	return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invertMatrix(m: Matrix): Matrix {
	const det = m[0] * m[3] - m[1] * m[2];
	if (det === 0) throw new Error("singular matrix");
	return [
		m[3] / det,
		-m[1] / det,
		-m[2] / det,
		m[0] / det,
		(m[2] * m[5] - m[4] * m[3]) / det,
		(m[4] * m[1] - m[5] * m[0]) / det,
	];
}

/**
 * Geometry of one page at one (scale, rotation). Cheap to construct; make a
 * new one when the rotation changes. For zoom-independent overlays use
 * scale 1 and size the overlay with percentages / an SVG viewBox.
 */
export class PageGeometry {
	readonly toViewM: Matrix;
	readonly toPdfM: Matrix;
	readonly width: number;
	readonly height: number;
	readonly rotation: 0 | 90 | 180 | 270;

	constructor(readonly viewBox: ViewBox, readonly scale: number, rotation: number) {
		this.rotation = normalizeRotation(rotation);
		this.toViewM = viewportTransform(viewBox, scale, this.rotation);
		this.toPdfM = invertMatrix(this.toViewM);
		const w = (viewBox[2] - viewBox[0]) * scale;
		const h = (viewBox[3] - viewBox[1]) * scale;
		const swap = this.rotation === 90 || this.rotation === 270;
		this.width = Math.abs(swap ? h : w);
		this.height = Math.abs(swap ? w : h);
	}

	toView(x: number, y: number): Point {
		return applyMatrix(this.toViewM, x, y);
	}

	toPdf(x: number, y: number): Point {
		return applyMatrix(this.toPdfM, x, y);
	}

	/** Axis-aligned view-space rect → PDF quad (UL, UR, LL, LR as displayed). */
	viewRectToQuad(r: Rect): Quad {
		const ul = this.toPdf(r.x, r.y);
		const ur = this.toPdf(r.x + r.w, r.y);
		const ll = this.toPdf(r.x, r.y + r.h);
		const lr = this.toPdf(r.x + r.w, r.y + r.h);
		return [ul[0], ul[1], ur[0], ur[1], ll[0], ll[1], lr[0], lr[1]];
	}

	/** PDF quad → view-space polygon (UL, UR, LR, LL — drawable order). */
	quadToViewPolygon(q: Quad): Point[] {
		return [this.toView(q[0], q[1]), this.toView(q[2], q[3]), this.toView(q[6], q[7]), this.toView(q[4], q[5])];
	}

	/** Bounding view rect of a PDF quad. */
	quadToViewRect(q: Quad): Rect {
		return polygonBounds(this.quadToViewPolygon(q));
	}

	/**
	 * Client (viewport) coordinates → view space of this geometry, given the
	 * page element's current client rect. Works under CSS transforms (pinch
	 * preview) because it only relies on the measured rect.
	 */
	clientToView(clientX: number, clientY: number, pageRect: { left: number; top: number; width: number; height: number }): Point {
		const sx = this.width / pageRect.width;
		const sy = this.height / pageRect.height;
		return [(clientX - pageRect.left) * sx, (clientY - pageRect.top) * sy];
	}

	clientRectToView(r: { left: number; top: number; width: number; height: number }, pageRect: { left: number; top: number; width: number; height: number }): Rect {
		const [x, y] = this.clientToView(r.left, r.top, pageRect);
		const [x2, y2] = this.clientToView(r.left + r.width, r.top + r.height, pageRect);
		return { x, y, w: x2 - x, h: y2 - y };
	}
}

export function polygonBounds(pts: Point[]): Rect {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const [x, y] of pts) {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Point-in-convex-polygon (view space), inclusive with tolerance in px. */
export function pointInPolygon(p: Point, poly: Point[], tol = 0): boolean {
	if (tol > 0) {
		const b = polygonBounds(poly);
		if (p[0] < b.x - tol || p[0] > b.x + b.w + tol || p[1] < b.y - tol || p[1] > b.y + b.h + tol) return false;
		if (b.w < 1e-9 || b.h < 1e-9) return true;
	}
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const [xi, yi] = poly[i];
		const [xj, yj] = poly[j];
		if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
	}
	if (inside || tol <= 0) return inside;
	// within tol of the bounding box of an axis-aligned quad counts as a hit
	const b = polygonBounds(poly);
	return p[0] >= b.x - tol && p[0] <= b.x + b.w + tol && p[1] >= b.y - tol && p[1] <= b.y + b.h + tol;
}

export function distance(a: Point, b: Point): number {
	return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
