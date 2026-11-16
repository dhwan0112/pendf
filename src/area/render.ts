// Render an area excerpt from the PDF (Phase 7b, 0.8.0). No Obsidian imports:
// the WebKit smoke uses this file with the engine bundle.

import { AnnotationMode } from "../pdfjs";
import type { ViewBox } from "../geometry";
import { areaRenderPlan, type AreaRenderPlan } from "./model";

interface PdfPageLike {
	view: number[];
	rotate: number;
	getViewport(opts: { scale: number; rotation?: number }): unknown;
	render(params: Record<string, unknown>): { promise: Promise<void>; cancel(): void };
}

export interface AreaRender {
	done: Promise<{ canvas: HTMLCanvasElement; plan: AreaRenderPlan } | null>;
	cancel(): void;
}

/**
 * Draw `quad` of `page` into `canvas` (or a new one) at `scale` × 100 % zoom,
 * upright as the page reads (its own /Rotate), at most `maxPixels` pixels.
 */
export function renderArea(page: PdfPageLike, quad: readonly number[], opts: { scale: number; maxPixels: number; canvas?: HTMLCanvasElement; doc: Document }): AreaRender {
	let task: { promise: Promise<void>; cancel(): void } | null = null;
	let cancelled = false;
	const done = (async () => {
		const plan = areaRenderPlan(quad, page.view as ViewBox, page.rotate, opts.scale, opts.maxPixels);
		const canvas = opts.canvas ?? opts.doc.createElement("canvas");
		canvas.width = plan.width;
		canvas.height = plan.height;
		const viewport = page.getViewport({ scale: plan.scale, rotation: plan.rotation });
		task = page.render({ canvas, viewport, transform: [1, 0, 0, 1, -plan.rect.x, -plan.rect.y], annotationMode: AnnotationMode.DISABLE, background: "#ffffff" });
		try {
			await task.promise;
		} catch {
			return null;
		}
		return cancelled ? null : { canvas, plan };
	})();
	return {
		done,
		cancel: () => {
			cancelled = true;
			task?.cancel();
		},
	};
}
