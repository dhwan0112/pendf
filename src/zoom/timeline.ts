// Zoom gesture timeline (0.7.2): what happened during and right after the last
// pinch / trackpad zoom, for the debug overlay, the log and an exportable JSON
// (command "Export last zoom timeline"). Cheap enough to run always; pixel
// sampling of fresh canvases (blank / black detection) only in diagnostic mode.

import type { EventBus } from "../pdfjs";
import { logger } from "../util/log";

const log = logger("zoom");

/** how long after a commit renders still count towards the gesture */
const AFTER_MS = 4000;

export interface RenderMark {
	page: number;
	cssTransform: boolean;
	detail: boolean;
	/** ms since gesture start */
	t: number;
	blank?: boolean;
}

export interface GestureRecord {
	kind: "pinch" | "wheel";
	startedAt: string;
	startScale: number;
	endScale: number | null;
	/** ms since start */
	endT: number | null;
	commitMs: number | null;
	/** rAF intervals during the gesture (ms) */
	frames: number[];
	transformWrites: number;
	/** pdf.js scale changes while the fingers were down (should be 0) */
	scaleChangesDuringGesture: number;
	layerAttachDuringGesture: number;
	layerDetachDuringGesture: number;
	renders: RenderMark[];
	canvasesCreated: number;
	canvasesReleased: number;
	/** canvas memory estimate, width × height × 4, MB */
	memStartMB: number;
	memPeakMB: number;
	memEndMB: number;
	canvasPeak: number;
	blank: number;
	releasedOffscreen: number;
	anchorErrorPx: number | null;
}

export interface TimelineHost {
	/** element holding every canvas penDF creates (pages, details, live ink) */
	root: HTMLElement;
	eventBus: EventBus;
	signal: AbortSignal;
	layerCounters: () => { attach: number; detach: number };
	diagnostics: () => boolean;
}

export class ZoomTimeline {
	private cur: GestureRecord | null = null;
	private last: GestureRecord | null = null;
	private t0 = 0;
	private lastFrame = 0;
	private raf: number | null = null;
	private gestureActive = false;
	private scaleChanges = 0;
	private layerAt = { attach: 0, detach: 0 };
	private afterUntil = 0;
	private mo: MutationObserver;

	constructor(private readonly host: TimelineHost) {
		const on = (name: string, fn: (e: never) => void) => host.eventBus.on(name, fn, { signal: host.signal });
		on("scalechanging", () => {
			if (this.gestureActive) this.scaleChanges++;
		});
		on("pagerendered", (e: { pageNumber: number; cssTransform?: boolean; isDetailView?: boolean; source?: { canvas?: HTMLCanvasElement | null } }) => this.onRendered(e));
		this.mo = new MutationObserver((records) => {
			const r = this.cur;
			if (!r) return;
			for (const m of records) {
				for (const n of Array.from(m.addedNodes)) if (n.nodeName === "CANVAS") r.canvasesCreated++;
				for (const n of Array.from(m.removedNodes)) if (n.nodeName === "CANVAS") r.canvasesReleased++;
			}
			this.sample();
		});
		this.mo.observe(host.root, { childList: true, subtree: true });
		host.signal.addEventListener("abort", () => this.dispose());
	}

	/** Live canvas memory estimate (MB) and count. */
	canvasMemory(): { mb: number; count: number } {
		let bytes = 0;
		let count = 0;
		for (const cv of Array.from(this.host.root.querySelectorAll("canvas"))) {
			bytes += cv.width * cv.height * 4;
			count++;
		}
		return { mb: bytes / 1048576, count };
	}

	private sample(): void {
		const r = this.cur;
		if (!r) return;
		const { mb, count } = this.canvasMemory();
		r.memPeakMB = Math.max(r.memPeakMB, mb);
		r.canvasPeak = Math.max(r.canvasPeak, count);
	}

	begin(kind: GestureRecord["kind"], startScale: number): void {
		this.finishAfter();
		this.t0 = performance.now();
		this.lastFrame = this.t0;
		this.gestureActive = true;
		this.scaleChanges = 0;
		this.layerAt = this.host.layerCounters();
		const { mb, count } = this.canvasMemory();
		this.cur = {
			kind,
			startedAt: new Date().toISOString(),
			startScale,
			endScale: null,
			endT: null,
			commitMs: null,
			frames: [],
			transformWrites: 0,
			scaleChangesDuringGesture: 0,
			layerAttachDuringGesture: 0,
			layerDetachDuringGesture: 0,
			renders: [],
			canvasesCreated: 0,
			canvasesReleased: 0,
			memStartMB: mb,
			memPeakMB: mb,
			memEndMB: mb,
			canvasPeak: count,
			blank: 0,
			releasedOffscreen: 0,
			anchorErrorPx: null,
		};
		const tick = (now: number) => {
			if (!this.gestureActive || !this.cur) return;
			this.cur.frames.push(Math.round((now - this.lastFrame) * 10) / 10);
			this.lastFrame = now;
			this.raf = window.requestAnimationFrame(tick);
		};
		this.raf = window.requestAnimationFrame(tick);
	}

	transformWritten(): void {
		if (this.cur) this.cur.transformWrites++;
	}

	/** The fingers lifted: the gesture is over, the commit follows in the same task. */
	end(endScale: number, commitMs: number, releasedOffscreen: number, anchorErrorPx: number | null): void {
		const r = this.cur;
		if (!r) return;
		this.gestureActive = false;
		if (this.raf !== null) window.cancelAnimationFrame(this.raf);
		this.raf = null;
		const lc = this.host.layerCounters();
		r.endT = Math.round(performance.now() - this.t0);
		r.endScale = endScale;
		r.commitMs = Math.round(commitMs * 10) / 10;
		r.scaleChangesDuringGesture = this.scaleChanges;
		r.layerAttachDuringGesture = lc.attach - this.layerAt.attach;
		r.layerDetachDuringGesture = lc.detach - this.layerAt.detach;
		r.releasedOffscreen = releasedOffscreen;
		r.anchorErrorPx = anchorErrorPx;
		this.afterUntil = performance.now() + AFTER_MS;
		window.setTimeout(() => this.finishAfter(), AFTER_MS + 50);
	}

	private onRendered(e: { pageNumber: number; cssTransform?: boolean; isDetailView?: boolean; source?: { canvas?: HTMLCanvasElement | null } }): void {
		const r = this.cur;
		if (!r || (!this.gestureActive && performance.now() > this.afterUntil)) return;
		const mark: RenderMark = { page: e.pageNumber, cssTransform: !!e.cssTransform, detail: !!e.isDetailView, t: Math.round(performance.now() - this.t0) };
		if (!e.cssTransform && this.host.diagnostics()) {
			const blank = isBlank(e.source?.canvas ?? null);
			if (blank) {
				mark.blank = true;
				r.blank++;
				log.warn(`blank or black canvas after render: page ${e.pageNumber}${e.isDetailView ? " (detail)" : ""}`);
			}
		}
		r.renders.push(mark);
		this.sample();
	}

	private finishAfter(): void {
		const r = this.cur;
		if (!r || this.gestureActive) return;
		r.memEndMB = this.canvasMemory().mb;
		const round = (n: number) => Math.round(n * 10) / 10;
		r.memStartMB = round(r.memStartMB);
		r.memPeakMB = round(r.memPeakMB);
		r.memEndMB = round(r.memEndMB);
		this.last = r;
		this.cur = null;
		log.info(`zoom ${r.kind} ${r.startScale.toFixed(2)}→${r.endScale?.toFixed(2)}: ${summary(r)}`);
	}

	/** The last finished gesture (or the one still settling). */
	lastRecord(): GestureRecord | null {
		return this.cur && !this.gestureActive ? this.cur : this.last;
	}

	dispose(): void {
		this.gestureActive = false;
		if (this.raf !== null) window.cancelAnimationFrame(this.raf);
		this.mo.disconnect();
	}
}

export function summary(r: GestureRecord): string {
	const f = r.frames.filter((x) => x > 0);
	const avg = f.length ? f.reduce((a, b) => a + b, 0) / f.length : 0;
	const max = f.length ? Math.max(...f) : 0;
	const full = r.renders.filter((x) => !x.cssTransform && !x.detail).length;
	return `frames avg ${avg.toFixed(1)} / max ${max.toFixed(1)} ms, scale changes during ${r.scaleChangesDuringGesture}, layers ±${r.layerAttachDuringGesture}/${r.layerDetachDuringGesture}, renders after ${full} (+${r.renders.filter((x) => x.detail).length} detail), canvas ${r.memStartMB}→peak ${r.memPeakMB} MB, blank ${r.blank}`;
}

/** Nine pixels all black or all transparent → the canvas shows nothing. */
export function isBlank(canvas: HTMLCanvasElement | null): boolean {
	if (!canvas || !canvas.width || !canvas.height) return false;
	try {
		const ctx = canvas.getContext("2d");
		if (!ctx) return true;
		let dark = 0;
		for (const fx of [0.1, 0.5, 0.9]) {
			for (const fy of [0.1, 0.5, 0.9]) {
				const d = ctx.getImageData(Math.floor(canvas.width * fx), Math.floor(canvas.height * fy), 1, 1).data;
				if (d[3] === 0 || d[0] + d[1] + d[2] < 30) dark++;
			}
		}
		return dark === 9;
	} catch {
		return false;
	}
}
