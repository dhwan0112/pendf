// Phase 6 — ink geometry helpers. Pure, no DOM / Obsidian.
// Points are flattened PDF user-space coordinates [x0, y0, x1, y1, …].

/** Round to 0.01 pt (well below what a pen or screen can show). */
export function roundPoints(pts: readonly number[]): number[] {
	return pts.map((v) => Math.round(v * 100) / 100);
}

function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax;
	const dy = by - ay;
	const len2 = dx * dx + dy * dy;
	let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
	t = Math.max(0, Math.min(1, t));
	const x = ax + t * dx - px;
	const y = ay + t * dy - py;
	return x * x + y * y;
}

/**
 * Ramer–Douglas–Peucker simplification with tolerance `tol` (pt). Keeps the
 * first and last point; a single point (a dot) stays a single point.
 */
export function simplify(pts: readonly number[], tol: number): number[] {
	const n = pts.length / 2;
	if (n <= 2) return pts.slice();
	const keep = new Uint8Array(n);
	keep[0] = 1;
	keep[n - 1] = 1;
	const tol2 = tol * tol;
	const stack: [number, number][] = [[0, n - 1]];
	while (stack.length) {
		const [a, b] = stack.pop()!;
		let maxD = -1;
		let idx = -1;
		for (let i = a + 1; i < b; i++) {
			const d = segDist2(pts[2 * i], pts[2 * i + 1], pts[2 * a], pts[2 * a + 1], pts[2 * b], pts[2 * b + 1]);
			if (d > maxD) {
				maxD = d;
				idx = i;
			}
		}
		if (idx >= 0 && maxD > tol2) {
			keep[idx] = 1;
			stack.push([a, idx], [idx, b]);
		}
	}
	const out: number[] = [];
	for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]);
	return out;
}

/** Drop consecutive duplicate points (keeps at least one). */
export function dedupe(pts: readonly number[]): number[] {
	const out: number[] = [];
	for (let i = 0; i < pts.length; i += 2) {
		const n = out.length;
		if (n >= 2 && out[n - 2] === pts[i] && out[n - 1] === pts[i + 1]) continue;
		out.push(pts[i], pts[i + 1]);
	}
	return out;
}

export interface Box {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

export function bounds(pts: readonly number[]): Box {
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (let i = 0; i < pts.length; i += 2) {
		x0 = Math.min(x0, pts[i]);
		x1 = Math.max(x1, pts[i]);
		y0 = Math.min(y0, pts[i + 1]);
		y1 = Math.max(y1, pts[i + 1]);
	}
	return { x0, y0, x1, y1 };
}

/** Shortest distance from (x, y) to the polyline (a single point counts as a dot). */
export function distanceToPolyline(x: number, y: number, pts: readonly number[]): number {
	if (pts.length < 2) return Infinity;
	if (pts.length === 2) return Math.hypot(x - pts[0], y - pts[1]);
	let best = Infinity;
	for (let i = 0; i + 3 < pts.length; i += 2) best = Math.min(best, segDist2(x, y, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]));
	return Math.sqrt(best);
}

/** Does a stroke (with its own width) come within `radius` of the point? */
export function strokeHit(x: number, y: number, radius: number, pts: readonly number[], width: number): boolean {
	const b = bounds(pts);
	const r = radius + width / 2;
	if (x < b.x0 - r || x > b.x1 + r || y < b.y0 - r || y > b.y1 + r) return false;
	return distanceToPolyline(x, y, pts) <= r;
}

/** SVG path data for view-space points; a dot becomes a zero-length segment (drawn by round caps). */
export function pathData(view: readonly [number, number][]): string {
	if (view.length === 0) return "";
	const f = (v: number) => v.toFixed(2);
	if (view.length === 1) return `M${f(view[0][0])} ${f(view[0][1])}h0.01`;
	let d = `M${f(view[0][0])} ${f(view[0][1])}`;
	for (let i = 1; i < view.length; i++) d += `L${f(view[i][0])} ${f(view[i][1])}`;
	return d;
}
