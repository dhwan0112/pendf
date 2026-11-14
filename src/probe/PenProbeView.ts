// Pen probe (diagnostic view, enabled in settings). Measures what the
// Obsidian webview delivers for Apple Pencil and finger input, so Phase 6
// (handwriting) can be planned on data instead of guesses:
//   pointerType, pressure range, fractional coordinates, events/s,
//   getCoalescedEvents / getPredictedEvents support and samples per event,
//   Touch.touchType, and whether pen strokes scroll the page for each
//   touch-action value. Results can be exported as JSON into the vault.

import { ItemView, Notice, normalizePath, type WorkspaceLeaf } from "obsidian";
import { describePlatform } from "../util/platform";

export const PEN_PROBE_VIEW = "pendf-pen-probe";

const TOUCH_ACTIONS = ["auto", "none", "pan-x pan-y", "manipulation", "pinch-zoom", "pan-y"];

interface TypeStats {
	events: number;
	moves: number;
	firstT: number;
	lastT: number;
	pressureMin: number;
	pressureMax: number;
	pressureDistinct: Set<number>;
	fractional: number;
	coalescedSupported: boolean;
	coalescedSamples: number;
	predictedSupported: boolean;
	predictedSamples: number;
	tiltSeen: boolean;
	widthHeight: Set<string>;
	maxRateHz: number;
	strokeRates: number[];
}

function newStats(): TypeStats {
	return {
		events: 0,
		moves: 0,
		firstT: 0,
		lastT: 0,
		pressureMin: Infinity,
		pressureMax: -Infinity,
		pressureDistinct: new Set(),
		fractional: 0,
		coalescedSupported: false,
		coalescedSamples: 0,
		predictedSupported: false,
		predictedSamples: 0,
		tiltSeen: false,
		widthHeight: new Set(),
		maxRateHz: 0,
		strokeRates: [],
	};
}

export class PenProbeView extends ItemView {
	private stats = new Map<string, TypeStats>();
	private touchTypes = new Map<string, number>();
	private scrollByType = new Map<string, Map<string, number>>();
	private touchAction = "none";
	private pad!: HTMLElement;
	private scroller!: HTMLElement;
	private canvas!: HTMLCanvasElement;
	private out!: HTMLElement;
	private strokeStart = new Map<number, { t: number; n: number }>();
	private lastPt = new Map<number, [number, number]>();
	private scrollTopAtDown = 0;
	private downType = "";

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}
	getViewType(): string {
		return PEN_PROBE_VIEW;
	}
	getDisplayText(): string {
		return "penDF pen probe";
	}
	getIcon(): string {
		return "pen-tool";
	}

	async onOpen(): Promise<void> {
		const el = this.contentEl;
		el.empty();
		el.addClass("pendf-probe");
		const bar = el.createDiv({ cls: "pendf-probe-bar" });
		bar.createSpan({ text: "touch-action: " });
		const sel = bar.createEl("select");
		for (const ta of TOUCH_ACTIONS) sel.createEl("option", { text: ta, value: ta });
		sel.value = this.touchAction;
		sel.addEventListener("change", () => {
			this.touchAction = sel.value;
			this.pad.style.touchAction = this.touchAction;
		});
		bar.createEl("button", { text: "Reset" }).addEventListener("click", () => this.reset());
		bar.createEl("button", { text: "Export JSON" }).addEventListener("click", () => void this.export());
		el.createDiv({
			cls: "pendf-probe-help",
			text: "Write with the Pencil and drag with a finger inside the box, once per touch-action value. The box scrolls, so 'scrolled' tells whether input of that type scrolls the page.",
		});
		this.scroller = el.createDiv({ cls: "pendf-probe-scroller" });
		this.pad = this.scroller.createDiv({ cls: "pendf-probe-pad" });
		this.pad.style.touchAction = this.touchAction;
		this.canvas = this.pad.createEl("canvas");
		this.out = el.createEl("pre", { cls: "pendf-probe-out" });

		const opts = { passive: false } as AddEventListenerOptions;
		this.registerDomEvent(this.pad, "pointerdown", (e) => this.onDown(e), opts);
		this.registerDomEvent(this.pad, "pointermove", (e) => this.onMove(e), opts);
		this.registerDomEvent(this.pad, "pointerup", (e) => this.onUp(e), opts);
		this.registerDomEvent(this.pad, "pointercancel", (e) => this.onUp(e), opts);
		this.registerDomEvent(this.pad, "touchstart", (e) => this.onTouch(e), { passive: true });
		this.resizeCanvas();
		this.registerDomEvent(window, "resize", () => this.resizeCanvas());
		this.render();
	}

	private resizeCanvas(): void {
		const r = this.pad.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		this.canvas.width = Math.round(r.width * dpr);
		this.canvas.height = Math.round(r.height * dpr);
		this.canvas.style.width = `${r.width}px`;
		this.canvas.style.height = `${r.height}px`;
	}

	private st(type: string): TypeStats {
		let s = this.stats.get(type);
		if (!s) {
			s = newStats();
			this.stats.set(type, s);
		}
		return s;
	}

	private record(e: PointerEvent, s: TypeStats): void {
		s.events++;
		if (!s.firstT) s.firstT = e.timeStamp;
		s.lastT = e.timeStamp;
		if (e.pressure > 0) {
			s.pressureMin = Math.min(s.pressureMin, e.pressure);
			s.pressureMax = Math.max(s.pressureMax, e.pressure);
			if (s.pressureDistinct.size < 500) s.pressureDistinct.add(Math.round(e.pressure * 1000) / 1000);
		}
		if (e.clientX % 1 !== 0 || e.clientY % 1 !== 0) s.fractional++;
		if (e.tiltX || e.tiltY) s.tiltSeen = true;
		if (s.widthHeight.size < 20) s.widthHeight.add(`${e.width}x${e.height}`);
	}

	private onDown(e: PointerEvent): void {
		if (e.pointerType === "pen") e.preventDefault();
		try {
			this.pad.setPointerCapture(e.pointerId);
		} catch {
			// pointer already gone (cancelled, or synthetic); keep measuring
		}
		this.record(e, this.st(e.pointerType));
		this.strokeStart.set(e.pointerId, { t: e.timeStamp, n: 0 });
		this.lastPt.set(e.pointerId, [e.clientX, e.clientY]);
		this.scrollTopAtDown = this.scroller.scrollTop;
		this.downType = e.pointerType;
	}

	private onMove(e: PointerEvent): void {
		if (!this.strokeStart.has(e.pointerId)) return;
		const s = this.st(e.pointerType);
		this.record(e, s);
		s.moves++;
		const stroke = this.strokeStart.get(e.pointerId)!;
		stroke.n++;
		const pts: PointerEvent[] = [];
		if (typeof e.getCoalescedEvents === "function") {
			s.coalescedSupported = true;
			const c = e.getCoalescedEvents();
			s.coalescedSamples += c.length;
			pts.push(...c);
		}
		if (typeof e.getPredictedEvents === "function") {
			s.predictedSupported = true;
			s.predictedSamples += e.getPredictedEvents().length;
		}
		if (pts.length === 0) pts.push(e);
		this.draw(e.pointerId, e.pointerType, pts);
		this.renderSoon();
	}

	private onUp(e: PointerEvent): void {
		const stroke = this.strokeStart.get(e.pointerId);
		if (!stroke) return;
		const s = this.st(e.pointerType);
		const dur = (e.timeStamp - stroke.t) / 1000;
		if (dur > 0.2 && stroke.n > 3) {
			const hz = stroke.n / dur;
			s.strokeRates.push(Math.round(hz));
			s.maxRateHz = Math.max(s.maxRateHz, hz);
		}
		this.strokeStart.delete(e.pointerId);
		this.lastPt.delete(e.pointerId);
		const scrolled = this.scroller.scrollTop !== this.scrollTopAtDown;
		const byTa = this.scrollByType.get(this.downType) ?? new Map<string, number>();
		const key = `${this.touchAction}:${scrolled ? "scrolled" : "no-scroll"}`;
		byTa.set(key, (byTa.get(key) ?? 0) + 1);
		this.scrollByType.set(this.downType, byTa);
		this.render();
	}

	private onTouch(e: TouchEvent): void {
		for (const t of Array.from(e.changedTouches)) {
			const tt = (t as Touch & { touchType?: string }).touchType ?? "(unsupported)";
			this.touchTypes.set(tt, (this.touchTypes.get(tt) ?? 0) + 1);
		}
	}

	private draw(id: number, type: string, pts: PointerEvent[]): void {
		const ctx = this.canvas.getContext("2d");
		if (!ctx) return;
		const r = this.canvas.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		ctx.strokeStyle = type === "pen" ? "#1f6feb" : "#e5534b";
		ctx.lineWidth = 2 * dpr;
		ctx.beginPath();
		let last = this.lastPt.get(id);
		for (const p of pts) {
			const x = (p.clientX - r.left) * dpr;
			const y = (p.clientY - r.top) * dpr;
			if (last) ctx.moveTo((last[0] - r.left) * dpr, (last[1] - r.top) * dpr);
			ctx.lineTo(x, y);
			last = [p.clientX, p.clientY];
		}
		ctx.stroke();
		if (last) this.lastPt.set(id, last);
	}

	private renderPending = false;
	private renderSoon(): void {
		if (this.renderPending) return;
		this.renderPending = true;
		window.setTimeout(() => {
			this.renderPending = false;
			this.render();
		}, 250);
	}

	private summary(): Record<string, unknown> {
		const types: Record<string, unknown> = {};
		for (const [type, s] of this.stats) {
			const span = (s.lastT - s.firstT) / 1000;
			types[type] = {
				events: s.events,
				moves: s.moves,
				pressure: s.pressureMax >= 0 ? { min: s.pressureMin, max: s.pressureMax, distinctValues: s.pressureDistinct.size } : null,
				fractionalCoordinateShare: s.events ? +(s.fractional / s.events).toFixed(3) : 0,
				moveEventsPerSecondPerStroke: s.strokeRates,
				maxMoveRateHz: Math.round(s.maxRateHz),
				getCoalescedEvents: s.coalescedSupported,
				coalescedSamplesPerMove: s.moves ? +(s.coalescedSamples / s.moves).toFixed(2) : 0,
				getPredictedEvents: s.predictedSupported,
				predictedSamplesPerMove: s.moves ? +(s.predictedSamples / s.moves).toFixed(2) : 0,
				tilt: s.tiltSeen,
				contactSizes: [...s.widthHeight],
				observedSeconds: +span.toFixed(1),
			};
		}
		return {
			probe: "pendf pen probe v1",
			at: new Date().toISOString(),
			...describePlatform(),
			devicePixelRatio: window.devicePixelRatio,
			maxTouchPoints: navigator.maxTouchPoints,
			pointerEvents: typeof PointerEvent !== "undefined",
			touchType: Object.fromEntries(this.touchTypes),
			scrollByPointerType: Object.fromEntries([...this.scrollByType].map(([k, v]) => [k, Object.fromEntries(v)])),
			types,
		};
	}

	private render(): void {
		this.out.setText(JSON.stringify(this.summary(), null, 2));
	}

	private reset(): void {
		this.stats.clear();
		this.touchTypes.clear();
		this.scrollByType.clear();
		this.canvas.getContext("2d")?.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.render();
	}

	private async export(): Promise<void> {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const path = normalizePath(`pendf-pen-probe-${stamp}.json`);
		await this.app.vault.create(path, JSON.stringify(this.summary(), null, 2) + "\n");
		new Notice(`Pen probe saved to ${path}`);
	}
}
