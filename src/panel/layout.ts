// In-view panel placement and reading-position keeping (0.8.0, D-42). Pure.

/** px of page area the view must keep next to a docked panel */
export const MIN_READING_WIDTH = 560;
export const PANEL_MIN = 200;
export const PANEL_MAX = 480;
export const PANEL_DEFAULT = 280;
/** an overlay panel never covers more than this share of the view */
const OVERLAY_SHARE = 0.85;

export type PanelMode = "docked" | "overlay";

/**
 * Docked next to the pages when the view is wide enough to keep
 * MIN_READING_WIDTH px of pages beside the panel; otherwise over the pages.
 * `prefer: "overlay"` forces the overlay (the user unpinned the panel).
 */
export function panelLayout(viewWidth: number, preferredWidth: number, prefer: "auto" | "overlay" = "auto"): { mode: PanelMode; width: number } {
	const w = Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, Number.isFinite(preferredWidth) ? preferredWidth : PANEL_DEFAULT)));
	if (prefer === "auto" && viewWidth >= w + MIN_READING_WIDTH) return { mode: "docked", width: w };
	return { mode: "overlay", width: Math.round(Math.max(Math.min(w, viewWidth * OVERLAY_SHARE), Math.min(PANEL_MIN, viewWidth))) };
}

/** Width while dragging the panel edge: clamped, and never leaving less than the reading width. */
export function clampPanelWidth(width: number, viewWidth: number): number {
	return Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.min(width, viewWidth - MIN_READING_WIDTH))));
}

/** The content at the top edge of the view: a page and how far down it the edge is (0..1+). */
export interface TopAnchor {
	page: number;
	/** (containerTop − pageTop) / pageHeight */
	fy: number;
}

export function topAnchor(page: number, pageTop: number, pageHeight: number, containerTop: number): TopAnchor {
	return { page, fy: pageHeight > 0 ? (containerTop - pageTop) / pageHeight : 0 };
}

/** scrollTop change that puts the anchored point back at the container's top edge. */
export function scrollToTopAnchor(a: TopAnchor, pageTop: number, pageHeight: number, containerTop: number): number {
	return pageTop + a.fy * pageHeight - containerTop;
}
