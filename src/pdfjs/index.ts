// The only module that touches pdf.js directly. Everything is imported from
// the bundled (build-time transformed) legacy build — never from Obsidian's
// copy (`loadPdfJs()` / `window.pdfjsLib`).
import {
	AnnotationEditorType,
	AnnotationMode,
	GlobalWorkerOptions,
	PDFWorker,
	TouchManager,
	VerbosityLevel,
	getDocument,
	version as pdfjsVersion,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
	EventBus,
	FindState,
	LinkTarget,
	PDFFindController,
	PDFLinkService,
	PDFViewer,
} from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
import { clearAssetCache, getAsset, getWorkerSource, type AssetKind } from "./assets";
import { logger } from "../util/log";

export {
	AnnotationEditorType,
	AnnotationMode,
	EventBus,
	FindState,
	LinkTarget,
	PDFFindController,
	PDFLinkService,
	PDFViewer,
	TouchManager,
	pdfjsVersion,
};
export type { PDFDocumentProxy };

const log = logger("pdfjs");
type PDFWorkerParams = ConstructorParameters<typeof PDFWorker>[0];

/**
 * Serves CMaps / standard fonts / wasm decoders from the embedded asset pack.
 * Shape-compatible with pdf.js's BinaryDataFactory (constructor options +
 * `fetch({kind, filename})`); passed as the `BinaryDataFactory` API option.
 */
class EmbeddedBinaryDataFactory {
	constructor(_opts: { cMapUrl?: string | null; standardFontDataUrl?: string | null; wasmUrl?: string | null }) {}
	async fetch({ kind, filename }: { kind: AssetKind; filename: string }): Promise<Uint8Array> {
		try {
			const data = await getAsset(kind, filename);
			// pdf.js may transfer the buffer to the worker; hand out a copy so the
			// cached bytes stay usable for the next document.
			return data.slice();
		} catch (e) {
			log.warn(`missing ${kind} asset ${filename}`, e);
			throw e;
		}
	}
}

// ---------------------------------------------------------------------------
// Worker: one shared web worker for all open PDF+++ views, created from a
// Blob URL holding the embedded worker module. Reference counted and torn down
// after a short idle period and on plugin unload.

export type WorkerMode = "web-worker" | "main-thread" | "none";

let workerUrl: string | null = null;
let webWorker: Worker | null = null;
let pdfWorker: PDFWorker | null = null;
let workerPromise: Promise<PDFWorker> | null = null;
let refCount = 0;
let idleTimer: number | null = null;
let mode: WorkerMode = "none";
const IDLE_MS = 60_000;

export function workerMode(): WorkerMode {
	return mode;
}

async function ensureWorkerUrl(): Promise<string> {
	if (!workerUrl) {
		const src = await getWorkerSource();
		workerUrl = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
	}
	return workerUrl;
}

/** Wait for the worker's "ready" handshake (or fail/timeout). */
function probeWorker(w: Worker, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = window.setTimeout(() => {
			cleanup();
			reject(new Error(`worker did not answer within ${timeoutMs} ms`));
		}, timeoutMs);
		const onMsg = (ev: MessageEvent) => {
			const d = ev.data as { action?: string } | null;
			if (d && d.action === "ready") {
				cleanup();
				resolve();
			}
		};
		const onErr = (ev: ErrorEvent) => {
			cleanup();
			reject(new Error(`worker error: ${ev.message || "unknown"}`));
		};
		const cleanup = () => {
			window.clearTimeout(timer);
			w.removeEventListener("message", onMsg);
			w.removeEventListener("error", onErr);
		};
		w.addEventListener("message", onMsg);
		w.addEventListener("error", onErr);
	});
}

async function createWorker(): Promise<PDFWorker> {
	const url = await ensureWorkerUrl();
	// Module-scoped option of *our* pdf.js copy (not a global).
	GlobalWorkerOptions.workerSrc = url;
	try {
		const w = new Worker(url, { type: "module", name: "pdf-ppp-worker" });
		await probeWorker(w, 15_000);
		webWorker = w;
		mode = "web-worker";
		log.info("web worker ready (blob URL, module)");
		return new PDFWorker({ port: w, name: "pdf-ppp" } as unknown as PDFWorkerParams);
	} catch (e) {
		log.warn("web worker unavailable, falling back to main-thread pdf.js", e);
		// pdf.js "fake worker": imports the same Blob URL on the main thread.
		const fw = new PDFWorker({ name: "pdf-ppp-fake" } as unknown as PDFWorkerParams);
		await fw.promise;
		mode = "main-thread";
		return fw;
	}
}

async function acquireWorker(): Promise<PDFWorker> {
	refCount++;
	if (idleTimer !== null) {
		window.clearTimeout(idleTimer);
		idleTimer = null;
	}
	if (!workerPromise) {
		workerPromise = createWorker().then((w) => (pdfWorker = w));
		workerPromise.catch(() => (workerPromise = null));
	}
	return workerPromise;
}

function releaseWorker(): void {
	refCount = Math.max(0, refCount - 1);
	if (refCount === 0 && idleTimer === null) {
		idleTimer = window.setTimeout(() => {
			idleTimer = null;
			if (refCount === 0) destroyWorker();
		}, IDLE_MS);
	}
}

/** Terminate the worker and free the Blob URL. Called on plugin unload. */
export function destroyWorker(): void {
	if (idleTimer !== null) window.clearTimeout(idleTimer);
	idleTimer = null;
	pdfWorker?.destroy();
	pdfWorker = null;
	webWorker?.terminate();
	webWorker = null;
	workerPromise = null;
	mode = "none";
	if (workerUrl) URL.revokeObjectURL(workerUrl);
	workerUrl = null;
	GlobalWorkerOptions.workerSrc = "";
	clearAssetCache();
}

export function workerStats(): { refCount: number; mode: WorkerMode; alive: boolean } {
	return { refCount, mode, alive: !!pdfWorker };
}

// ---------------------------------------------------------------------------

export interface OpenedDocument {
	doc: PDFDocumentProxy;
	fingerprint: string;
	close(): Promise<void>;
}

export async function openDocument(data: ArrayBuffer, password?: string): Promise<OpenedDocument> {
	const worker = await acquireWorker();
	let task: PDFDocumentLoadingTask | null = null;
	try {
		task = getDocument({
			data: new Uint8Array(data),
			password,
			worker,
			// Assets come from main.js through the factory below.
			useWorkerFetch: false,
			cMapUrl: "embedded://cmaps/",
			cMapPacked: true,
			standardFontDataUrl: "embedded://standard_fonts/",
			wasmUrl: "embedded://wasm/",
			BinaryDataFactory: EmbeddedBinaryDataFactory,
			isEvalSupported: false,
			enableXfa: false,
			verbosity: VerbosityLevel.ERRORS,
		} as Parameters<typeof getDocument>[0]);
		const doc = await task.promise;
		const fingerprint = doc.fingerprints[0] ?? "";
		let closed = false;
		const t = task;
		return {
			doc,
			fingerprint,
			async close() {
				if (closed) return;
				closed = true;
				try {
					await t.destroy();
				} finally {
					releaseWorker();
				}
			},
		};
	} catch (e) {
		try {
			await task?.destroy();
		} finally {
			releaseWorker();
		}
		throw e;
	}
}
