// In-page test logic for scripts/webkit/smoke.mjs. Runs in Chromium and WebKit
// (Playwright), outside Obsidian. Exposes window.__tests.
(() => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const waitFor = async (fn, ms = 20000, step = 50) => {
		const t0 = performance.now();
		for (;;) {
			const v = await fn();
			if (v) return v;
			if (performance.now() - t0 > ms) throw new Error("timeout waiting for " + fn.toString().slice(0, 120));
			await sleep(step);
		}
	};

	const errors = [];
	window.addEventListener("unhandledrejection", (e) => errors.push("unhandledrejection: " + String(e.reason?.stack || e.reason).slice(0, 300)));
	window.addEventListener("error", (e) => errors.push("error: " + String(e.error?.stack || e.message).slice(0, 300)));

	// ------------------------------------------------------------ built-ins
	const BUILTINS = [
		"Object", "Function", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "Math", "JSON", "Reflect", "Promise",
		"Map", "Set", "WeakMap", "WeakSet", "WeakRef", "Date", "RegExp", "Error", "TypeError", "AggregateError", "ArrayBuffer",
		"DataView", "Uint8Array", "Uint8ClampedArray", "Int32Array", "Float32Array", "Float64Array", "URL", "URLSearchParams",
		"TextEncoder", "TextDecoder", "Intl", "Iterator", "ReadableStream", "Blob", "Response", "Worker",
	];
	const holders = () => {
		const out = { globalThis };
		for (const n of BUILTINS) {
			const v = globalThis[n];
			if (v == null) continue;
			out[n] = v;
			if (typeof v === "function" && v.prototype) out[n + ".prototype"] = v.prototype;
		}
		const ta = Object.getPrototypeOf(Uint8Array);
		out["TypedArray"] = ta;
		out["TypedArray.prototype"] = ta.prototype;
		const iterProto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
		out["%IteratorPrototype%"] = iterProto;
		return out;
	};
	let snap = null;
	function snapshot() {
		snap = new Map();
		for (const [name, obj] of Object.entries(holders())) {
			const m = new Map();
			for (const k of Reflect.ownKeys(obj)) {
				const d = Object.getOwnPropertyDescriptor(obj, k);
				m.set(k, d && ("value" in d ? d.value : d.get));
			}
			snap.set(name, m);
		}
	}
	function diff(ignoreGlobals = []) {
		const added = [];
		const replaced = [];
		const removed = [];
		for (const [name, obj] of Object.entries(holders())) {
			const before = snap.get(name);
			if (!before) continue;
			const now = new Set(Reflect.ownKeys(obj));
			for (const k of now) {
				if (name === "globalThis" && ignoreGlobals.includes(String(k))) continue;
				const d = Object.getOwnPropertyDescriptor(obj, k);
				const v = d && ("value" in d ? d.value : d.get);
				if (!before.has(k)) added.push(`${name}.${String(k)}`);
				else if (before.get(k) !== v && typeof v === "function") replaced.push(`${name}.${String(k)}`);
			}
			for (const k of before.keys()) if (!now.has(k)) removed.push(`${name}.${String(k)}`);
		}
		return { added, replaced, removed };
	}

	// ------------------------------------------------------------- helpers
	const pdfUrl = (name) => (name.startsWith("/") ? name : "/fixtures/out/" + name);
	const fetchPdf = async (name) => new Uint8Array(await (await fetch(pdfUrl(name))).arrayBuffer()).buffer;

	function textRange(root, text) {
		const nodes = [];
		const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let acc = "";
		for (let t = tw.nextNode(); t; t = tw.nextNode()) {
			nodes.push([t, acc.length]);
			acc += t.data;
		}
		const i = acc.indexOf(text);
		if (i < 0) return null;
		const j = i + text.length;
		const at = (pos, isEnd) => {
			for (let k = nodes.length - 1; k >= 0; k--) {
				const [t, off] = nodes[k];
				if (isEnd ? off < pos : off <= pos) return [t, pos - off];
			}
			return null;
		};
		const [sn, so] = at(i, false);
		const [en, eo] = at(j, true);
		const r = document.createRange();
		r.setStart(sn, so);
		r.setEnd(en, eo);
		return r;
	}

	/** penDF viewer on a document in .pendf-container. */
	async function penViewer(name) {
		const E = window.__pendf;
		const container = document.querySelector(".pendf-container");
		const viewerEl = container.querySelector(".pdfViewer");
		viewerEl.replaceChildren();
		const eventBus = new E.EventBus();
		const linkService = new E.PDFLinkService({ eventBus });
		const findController = new E.PDFFindController({ eventBus, linkService });
		const viewer = new E.PDFViewer({ container, viewer: viewerEl, eventBus, linkService, findController, textLayerMode: 1, annotationMode: E.AnnotationMode.ENABLE, removePageBorders: false });
		linkService.setViewer(viewer);
		const opened = await E.openDocument(await fetchPdf(name));
		const init = new Promise((r) => eventBus.on("pagesinit", r, { once: true }));
		viewer.setDocument(opened.doc);
		linkService.setDocument(opened.doc, null);
		await init;
		viewer.currentScaleValue = "page-width";
		return { viewer, eventBus, opened, container };
	}

	async function showPage(v, n) {
		v.viewer.currentPageNumber = n;
		const pv = v.viewer.getPageView(n - 1);
		await waitFor(() => pv.renderingState === 3 && pv.textLayer?.div?.querySelector("span"), 20000);
		await sleep(150);
		return pv;
	}

	/** The same math as HighlightController.createFromSelection: selection → per-page line rects → PDF quads. */
	function quadsForRange(v, range) {
		const E = window.__pendf;
		const pieces = E.piecesFromRange(range, v.container);
		const out = [];
		for (const piece of pieces) {
			const pv = v.viewer.getPageView(piece.pageNumber - 1);
			const geom = E.geometryOf(pv.viewport);
			const pageRect = E.pageContentRect(piece.pageDiv);
			const viewRects = piece.rects.map((r) => geom.clientRectToView(r, pageRect));
			for (const r of E.mergeLineRects(viewRects)) out.push({ page: piece.pageNumber, quad: geom.viewRectToQuad(r) });
		}
		return out;
	}

	async function groundTruth(v, file, expected) {
		const rows = [];
		for (const e of expected[file] ?? []) {
			const pv = await showPage(v, e.page);
			const range = await waitFor(() => textRange(pv.textLayer.div, e.text), 10000);
			const quads = quadsForRange(v, range);
			const span = range.startContainer.parentElement;
			const cs = getComputedStyle(span);
			const geom = window.__pendf.geometryOf(pv.viewport);
			const pr = window.__pendf.pageContentRect(pv.div);
			const ptPerPx = geom.width / pr.width;
			const rr = range.getBoundingClientRect();
			const sr = span.getBoundingClientRect();
			const debug = { transform: cs.transform, font: cs.fontFamily + " " + cs.fontSize, spanText: span.textContent.slice(0, 80), rangeWpt: +(rr.width * ptPerPx).toFixed(2), spanWpt: +(sr.width * ptPerPx).toFixed(2), expectedW: +e.width.toFixed(2), textLen: e.text.length, spanLen: span.textContent.length, endInSameSpan: range.endContainer.parentElement === span };
			let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
			for (const { quad } of quads) for (let i = 0; i < 8; i += 2) {
				minX = Math.min(minX, quad[i]); maxX = Math.max(maxX, quad[i]);
				minY = Math.min(minY, quad[i + 1]); maxY = Math.max(maxY, quad[i + 1]);
			}
			rows.push({
				file, page: e.page, quads: quads.length,
				dxStart: +(minX - e.x).toFixed(2), dxEnd: +(maxX - (e.x + e.width)).toFixed(2),
				topAboveBaseline: +((maxY - e.baseline) / e.size).toFixed(2), bottomBelowBaseline: +((e.baseline - minY) / e.size).toFixed(2),
				quadsRounded: quads.map((q) => q.quad.map((x) => Math.round(x * 100) / 100)),
				debug,
			});
		}
		return rows;
	}

	// ---------------------------------------------------------- core stand-in
	async function loadCore() {
		const css = document.createElement("link");
		css.rel = "stylesheet";
		css.href = "/node_modules/pdfjs-dist-core/web/pdf_viewer.css";
		document.head.append(css);
		await import("/node_modules/pdfjs-dist-core/build/pdf.mjs");
		await import("/node_modules/pdfjs-dist-core/web/pdf_viewer.mjs");
		globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc = "/node_modules/pdfjs-dist-core/build/pdf.worker.mjs";
		return { version: globalThis.pdfjsLib.version };
	}

	async function coreViewer(name, pages = [1]) {
		const lib = globalThis.pdfjsLib;
		const V = globalThis.pdfjsViewer;
		const container = document.getElementById("core-container");
		const viewerEl = document.getElementById("core-viewer");
		const eventBus = new V.EventBus();
		const linkService = new V.PDFLinkService({ eventBus });
		const viewer = new V.PDFViewer({ container, viewer: viewerEl, eventBus, linkService, textLayerMode: 1 });
		linkService.setViewer(viewer);
		const doc = await lib.getDocument({ url: pdfUrl(name), cMapUrl: "/node_modules/pdfjs-dist-core/cmaps/", cMapPacked: true, standardFontDataUrl: "/node_modules/pdfjs-dist-core/standard_fonts/" }).promise;
		const init = new Promise((r) => eventBus.on("pagesinit", r, { once: true }));
		viewer.setDocument(doc);
		linkService.setDocument(doc, null);
		await init;
		viewer.currentScaleValue = "page-width";
		for (const n of pages) {
			viewer.currentPageNumber = n;
			const pv = viewer.getPageView(n - 1);
			await waitFor(() => pv.renderingState === 3 && pv.textLayer?.div?.querySelector("span"), 20000);
		}
		await sleep(200);
		return { docId: doc._transport?.loadingTask?.docId ?? doc.loadingTask?.docId ?? null };
	}

	// ------------------------------------------------------------ namespace
	const fontFamilies = () => [...document.fonts].map((f) => f.family.replace(/^["']|["']$/g, ""));
	const idsWith = (prefix) => [...document.querySelectorAll("[id]")].map((e) => e.id).filter((id) => id.startsWith(prefix));
	const rootVar = () => document.documentElement.style.getPropertyValue("--viewer-container-height");

	// ---------------------------------------------------------------- tests
	async function smoke(cfg) {
		const E = window.__pendf;
		const res = { pdfjs: E.pdfjsVersion, fixtures: {}, viewer: {}, errors: null };
		for (const name of cfg.fixtures) {
			const t0 = performance.now();
			const opened = await E.openDocument(await fetchPdf(name));
			const doc = opened.doc;
			let rendered = 0;
			let textItems = 0;
			const canvas = document.createElement("canvas");
			for (let n = 1; n <= doc.numPages; n++) {
				const page = await doc.getPage(n);
				const vp = page.getViewport({ scale: 0.25 });
				canvas.width = Math.ceil(vp.width);
				canvas.height = Math.ceil(vp.height);
				await page.render({ canvas, viewport: vp }).promise;
				rendered++;
				textItems += (await page.getTextContent()).items.length;
				page.cleanup();
			}
			canvas.width = canvas.height = 0;
			res.fixtures[name] = { pages: doc.numPages, rendered, textItems, ms: Math.round(performance.now() - t0) };
			await opened.close();
		}
		res.workerMode = E.workerMode();
		// viewer: text layer + search + ground-truth quads
		const v = await penViewer("two-column.pdf");
		const pv = await showPage(v, 1);
		res.viewer.textLayerSpans = pv.textLayer.div.querySelectorAll("span").length;
		const count = new Promise((r) => v.eventBus.on("updatefindmatchescount", (e) => e.matchesCount.total > 0 && r(e.matchesCount.total)));
		v.eventBus.dispatch("find", { source: null, type: "", query: "spectra", caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: false, matchDiacritics: false });
		res.viewer.searchMatches = await Promise.race([count, sleep(10000).then(() => 0)]);
		await v.opened.close();
		res.groundTruth = [];
		for (const file of ["rotations.pdf", "cropbox.pdf"]) {
			const g = await penViewer(file);
			res.groundTruth.push(...(await groundTruth(g, file, cfg.expected)));
			await g.opened.close();
		}
		return res;
	}

	/** B-06: optionally open a PDF in the core stand-in first, then penDF; report name collisions and ground truth. */
	async function b06(cfg) {
		const res = { coreFirst: cfg.coreFirst, variant: cfg.variant };
		let coreFonts = [];
		if (cfg.coreFirst) {
			res.core = await loadCore();
			res.coreFile = cfg.coreFile ?? "a4.pdf";
			res.coreDoc = await coreViewer(res.coreFile);
			await document.fonts.ready;
			coreFonts = fontFamilies();
			res.rootVarAfterCore = rootVar();
		}
		const penFile = cfg.penFile ?? "rotations.pdf";
		res.penFile = penFile;
		const v = await penViewer(penFile);
		res.groundTruth = penFile === "rotations.pdf" ? await groundTruth(v, "rotations.pdf", cfg.expected) : [];
		// what penDF actually drew on page 1 (a collision would swap glyphs)
		const pv1 = await showPage(v, 1);
		await sleep(300);
		const cv = pv1.div.querySelector("canvas");
		if (cv) {
			const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
			let h = 0;
			let ink = 0;
			for (let i = 0; i < d.length; i += 4) {
				const g = (d[i] + d[i + 1] + d[i + 2]) | 0;
				if (g < 600) ink++;
				h = (h * 31 + g) >>> 0;
			}
			res.page1 = { w: cv.width, h: cv.height, ink, hash: h.toString(16) };
		}
		await document.fonts.ready;
		const all = fontFamilies();
		const penFonts = all.slice(coreFonts.length);
		res.fonts = { core: coreFonts, penDF: penFonts };
		res.fontCollisions = penFonts.filter((f) => coreFonts.includes(f));
		const ids = idsWith("g_");
		res.duplicateIds = ids.filter((id, i) => ids.indexOf(id) !== i);
		res.rootVarAfterPenDF = rootVar();
		res.containerVar = v.container.style.getPropertyValue("--viewer-container-height");
		return res;
	}

	window.__tests = { snapshot, diff, smoke, b06, errors: () => errors.slice() };
})();
