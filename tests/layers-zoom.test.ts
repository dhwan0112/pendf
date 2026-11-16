// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { LayerManager } from "../src/layers";
import type { EventBus, PDFViewer } from "../src/pdfjs";

// Obsidian's DOM helpers used by the layer code
beforeAll(() => {
	const g = globalThis as unknown as Record<string, unknown>;
	g.createDiv = (o: { cls?: string; attr?: Record<string, string> } = {}) => {
		const d = document.createElement("div");
		if (o.cls) d.className = o.cls;
		for (const [k, v] of Object.entries(o.attr ?? {})) d.setAttribute(k, v);
		(d as unknown as { doc: Document }).doc = document;
		return d;
	};
	g.activeDocument = document;
	(Node.prototype as unknown as { instanceOf: (t: unknown) => boolean }).instanceOf = function (this: Node, t: unknown) {
		return this instanceof (t as typeof Node);
	};
});

function setup(pages = 3) {
	const container = document.body.appendChild(document.createElement("div"));
	const viewerEl = container.appendChild(document.createElement("div"));
	const views = Array.from({ length: pages }, (_, i) => {
		const div = viewerEl.appendChild(document.createElement("div"));
		div.className = "page";
		div.appendChild(document.createElement("div")).className = "canvasWrapper";
		return { id: i + 1, div, viewport: { viewBox: [0, 0, 612, 792], rotation: 0, userUnit: 1, scale: 1, width: 612, height: 792 }, textLayer: null };
	});
	const viewer = { pagesCount: pages, getPageView: (i: number) => views[i] } as unknown as PDFViewer;
	const handlers = new Map<string, ((e: unknown) => void)[]>();
	const eventBus = {
		on: (name: string, fn: (e: unknown) => void) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
		dispatch: (name: string, e: unknown) => handlers.get(name)?.forEach((f) => f(e)),
	} as unknown as EventBus & { dispatch: (n: string, e: unknown) => void };
	const layers = new LayerManager(viewer, eventBus, container);
	return { container, views, layers, eventBus };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("layers during a zoom gesture (0.7.2)", () => {
	it("attach and detach are counted", () => {
		const { layers } = setup();
		layers.sync();
		expect(layers.attachedPages).toEqual([1, 2, 3]);
		expect(layers.counters.attach).toBe(3);
	});

	it("frozen: no rAF scheduled, no sync, layers stay where they are", () => {
		const { layers, eventBus } = setup();
		layers.sync();
		const raf = vi.spyOn(window, "requestAnimationFrame");
		layers.setFrozen(true);
		layers.schedule();
		eventBus.dispatch("updateviewarea", {});
		layers.sync();
		expect(raf).not.toHaveBeenCalled();
		expect(layers.counters.detach).toBe(0);
		expect(layers.attachedPages).toEqual([1, 2, 3]);
		raf.mockRestore();
	});

	it("unfreezing syncs at once", () => {
		const { layers } = setup();
		layers.setFrozen(true);
		layers.ensure(2); // a page rendered during the gesture: not attached yet
		expect(layers.attachedPages).toEqual([]);
		layers.setFrozen(false);
		expect(layers.attachedPages).toEqual([1, 2, 3]);
	});

	it("puts back a layer pdf.js removed while resetting a page, before the next frame", async () => {
		const { layers, views } = setup();
		layers.sync();
		const host = views[1].div.querySelector(".pendf-layer-host");
		expect(host).not.toBeNull();
		host!.remove(); // what PDFPageView.reset() does to unknown children
		await flush();
		expect(host!.isConnected).toBe(true);
		expect(host!.parentElement).toBe(views[1].div);
		expect(layers.counters.restored).toBe(1);
	});

	it("does not resurrect a layer it detached itself", async () => {
		const { layers, views } = setup();
		layers.sync();
		const host = views[0].div.querySelector(".pendf-layer-host")!;
		(layers as unknown as { detach(n: number): void }).detach(1);
		await flush();
		expect(host.isConnected).toBe(false);
		expect(layers.counters.restored).toBe(0);
	});
});
