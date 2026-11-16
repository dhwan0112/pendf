// Zoom rendering presets (0.7.2, Settings → penDF → Diagnostics → Zoom rendering).
//
// maxCanvasPixels / enableDetailCanvas are pdf.js PDFViewer options; they are
// read when a document is opened, so changing the preset reopens open PDFs.
// pdf.js itself uses 5,242,880 px on iOS/Android and 2^25 elsewhere; 0.7.1 used
// 2^23 on mobile, above the iOS default (see docs/DECISIONS.md D-38).

export type ZoomPreset = "default" | "low-memory" | "no-detail" | "pdfjs";

export const ZOOM_PRESETS: Record<ZoomPreset, string> = {
	default: "Default",
	"low-memory": "Memory saver",
	"no-detail": "No detail canvas",
	pdfjs: "pdf.js defaults",
};

export interface RenderConfig {
	preset: ZoomPreset;
	/** passed to PDFViewer; undefined → pdf.js decides */
	maxCanvasPixels?: number;
	/** passed to PDFViewer; undefined → pdf.js default (on) */
	enableDetailCanvas?: boolean;
	/** cap on the canvas memory of rendered pages (w×h×4), MB; null = pdf.js alone decides */
	budgetMB: number | null;
	/** free the canvases of pages that are not visible right after a zoom commit */
	releaseOffscreen: boolean;
}

/** pdf.js's own iOS/Android value */
export const PDFJS_MOBILE_MAX_PIXELS = 5_242_880;

export function isZoomPreset(v: unknown): v is ZoomPreset {
	return typeof v === "string" && v in ZOOM_PRESETS;
}

export function renderConfig(preset: ZoomPreset, mobile: boolean): RenderConfig {
	switch (preset) {
		case "pdfjs":
			return { preset, budgetMB: null, releaseOffscreen: false };
		case "low-memory":
			return { preset, maxCanvasPixels: mobile ? 2 ** 21 : 2 ** 23, enableDetailCanvas: true, budgetMB: mobile ? 64 : 192, releaseOffscreen: true };
		case "no-detail":
			return { preset, maxCanvasPixels: mobile ? PDFJS_MOBILE_MAX_PIXELS : 2 ** 25, enableDetailCanvas: false, budgetMB: mobile ? 160 : 512, releaseOffscreen: true };
		default:
			return { preset: "default", maxCanvasPixels: mobile ? PDFJS_MOBILE_MAX_PIXELS : 2 ** 25, enableDetailCanvas: true, budgetMB: mobile ? 160 : 512, releaseOffscreen: true };
	}
}
