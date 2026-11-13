// Bundled by scripts/obsidian-harness.mjs with the same transforms as main.js
// and evaluated inside a fresh <iframe> realm: renders PDFs with the modern,
// ponyfilled pdf.js (real worker and main-thread fallback) so the harness can
// diff every built-in of that realm before/after. Dev-only.
import { getDocument, PDFWorker, GlobalWorkerOptions } from "pdfjs-dist";

class NoAssets {
	constructor() {}
	async fetch({ kind, filename }) {
		throw new Error(`probe: no ${kind} ${filename}`);
	}
}

async function renderAll(pdfBytes, worker) {
	const task = getDocument({ data: pdfBytes.slice(), worker, useWorkerFetch: false, BinaryDataFactory: NoAssets, isEvalSupported: false, verbosity: 0 });
	const doc = await task.promise;
	const out = { pages: doc.numPages, fingerprint: doc.fingerprints[0], text: 0, ops: 0, rendered: 0 };
	for (let n = 1; n <= Math.min(doc.numPages, 3); n++) {
		const page = await doc.getPage(n);
		const tc = await page.getTextContent();
		out.text += tc.items.length;
		const ol = await page.getOperatorList();
		out.ops += ol.fnArray.length;
		const vp = page.getViewport({ scale: 1 });
		const canvas = document.createElement("canvas");
		canvas.width = Math.ceil(vp.width);
		canvas.height = Math.ceil(vp.height);
		await page.render({ canvas, viewport: vp }).promise;
		out.rendered++;
	}
	await task.destroy();
	return out;
}

globalThis.__pppProbe = async function (files, workerSource, mode) {
	const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
	const results = {};
	try {
		let worker;
		let raw = null;
		if (mode === "web-worker") {
			raw = new Worker(url, { type: "module" });
			worker = new PDFWorker({ port: raw });
		} else {
			// main-thread ("fake worker"): pdf.js imports the worker module here
			GlobalWorkerOptions.workerSrc = url;
			const saved = globalThis.Worker;
			globalThis.Worker = undefined;
			try {
				worker = new PDFWorker();
				await worker.promise;
			} finally {
				globalThis.Worker = saved;
			}
		}
		for (const [name, bytes] of Object.entries(files)) results[name] = await renderAll(bytes, worker);
		worker.destroy();
		raw?.terminate();
	} finally {
		URL.revokeObjectURL(url);
	}
	return results;
};
