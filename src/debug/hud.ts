// Debug overlay (setting): live counters for the iPad memory/perf gate.
import type { EventBus } from "../pdfjs";

export class DebugHud {
	private el: HTMLElement;
	private timer: number;
	private renderStart = new Map<number, number>();
	private lastRenderMs: number[] = [];

	constructor(parent: HTMLElement, private readonly data: () => Record<string, string | number>) {
		this.el = parent.createDiv({ cls: "pendf-hud" });
		this.timer = window.setInterval(() => this.update(), 500);
		this.update();
	}

	attach(eventBus: EventBus, signal: AbortSignal): void {
		eventBus.on("pagerender", (e: { pageNumber: number }) => this.renderStart.set(e.pageNumber, performance.now()), { signal });
		eventBus.on("pagerendered", (e: { pageNumber: number }) => {
			const t0 = this.renderStart.get(e.pageNumber);
			if (t0 === undefined) return;
			this.renderStart.delete(e.pageNumber);
			this.lastRenderMs.push(performance.now() - t0);
			if (this.lastRenderMs.length > 20) this.lastRenderMs.shift();
		}, { signal });
	}

	detach(): void {
		this.renderStart.clear();
	}

	private update(): void {
		const d = this.data();
		if (this.lastRenderMs.length) {
			const last = this.lastRenderMs[this.lastRenderMs.length - 1];
			const avg = this.lastRenderMs.reduce((a, b) => a + b, 0) / this.lastRenderMs.length;
			d.renderMs = `${last.toFixed(0)} (avg ${avg.toFixed(0)})`;
		}
		const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
		if (mem) d.heapMB = (mem.usedJSHeapSize / 1048576).toFixed(0);
		this.el.setText(Object.entries(d).map(([k, v]) => `${k}: ${v}`).join("\n"));
	}

	destroy(): void {
		window.clearInterval(this.timer);
		this.el.remove();
	}
}
