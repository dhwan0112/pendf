// Runs INSIDE Obsidian (page context) via scripts/obsidian-harness.mjs.
// Evaluates to { start(cfg) }. Results land in window.__pendfH.result.
// Dev-only: uses app.plugins to reload the plugin under test.
({
	start(cfg) {
		const H = (window.__pendfH = { done: false, step: "setup", result: null, error: null });
		const FIX = "pendf-fixtures/";
		const ID = "pendf";
		const VIEW = "pendf-view";
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		const waitFor = async (fn, ms = 15000, step = 60) => {
			const t0 = Date.now();
			let last;
			for (;;) {
				try {
					last = await fn();
					if (last) return last;
				} catch (e) {
					last = e;
				}
				if (Date.now() - t0 > ms) throw new Error("timeout waiting for " + (fn.name || fn.toString().slice(0, 120)));
				await sleep(step);
			}
		};

		// ------------------------------------------------------------ shims
		const orig = {
			raf: window.requestAnimationFrame,
			caf: window.cancelAnimationFrame,
			open: window.open,
			Worker: window.Worker,
		};
		const leavesBefore = new Set();
		app.workspace.iterateAllLeaves((l) => leavesBefore.add(l));
		const activeBefore = app.workspace.getMostRecentLeaf();
		// sidebars as the user left them: collapsed or open, and which tab is in front
		const sideOf = (split) => {
			let front = null;
			app.workspace.iterateAllLeaves((l) => {
				if (l.getRoot() === split && l.containerEl.isShown()) front = l;
			});
			return { collapsed: split.collapsed, front };
		};
		const sidesBefore = { left: sideOf(app.workspace.leftSplit), right: sideOf(app.workspace.rightSplit) };
		const workers = [];
		const opened = [];
		const createdPaths = new Set();
		class TrackedWorker extends orig.Worker {
			constructor(url, opts) {
				super(url, opts);
				const rec = { url: String(url), name: opts?.name ?? null, terminated: false };
				workers.push(rec);
				const t = this.terminate.bind(this);
				this.terminate = () => {
					rec.terminated = true;
					t();
				};
			}
		}
		window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
		window.cancelAnimationFrame = (id) => clearTimeout(id);
		window.Worker = TrackedWorker;
		window.open = (u) => {
			opened.push(String(u));
			return null;
		};
		// A hidden/occluded window also gets no `scroll` events (they are
		// dispatched in the rendering step, like rAF). Emulate the browser:
		// fire one whenever a viewer container's scroll position changed.
		const scrollPos = new WeakMap();
		// Hidden for >5 min, Chromium also throttles chained timers to 1/min.
		// Lift Electron's background throttling for the run (restored below).
		let webContents = null;
		let throttlingBefore = true;
		try {
			webContents = require("@electron/remote").getCurrentWebContents();
			throttlingBefore = webContents.getBackgroundThrottling ? webContents.getBackgroundThrottling() : true;
			webContents.setBackgroundThrottling(false);
		} catch (e) {
			console.warn("harness: cannot lift background throttling", e);
		}
		const scrollPump = setInterval(() => {
			for (const c of document.querySelectorAll(".pendf-container")) {
				const pos = c.scrollTop + "," + c.scrollLeft;
				if (scrollPos.get(c) !== pos) {
					scrollPos.set(c, pos);
					c.dispatchEvent(new Event("scroll"));
				}
			}
		}, 40);
		let tornDown = false;
		H.teardown = () => {
			if (tornDown) return;
			tornDown = true;
			clearInterval(scrollPump);
			try {
				webContents?.setBackgroundThrottling(throttlingBefore);
			} catch (e) {
				console.error(e);
			}
			try {
				app.workspace.iterateAllLeaves((l) => {
					if (!leavesBefore.has(l)) l.detach();
				});
				// put the sidebars back: the same tab in front, collapsed or open as before
				for (const [split, before] of [[app.workspace.leftSplit, sidesBefore.left], [app.workspace.rightSplit, sidesBefore.right]]) {
					if (before.front && before.front.parent) before.front.parent.selectTab?.(before.front);
					if (before.collapsed) split.collapse();
					else split.expand();
				}
				if (activeBefore && activeBefore.parent) app.workspace.setActiveLeaf(activeBefore, { focus: false });
			} catch (e) {
				console.error(e);
			}
			window.requestAnimationFrame = orig.raf;
			window.cancelAnimationFrame = orig.caf;
			window.open = orig.open;
			window.Worker = orig.Worker;
			(async () => {
				await app.plugins.disablePlugin(ID).catch(() => {});
				// the plugin's unload flushes pending settings asynchronously; let it land before deleting data.json
				await new Promise((r) => setTimeout(r, 1500));
				const ad = app.vault.adapter;
				const dataJson = app.vault.configDir + "/plugins/" + ID + "/data.json";
				if (await ad.exists(dataJson)) await ad.remove(dataJson);
				for (const p of createdPaths) if (await ad.exists(p)) await ad.remove(p);
				const listing = await ad.list(FIX).catch(() => ({ files: [] }));
				for (const f of listing.files) if (/\.pendf\.json(\.tmp)?$/.test(f) || /-renamed\.pdf$/.test(f)) await ad.remove(f);
			})().catch((e) => console.error(e));
		};

		// --------------------------------------------------------- helpers
		const P = () => app.plugins.plugins[ID];
		const file = (n) => app.vault.getAbstractFileByPath(FIX + n);
		const reloadPlugin = async () => {
			await app.plugins.disablePlugin(ID);
			await app.plugins.loadManifests();
			await app.plugins.enablePlugin(ID);
			await waitFor(() => P() && !!app.viewRegistry?.viewByType?.[VIEW]);
		};
		const closeOurs = () => {
			app.workspace.iterateAllLeaves((l) => {
				if (!leavesBefore.has(l)) l.detach();
			});
		};
		const pageView = (v, n) => v.debugSession.viewer.getPageView(n - 1);
		const waitRendered = (v, n) => waitFor(() => pageView(v, n)?.renderingState === 3 && pageView(v, n).div.querySelector("canvas"), 20000);
		const waitText = (v, n) => waitFor(() => pageView(v, n)?.textLayer?.div?.querySelector("span"), 20000);
		const openPenDF = async (name, state = {}) => {
			const leaf = app.workspace.getLeaf("tab");
			// Right after the plugin is (re-)enabled, Obsidian may still be re-creating its views and
			// can leave this leaf empty (D-37): open again if the leaf did not keep our view type.
			for (let attempt = 0; attempt < 3; attempt++) {
				await leaf.setViewState({ type: VIEW, state: { file: FIX + name, ...state }, active: true });
				// a slow PDF may take longer than this to get a session: only an emptied leaf is retried
				await waitFor(() => leaf.view.getViewType() !== VIEW || leaf.view.debugSession, 3000).catch(() => null);
				if (leaf.view.getViewType() === VIEW) break;
				await sleep(500);
			}
			const v = leaf.view;
			await waitFor(() => v.debugSession && v.debugSession.ready && v.debugSession.store, 20000);
			await waitRendered(v, v.debugSession.viewer.currentPageNumber);
			return { leaf, v };
		};
		const goPage = async (v, n) => {
			v.goToPage(n);
			await waitRendered(v, n);
			await waitText(v, n);
		};
		const spans = (v, n) => [...pageView(v, n).textLayer.div.querySelectorAll("span")].filter((s) => s.firstChild && s.firstChild.nodeType === 3);
		const findSpan = (v, n, prefix) => spans(v, n).find((s) => s.textContent.startsWith(prefix));
		const select = (a, aOff, b, bOff) => {
			const r = document.createRange();
			r.setStart(a.firstChild, aOff);
			r.setEnd(b.firstChild, bOff ?? b.firstChild.data.length);
			const sel = getSelection();
			sel.removeAllRanges();
			sel.addRange(r);
			return r;
		};
		const store = (v) => v.debugSession.store;
		const hlById = (v, id) => store(v).get(id);
		const quadBBox = (quads) => {
			let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			for (const q of quads) for (let i = 0; i < 8; i += 2) {
				minX = Math.min(minX, q[i]); maxX = Math.max(maxX, q[i]);
				minY = Math.min(minY, q[i + 1]); maxY = Math.max(maxY, q[i + 1]);
			}
			return { minX, minY, maxX, maxY };
		};
		/** dxStart/dxEnd of a highlight made from each ground-truth line (B-06 scenarios). */
		const groundTruthRows = async (files = ["rotations.pdf", "cropbox.pdf"]) => {
			const rows = [];
			for (const fname of files) {
				const { v, leaf } = await openPenDF(fname);
				for (const e of cfg.expected[fname] ?? []) {
					await goPage(v, e.page);
					const range = await waitFor(() => textRange(v, e.page, e.text));
					selectRange(range);
					const ids = v.highlights.createFromSelection("#ff0000");
					const a = hlById(v, ids[0]);
					const bb = quadBBox(a.quads);
					rows.push({ file: fname, page: e.page, quads: a.quads.length, dxStart: +(bb.minX - e.x).toFixed(2), dxEnd: +(bb.maxX - (e.x + e.width)).toFixed(2) });
					v.debugSession.store.remove(a.id);
				}
				await v.debugSession.store.flush();
				leaf.detach();
			}
			return { rows, ok: rows.length > 0 && rows.every((r) => r.quads === 1 && Math.abs(r.dxStart) < 2.5 && Math.abs(r.dxEnd) < 3), maxAbsDxEnd: Math.max(...rows.map((r) => Math.abs(r.dxEnd))) };
		};
		/** A note that embeds a PDF, shown in reading view (Obsidian's own PDF embed renders it). */
		const openEmbedNote = async (pdf) => {
			const path = FIX + "pendf-embed-" + pdf.replace(/\.pdf$/, "") + ".md";
			createdPaths.add(path);
			if (!app.vault.getAbstractFileByPath(path)) await app.vault.create(path, `# embed\n\n![[${pdf}]]\n`);
			const leaf = app.workspace.getLeaf("split", "vertical");
			await leaf.setViewState({ type: "markdown", state: { file: path, mode: "preview" }, active: false });
			const canvas = await waitFor(() => leaf.view.containerEl.querySelector(".internal-embed canvas, .pdf-embed canvas"), 20000);
			await sleep(800);
			return { leaf, rendered: !!canvas };
		};
		const polyClientRect = (v, id) => {
			const els = v.containerEl.querySelectorAll(`.pendf-hl[data-id="${id}"] polygon`);
			if (!els.length) return null;
			let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
			for (const e of els) {
				const x = e.getBoundingClientRect();
				l = Math.min(l, x.left); t = Math.min(t, x.top); r = Math.max(r, x.right); b = Math.max(b, x.bottom);
			}
			return { left: l, top: t, right: r, bottom: b };
		};
		const iou = (a, b) => {
			const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
			const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
			const inter = ix * iy;
			const area = (r) => (r.right - r.left) * (r.bottom - r.top);
			return inter / (area(a) + area(b) - inter);
		};
		const spanRect = (s) => {
			const r = document.createRange();
			r.selectNodeContents(s);
			const x = r.getBoundingClientRect();
			return { left: x.left, top: x.top, right: x.right, bottom: x.bottom };
		};
		// select an exact string even when pdf.js split the line into several spans
		const textRange = (v, n, text) => {
			const root = pageView(v, n).textLayer.div;
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
		};
		const selectRange = (r) => {
			const sel = getSelection();
			sel.removeAllRanges();
			sel.addRange(r);
		};
		const rangeRect = (r) => {
			const x = r.getBoundingClientRect();
			return { left: x.left, top: x.top, right: x.right, bottom: x.bottom };
		};
		const waitIdle = async (v) => {
			await sleep(120);
			await waitFor(() => {
				const s = v.debugSession;
				for (let i = 0; i < s.viewer.pagesCount; i++) if (s.viewer.getPageView(i)?.renderingState === 1) return false;
				return true;
			}, 20000);
			await sleep(80);
		};

		const checks = {};
		const check = async (name, fn) => {
			if (cfg.only && !cfg.only.includes(name)) return;
			if (tornDown) return; // torn down from outside (timeout, Ctrl+C): run nothing more
			H.step = name;
			try {
				const d = (await Promise.race([fn(), sleep(150_000).then(() => Promise.reject(new Error("check timed out after 150 s")))])) || {};
				checks[name] = { ok: d.ok !== false, ...d };
			} catch (e) {
				checks[name] = { ok: false, error: String((e && e.stack) || e).slice(0, 800) };
			}
			closeOurs();
			getSelection().removeAllRanges();
			await sleep(100);
		};

		// --------------------------------------------------------- checks
		const run = async () => {
			const env = { obsidian: navigator.userAgent.match(/obsidian\/([\d.]+)/i)?.[1], chrome: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1], electron: process.versions.electron };
			const globalsBefore = { pdfjsLib: window.pdfjsLib, pdfjsLibVersion: window.pdfjsLib?.version, pdfjsWorker: window.pdfjsWorker, pdfjsViewer: window.pdfjsViewer };
			// clean slate: sidecars and the plugin's own settings (remembered positions)
			const ad = app.vault.adapter;
			const dataJson = app.vault.configDir + "/plugins/" + ID + "/data.json";
			// a fresh test vault starts in restricted mode (community plugins off)
			if (typeof app.plugins.isEnabled === "function" && !app.plugins.isEnabled()) await app.plugins.setEnable(true);
			await app.plugins.disablePlugin(ID);
			if (await ad.exists(dataJson)) await ad.remove(dataJson);
			for (const f of (await ad.list(FIX)).files) if (/\.pendf\.json(\.tmp)?$/.test(f)) await ad.remove(f);
			// the coexistence checks need Obsidian's own PDF viewer; "open-by-default" turns this on itself
			await ad.write(dataJson, JSON.stringify({ openPdfsInPenDF: false }));
			await reloadPlugin();

			await check("fixtures-render", async () => {
				const out = {};
				for (const name of ["a4.pdf", "letter.pdf", "rotations.pdf", "cropbox.pdf", "two-column.pdf", "korean-cmap.pdf", "korean-embedded.pdf", "links.pdf", "long-300.pdf"]) {
					const { v } = await openPenDF(name);
					await waitText(v, 1);
					const text = pageView(v, 1).textLayer.div.textContent;
					out[name] = { pages: v.debugSession.viewer.pagesCount, chars: text.length, sample: text.slice(0, 40) };
					closeOurs();
				}
				const korean = /한국어/.test(out["korean-cmap.pdf"].sample) && /한국어/.test(out["korean-embedded.pdf"].sample);
				const allText = Object.values(out).every((x) => x.chars > 10);
				return { ok: korean && allText && out["long-300.pdf"].pages === 300, out };
			});

			await check("search", async () => {
				const { v } = await openPenDF("a4.pdf");
				v.openSearch();
				v.searchInput.value = "spectra";
				v.searchInput.dispatchEvent(new Event("input"));
				const first = await waitFor(() => /^\d+ \/ \d+$/.test(v.searchCount.textContent) && v.searchCount.textContent);
				v.searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
				const second = await waitFor(() => v.searchCount.textContent !== first && v.searchCount.textContent);
				const highlighted = await waitFor(() => v.containerEl.querySelectorAll(".textLayer .highlight").length);
				v.searchInput.value = "zzzznotfound";
				v.searchInput.dispatchEvent(new Event("input"));
				const none = await waitFor(() => v.searchCount.textContent === "No matches" && "No matches");
				return { first, second, highlighted, none, ok: first.startsWith("1 / ") && second.startsWith("2 / ") };
			});

			await check("links", async () => {
				const { v } = await openPenDF("links.pdf");
				const s = v.debugSession;
				const anchors = await waitFor(() => {
					const a = [...pageView(v, 1).div.querySelectorAll(".annotationLayer a")];
					return a.length >= 3 && a;
				});
				const internal = anchors.find((a) => (a.getAttribute("href") || "").startsWith("#"));
				internal.click();
				const jumped = await waitFor(() => s.viewer.currentPageNumber !== 1 && s.viewer.currentPageNumber);
				v.goToPage(1);
				await waitRendered(v, 1);
				const ext = [...pageView(v, 1).div.querySelectorAll(".annotationLayer a")].find((a) => /^https?:/.test(a.getAttribute("href") || ""));
				ext.click();
				await sleep(200);
				closeOurs();
				const { v: v2 } = await openPenDF("long-300.pdf");
				// earlier checks may leave long-300.pdf remembered at another page (D-37)
				await goPage(v2, 1);
				const toc = await waitFor(() => {
					const a = [...pageView(v2, 1).div.querySelectorAll(".annotationLayer a")];
					return a.length >= 30 && a;
				});
				toc[9].click(); // chapter 10 → p. 92
				const tocJump = await waitFor(() => v2.debugSession.viewer.currentPageNumber !== 1 && v2.debugSession.viewer.currentPageNumber);
				return { jumped, external: opened.slice(), tocJump, ok: (jumped === 2 || jumped === 3) && opened.some((u) => u.startsWith("https://example.com")) && tocJump === 92 };
			});

			await check("open-by-default", async () => {
				const pl = P();
				const f = file("a4.pdf");
				const ws = app.workspace;
				pl.settings.openPdfsInPenDF = true;
				try {
					// 1. a plain open (file explorer, quick switcher) lands in penDF
					const logMark = pl.getLogText().length;
					const l1 = ws.getLeaf("tab");
					await l1.openFile(f, { active: true });
					await waitFor(() => l1.view.getViewType() === VIEW, 10000);
					await waitFor(() => l1.view.debugSession && l1.view.debugSession.ready, 10000);
					await sleep(1500);
					const logged = pl.getLogText().slice(logMark);
					var plainOpenCounts = { takeovers: (logged.match(/opening pendf-fixtures\/a4\.pdf in penDF/g) || []).length, loads: (logged.match(/opened pendf-fixtures\/a4\.pdf /g) || []).length };
					// 2. a link with a page lands in penDF on that page
					await ws.openLinkText(FIX + "a4.pdf#page=2", "", "tab");
					const l2 = ws.getMostRecentLeaf();
					await waitFor(() => l2.view.getViewType() === VIEW && l2.view.debugSession && l2.view.debugSession.ready, 20000);
					await waitFor(() => l2.view.debugSession.viewer.currentPageNumber === 2, 5000).catch(() => {});
					const linkPage = l2.view.debugSession.viewer.currentPageNumber;
					// 3. "Open in Obsidian's PDF viewer" stays in the core viewer
					await pl.openInCoreViewer(f);
					const l3 = ws.getMostRecentLeaf();
					await sleep(1000);
					const keptCore = l3.view.getViewType();
					// 4. with the setting off, Obsidian's viewer is used again
					pl.settings.openPdfsInPenDF = false;
					const l4 = ws.getLeaf("tab");
					await l4.openFile(f, { active: true });
					await sleep(1000);
					const offType = l4.view.getViewType();
					return {
						plainOpen: l1.view.getViewType(),
						plainOpenCounts,
						linkPage,
						keptCore,
						offType,
						// known limitation (D-23): Obsidian hands "#page=2" to the core viewer before the switch
						// finishes and the core viewer does not expose it, so linkPage is informational
						ok: l1.view.getViewType() === VIEW && l2.view.getViewType() === VIEW && keptCore === "pdf" && offType === "pdf",
					};
				} finally {
					pl.settings.openPdfsInPenDF = false;
				}
			});
			await check("state-restore", async () => {
				const { leaf, v } = await openPenDF("a4.pdf");
				v.debugSession.viewer.currentScaleValue = "1.5";
				v.goToPage(3);
				await sleep(1200); // > state save debounce
				const vs = leaf.getViewState();
				closeOurs();
				const leaf2 = app.workspace.getLeaf("tab");
				await leaf2.setViewState(vs);
				const v2 = leaf2.view;
				await waitFor(() => v2.debugSession && v2.debugSession.ready);
				await sleep(300);
				const restored = { page: v2.debugSession.viewer.currentPageNumber, scale: v2.debugSession.viewer.currentScale };
				closeOurs();
				// per-file memory without any leaf state
				const penBefore = new Set(app.workspace.getLeavesOfType(VIEW));
				await P().openPdf(file("a4.pdf"), true);
				// the tab just opened (the vault may already show penDF tabs of its own)
				const v3 = app.workspace.getLeavesOfType(VIEW).find((l) => !penBefore.has(l)).view;
				await waitFor(() => v3.debugSession && v3.debugSession.ready);
				await sleep(300);
				const remembered = { page: v3.debugSession.viewer.currentPageNumber, scale: v3.debugSession.viewer.currentScale };
				return { savedState: { page: vs.state.page, scale: vs.state.scale }, restored, remembered, ok: restored.page === 3 && Math.abs(restored.scale - 1.5) < 0.01 && remembered.page === 3 };
			});

			await check("coexistence-core-first", async () => {
				const f = file("a4.pdf");
				const core = app.workspace.getLeaf("split", "vertical");
				await core.openFile(f);
				await waitFor(() => core.view.getViewType() === "pdf" && window.pdfjsLib && core.view.containerEl.querySelector("canvas"), 20000);
				const lib = window.pdfjsLib;
				const ver = lib.version;
				const coreCanvasesBefore = core.view.containerEl.querySelectorAll("canvas").length;
				const { v } = await openPenDF("a4.pdf");
				v.zoom(1);
				await waitIdle(v);
				await sleep(500);
				const coreCanvasesAfter = core.view.containerEl.querySelectorAll("canvas").length;
				const pendfCanvases = v.containerEl.querySelectorAll("canvas").length;
				// core keeps working: scroll it and see it render more
				const sc = core.view.containerEl.querySelector(".pdf-viewer-container, .pdfViewer")?.closest("[class*=container]") || core.view.containerEl;
				return {
					coreVersion: ver,
					ourVersion: cfg.ourVersion,
					sameLib: window.pdfjsLib === lib,
					sameVersion: window.pdfjsLib.version === ver,
					pdfjsWorkerUnchanged: window.pdfjsWorker === globalsBefore.pdfjsWorker,
					// core defines window.pdfjsViewer itself when its viewer first loads
					pdfjsViewerBefore: typeof globalsBefore.pdfjsViewer,
					coreCanvasesBefore,
					coreCanvasesAfter,
					pendfCanvases,
					ok: window.pdfjsLib === lib && window.pdfjsLib.version === ver && coreCanvasesAfter > 0 && pendfCanvases > 0 && window.pdfjsWorker === globalsBefore.pdfjsWorker,
				};
			});

			await check("coexistence-pendf-first", async () => {
				const { v } = await openPenDF("letter.pdf");
				const libBefore = window.pdfjsLib;
				const core = app.workspace.getLeaf("split", "vertical");
				await core.openFile(file("letter.pdf"));
				await waitFor(() => core.view.getViewType() === "pdf" && core.view.containerEl.querySelector("canvas"), 20000);
				await app.workspace.revealLeaf(v.leaf);
				app.workspace.setActiveLeaf(v.leaf, { focus: false });
				await waitFor(() => v.debugSession.viewer.container.clientWidth > 0);
				v.zoom(1);
				await waitIdle(v);
				const cur = v.debugSession.viewer.currentPageNumber;
				const rerendered = await waitRendered(v, cur).then(() => true, () => false);
				const sv = v.debugSession.viewer;
				const diag = { cur, scale: sv.currentScale, states: [...Array(sv.pagesCount).keys()].map((i) => sv.getPageView(i).renderingState), canvases: v.containerEl.querySelectorAll("canvas").length, size: [sv.container.clientWidth, sv.container.clientHeight], visible: v.containerEl.isShown?.() };
				return {
					diag,
					coreVersion: window.pdfjsLib?.version,
					libUntouchedByUs: libBefore === undefined || libBefore === window.pdfjsLib,
					coreCanvases: core.view.containerEl.querySelectorAll("canvas").length,
					pendfStillRenders: rerendered,
					ok: window.pdfjsLib?.version !== undefined && core.view.containerEl.querySelectorAll("canvas").length > 0 && rerendered,
				};
			});

			await check("css-inward", async () => {
				const { v } = await openPenDF("a4.pdf");
				const curPage = v.debugSession.viewer.currentPageNumber; // may be a remembered page
				await waitText(v, curPage);
				const page = pageView(v, curPage).div;
				const targets = { page, textLayer: page.querySelector(".textLayer"), span: page.querySelector(".textLayer span"), canvasWrapper: page.querySelector(".canvasWrapper"), annotationLayer: page.querySelector(".annotationLayer") };
				const foreign = {};
				for (const sheet of document.styleSheets) {
					let rules;
					try {
						rules = sheet.cssRules;
					} catch {
						continue;
					}
					const text = [...rules].slice(0, 50).map((r) => r.cssText).join("");
					if (text.includes(".pendf-root")) continue; // ours
					const origin = sheet.href || (sheet.ownerNode && (sheet.ownerNode.id || sheet.ownerNode.className)) || "inline";
					const walk = (list) => {
						for (const r of list) {
							if (r.cssRules && !r.selectorText) walk(r.cssRules);
							if (!r.selectorText) continue;
							for (const [k, el] of Object.entries(targets)) {
								if (!el) continue;
								try {
									if (el.matches(r.selectorText) && !/^(:root|html|body)$/.test(r.selectorText)) (foreign[k] ??= []).push(`${r.selectorText.slice(0, 90)}  {${r.style.cssText.slice(0, 90)}}  @${String(origin).slice(-40)}`);
								} catch {}
							}
						}
					};
					walk(rules);
				}
				const cs = getComputedStyle(page);
				const boxSizing = Object.fromEntries(Object.entries(targets).filter(([, el]) => el).map(([k, el]) => [k, getComputedStyle(el).boxSizing]));
				const pr = page.getBoundingClientRect();
				const tr = targets.textLayer.getBoundingClientRect();
				const cr = targets.canvasWrapper.getBoundingClientRect();
				const aligned = Math.abs(tr.width - cr.width) < 1 && Math.abs(tr.left - cr.left) < 1 && Math.abs(tr.top - cr.top) < 1;
				const spanTransform = getComputedStyle(targets.span).transform;
				return { pageBorder: cs.borderLeftWidth + " " + cs.borderLeftStyle, boxSizing, sizes: { text: [tr.width, tr.height], canvas: [cr.width, cr.height], page: [pr.width, pr.height] }, aligned, spanTransform, foreign, ok: aligned && boxSizing.page === "content-box" && spanTransform !== "none" };
			});

			await check("highlight-ground-truth", async () => {
				const out = [];
				let ok = true;
				for (const [fname, list] of Object.entries(cfg.expected)) {
					const { v } = await openPenDF(fname);
					for (const e of list) {
						await goPage(v, e.page);
						const range = await waitFor(() => textRange(v, e.page, e.text));
						selectRange(range);
						const ids = v.highlights.createFromSelection("#ff0000");
						const a = hlById(v, ids[0]);
						const bb = quadBBox(a.quads);
						const res = {
							file: fname,
							page: e.page,
							quads: a.quads.length,
							dxStart: +(bb.minX - e.x).toFixed(2),
							dxEnd: +(bb.maxX - (e.x + e.width)).toFixed(2),
							// a text box spans roughly [baseline − descent, baseline + ascent]
							topAboveBaseline: +((bb.maxY - e.baseline) / e.size).toFixed(2),
							bottomBelowBaseline: +((e.baseline - bb.minY) / e.size).toFixed(2),
							heightRatio: +((bb.maxY - bb.minY) / e.size).toFixed(2),
						};
						res.ok = res.quads === 1 && Math.abs(res.dxStart) < 2.5 && Math.abs(res.dxEnd) < 3 && res.topAboveBaseline > 0.6 && res.topAboveBaseline < 1.3 && res.bottomBelowBaseline > -0.1 && res.bottomBelowBaseline < 0.45 && res.heightRatio > 0.8 && res.heightRatio < 1.6;
						// on-screen overlay agrees with the text at 3 zoom levels and 2 view rotations
						await waitFor(() => polyClientRect(v, a.id));
						const ious = [];
						for (const step of [null, { scale: 2.2 }, { rotate: 90 }, { scale: 0.8 }, { rotate: 270 }]) {
							if (step?.scale) v.debugSession.viewer.currentScaleValue = String(step.scale);
							if (step?.rotate) v.rotate(step.rotate);
							if (step) {
								await waitIdle(v);
								v.goToPage(e.page);
								await waitRendered(v, e.page);
								await waitText(v, e.page);
							}
							const r2 = await waitFor(() => textRange(v, e.page, e.text));
							const pr = await waitFor(() => polyClientRect(v, a.id));
							ious.push(+iou(pr, rangeRect(r2)).toFixed(2));
						}
						res.ious = ious;
						res.ok = res.ok && ious.every((x) => x > 0.6);
						ok = ok && res.ok;
						out.push(res);
						v.rotate(0 - v.debugSession.viewer.pagesRotation);
						v.debugSession.viewer.currentScaleValue = "page-width";
						await waitIdle(v);
					}
					await v.flush();
					closeOurs();
				}
				return { ok, out };
			});

			await check("shared-namespace", async () => {
				// B-06: names Obsidian's pdf.js and penDF's pdf.js put into the shared page
				const faces = () => [...document.fonts];
				const fam = (f) => f.family.replace(/^["']|["']$/g, "");
				const before = new Set(faces());
				const htmlVar = () => document.documentElement.style.getPropertyValue("--viewer-container-height");
				const core = app.workspace.getLeaf("split", "vertical");
				await core.openFile(file("a4.pdf"));
				await waitFor(() => core.view.getViewType() === "pdf" && core.view.containerEl.querySelector(".textLayer span"), 20000);
				await document.fonts.ready;
				const coreFaces = faces().filter((f) => !before.has(f));
				const afterCore = new Set(faces());
				const varAfterCore = htmlVar();
				const { v } = await openPenDF("rotations.pdf");
				await goPage(v, 1);
				await document.fonts.ready;
				const penFaces = faces().filter((f) => !afterCore.has(f));
				const coreNames = new Set(coreFaces.map(fam));
				const collisions = penFaces.map(fam).filter((n) => coreNames.has(n));
				const ids = [...document.querySelectorAll("[id^='g_']")].map((e) => e.id);
				const duplicateIds = ids.filter((id, i) => ids.indexOf(id) !== i);
				return {
					coreFonts: [...coreNames],
					penFonts: penFaces.map(fam),
					collisions,
					duplicateIds,
					penPrefixed: penFaces.length > 0 && penFaces.every((f) => /^g_pendf_d/.test(fam(f))),
					htmlVarAfterCore: varAfterCore,
					htmlVarAfterPenDF: htmlVar(),
					ok: collisions.length === 0 && duplicateIds.length === 0 && htmlVar() === varAfterCore && (penFaces.length === 0 || penFaces.every((f) => /^g_pendf_d/.test(fam(f)))),
				};
			});

			await check("ground-truth-after-core", async () => {
				// B-06 order: Obsidian's PDF viewer open first (and kept open), then penDF
				const core = app.workspace.getLeaf("split", "vertical");
				await core.openFile(file("a4.pdf"));
				await waitFor(() => core.view.getViewType() === "pdf" && core.view.containerEl.querySelector(".textLayer span"), 20000);
				return await groundTruthRows();
			});

			await check("ground-truth-after-embed", async () => {
				// a note embedding a different PDF (Obsidian's embed renderer) first, then penDF
				const emb = await openEmbedNote("a4.pdf");
				const r = await groundTruthRows();
				return { embedRendered: emb.rendered, ...r, ok: emb.rendered && r.ok };
			});

			await check("ground-truth-same-pdf-embed", async () => {
				// the same PDF in Obsidian's embed and in penDF at the same time
				const emb = await openEmbedNote("rotations.pdf");
				const r = await groundTruthRows(["rotations.pdf"]);
				return { embedRendered: emb.rendered, ...r, ok: emb.rendered && r.ok };
			});

			await check("highlight-multiline-columns", async () => {
				const { v } = await openPenDF("two-column.pdf");
				await waitText(v, 1);
				const sp = spans(v, 1);
				const i0 = sp.findIndex((s) => s.textContent.startsWith("[1.1.1]"));
				// first four lines of the left column's first paragraph
				select(sp[i0], 0, sp[i0 + 3]);
				const ids = v.highlights.createFromSelection("#2ea8e5");
				const a = hlById(v, ids[0]);
				const colW = (595.28 - 112 - 24) / 2;
				const bbs = a.quads.map((q) => quadBBox([q]));
				const inLeftColumn = bbs.every((b) => b.minX >= 54 && b.maxX <= 56 + colW + 3);
				// a selection that spans both columns must not produce full-width quads
				const j0 = sp.findIndex((s) => s.textContent.startsWith("[1.2.1]"));
				select(sp[j0 - 2], 0, sp[j0 + 1]);
				const ids2 = v.highlights.createFromSelection("#5fb236");
				const b = hlById(v, ids2[0]);
				const noBridge = b.quads.map((q) => quadBBox([q])).every((x) => x.maxX - x.minX <= colW + 3);
				return { lines: a.quads.length, inLeftColumn, crossColumnQuads: b.quads.length, noBridge, text: a.text.slice(0, 60), ok: a.quads.length === 4 && inLeftColumn && noBridge };
			});

			await check("highlight-korean", async () => {
				const res = {};
				for (const name of ["korean-embedded.pdf", "korean-cmap.pdf"]) {
					const { v } = await openPenDF(name);
					await waitText(v, 1);
					const sp = spans(v, 1).filter((s) => /[가-힣]/.test(s.textContent));
					const target = sp[Math.min(2, sp.length - 1)];
					select(target, 0, target);
					const ids = v.highlights.createFromSelection("#ffd400");
					const a = hlById(v, ids[0]);
					const pr = await waitFor(() => polyClientRect(v, a.id));
					res[name] = { text: a.text.slice(0, 30), quads: a.quads.length, iou: +iou(pr, spanRect(target)).toFixed(2) };
					closeOurs();
				}
				return { res, ok: Object.values(res).every((r) => /[가-힣]/.test(r.text) && r.quads === 1 && r.iou > 0.6) };
			});

			await check("highlight-cross-page", async () => {
				const { v } = await openPenDF("a4.pdf");
				v.debugSession.viewer.currentScaleValue = "0.5";
				await waitIdle(v);
				await waitText(v, 1);
				await waitText(v, 2);
				const s1 = spans(v, 1);
				const s2 = spans(v, 2);
				select(s1[s1.length - 2], 0, s2[1]);
				const ids = v.highlights.createFromSelection("#ff6680");
				const list = ids.map((id) => hlById(v, id));
				return { pages: list.map((a) => a.page), groups: [...new Set(list.map((a) => a.groupId))], ok: list.length === 2 && list[0].page === 1 && list[1].page === 2 && list[0].groupId && list[0].groupId === list[1].groupId };
			});

			await check("smoke-ui", async () => {
				const r = {};
				const p = P();
				// engine check must not raise a false alarm on this engine
				r.engine = p.engine;
				const { v } = await openPenDF("a4.pdf");
				r.errorBanner = !!v.containerEl.querySelector(".pendf-banner.is-error:not(.is-hidden)");
				// HUD via settings
				p.settings.debugHud = true;
				await p.saveSettings();
				const hud = await waitFor(() => v.containerEl.querySelector(".pendf-hud")?.textContent.includes("rendered") && v.containerEl.querySelector(".pendf-hud").textContent, 5000);
				r.hud = hud.split("\n").slice(0, 4).join(" | ");
				p.settings.debugHud = false;
				await p.saveSettings();
				r.hudGone = !v.containerEl.querySelector(".pendf-hud");
				// commands (by id) on the active view
				const run = (id) => app.commands.executeCommandById(`pendf:${id}`);
				r.commands = {};
				for (const id of ["find", "zoom-in", "zoom-out", "fit-width", "undo", "redo"]) r.commands[id] = run(id);
				r.searchOpened = !v.searchBar.hasClass("is-hidden");
				await waitIdle(v); // zoom commands re-render text layers
				await sleep(500);
				await waitIdle(v);
				await waitText(v, v.debugSession.viewer.currentPageNumber);
				const sp = spans(v, v.debugSession.viewer.currentPageNumber);
				select(sp[1], 0, sp[1]);
				const n0 = store(v).all().length;
				r.commands["highlight-selection"] = run("highlight-selection");
				r.highlightByCommand = store(v).all().length === n0 + 1;
				const logsBefore = app.vault.getFiles().filter((f) => f.name.startsWith("pendf-log-")).length;
				r.commands["export-log"] = run("export-log");
				const logFile = await waitFor(() => app.vault.getFiles().find((f) => f.name.startsWith("pendf-log-")), 5000);
				r.logExported = app.vault.getFiles().filter((f) => f.name.startsWith("pendf-log-")).length === logsBefore + 1;
				r.logHasEngine = (await app.vault.read(logFile)).includes("engine:");
				createdPaths.add(logFile.path);
				// open-current-pdf from the core viewer
				closeOurs();
				const core = app.workspace.getLeaf("tab");
				await core.openFile(file("letter.pdf"));
				await waitFor(() => app.workspace.getActiveFile()?.path === FIX + "letter.pdf");
				r.commands["open-current-pdf"] = run("open-current-pdf");
				r.openCurrentWorked = !!(await waitFor(() => app.workspace.getLeavesOfType(VIEW).find((l) => l.view.file?.name === "letter.pdf"), 5000));
				closeOurs();
				// open-pdf modal
				r.commands["open-pdf"] = run("open-pdf");
				const modal = await waitFor(() => document.querySelector(".modal-container .prompt"), 3000);
				r.modalShown = !!modal;
				document.querySelector(".modal-container")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
				document.querySelectorAll(".modal-container").forEach((m) => m.remove());
				// pen probe: command gated by the setting
				run("open-pen-probe");
				await sleep(400);
				r.probeCommandHidden = app.workspace.getLeavesOfType("pendf-pen-probe").length === 0;
				p.settings.penProbe = true;
				await p.saveSettings();
				r.commands["open-pen-probe"] = run("open-pen-probe");
				const probe = await waitFor(() => app.workspace.getLeavesOfType("pendf-pen-probe")[0]?.view, 5000);
				const pad = probe.containerEl.querySelector(".pendf-probe-pad");
				const box = pad.getBoundingClientRect();
				const ev = (type, i) => new PointerEvent(type, { pointerId: 7, pointerType: "pen", pressure: 0.3 + i * 0.05, clientX: box.left + 20.5 + i * 7, clientY: box.top + 30.25 + i * 3, bubbles: true, cancelable: true });
				pad.dispatchEvent(ev("pointerdown", 0));
				for (let i = 1; i <= 8; i++) pad.dispatchEvent(ev("pointermove", i));
				pad.dispatchEvent(ev("pointerup", 9));
				const summary = JSON.parse(probe.containerEl.querySelector(".pendf-probe-out").textContent);
				r.probe = { penEvents: summary.types.pen?.events, fractional: summary.types.pen?.fractionalCoordinateShare, coalesced: summary.types.pen?.getCoalescedEvents };
				const probeFilesBefore = app.vault.getFiles().filter((f) => f.name.startsWith("pendf-pen-probe-")).length;
				[...probe.containerEl.querySelectorAll("button")].find((b) => b.textContent === "Export JSON").click();
				const probeFile = await waitFor(() => app.vault.getFiles().filter((f) => f.name.startsWith("pendf-pen-probe-")).length > probeFilesBefore && app.vault.getFiles().find((f) => f.name.startsWith("pendf-pen-probe-")), 5000);
				createdPaths.add(probeFile.path);
				r.probeExported = JSON.parse(await app.vault.read(probeFile)).types.pen.events === summary.types.pen.events;
				p.settings.penProbe = false;
				await p.saveSettings();
				closeOurs();
				// file menu entry
				const items = [];
				const fakeMenu = {
					addItem(cb) {
						const it = { title: "", setTitle(t) { this.title = t; return this; }, setIcon() { return this; }, setSection() { return this; }, onClick(f) { this.click = f; return this; } };
						cb(it);
						items.push(it);
						return this;
					},
				};
				app.workspace.trigger("file-menu", fakeMenu, file("cropbox.pdf"), "file-explorer");
				const ours = items.find((i) => i.title === "Open in penDF");
				r.fileMenu = !!ours;
				ours?.click();
				r.fileMenuOpens = !!(await waitFor(() => app.workspace.getLeavesOfType(VIEW).find((l) => l.view.file?.name === "cropbox.pdf"), 5000));
				const mdItems = [];
				app.workspace.trigger("file-menu", { addItem(cb) { const it = { title: "", setTitle(t) { this.title = t; return this; }, setIcon() { return this; }, setSection() { return this; }, onClick() { return this; } }; cb(it); mdItems.push(it); return this; } }, app.vault.getMarkdownFiles()[0], "file-explorer");
				r.noMenuForMarkdown = !mdItems.some((i) => i.title === "Open in penDF");
				closeOurs();
				// settings tab renders
				const tab = app.setting?.pluginTabs?.find((t) => t.plugin === p);
				if (tab) {
					tab.display();
					r.settingsItems = tab.containerEl.querySelectorAll(".setting-item").length;
					tab.containerEl.empty();
				}
				r.ok = p.engine.ok && !r.errorBanner && r.hud && r.hudGone && Object.values(r.commands).every((x) => x !== false) && r.searchOpened && r.highlightByCommand && r.logExported && r.logHasEngine && r.openCurrentWorked && r.modalShown && r.probeCommandHidden && r.probe.penEvents >= 9 && r.probeExported && r.fileMenu && r.fileMenuOpens && r.noMenuForMarkdown && (r.settingsItems ?? 0) >= 8;
				return r;
			});

			await check("rename-while-open", async () => {
				const { v } = await openPenDF("cropbox.pdf");
				await waitText(v, 1);
				const range1 = await waitFor(() => textRange(v, 1, "Inside the CropBox"));
				selectRange(range1);
				const [id1] = v.highlights.createFromSelection("#ffd400");
				await app.fileManager.renameFile(file("cropbox.pdf"), FIX + "cropbox-renamed.pdf");
				await sleep(300);
				// keep annotating the renamed, still-open document
				const sp = spans(v, 1);
				select(sp[sp.length - 1], 0, sp[sp.length - 1]);
				const [id2] = v.highlights.createFromSelection("#2ea8e5");
				await v.flush();
				await sleep(300);
				const newPath = FIX + "cropbox-renamed.pdf.pendf.json";
				const oldPath = FIX + "cropbox.pdf.pendf.json";
				const saved = (await ad.exists(newPath)) ? JSON.parse(await ad.read(newPath)).annotations.map((a) => a.id) : [];
				const oldExists = await ad.exists(oldPath);
				closeOurs();
				await app.fileManager.renameFile(file("cropbox-renamed.pdf"), FIX + "cropbox.pdf");
				await waitFor(() => ad.exists(oldPath), 5000).catch(() => {});
				return { both: saved.includes(id1) && saved.includes(id2), oldExists, viewFile: v.file?.path, ok: saved.includes(id1) && saved.includes(id2) && !oldExists };
			});

			await check("highlight-palette", async () => {
				// the real UI path: select → palette appears → swatch → highlight
				const { v } = await openPenDF("two-column.pdf");
				await waitText(v, 1);
				const sp = spans(v, 1);
				select(sp[4], 0, sp[5]);
				const palette = await waitFor(() => v.containerEl.querySelector(".pendf-palette"), 5000);
				const swatches = palette.querySelectorAll(".pendf-swatch");
				const before = store(v).all().length;
				swatches[2].dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
				swatches[2].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); // must not double-create
				const after = store(v).all();
				const made = after.length - before;
				const a = after[after.length - 1];
				return { made, color: a?.color, paletteGone: !v.containerEl.querySelector(".pendf-palette"), selectionCleared: getSelection().isCollapsed, ok: made === 1 && a.color === P().settings.colors[2].hex && !v.containerEl.querySelector(".pendf-palette") };
			});

			await check("highlight-menu-undo", async () => {
				const { v } = await openPenDF("letter.pdf");
				await waitText(v, 1);
				const sp = spans(v, 1);
				select(sp[2], 0, sp[2]);
				const [id] = v.highlights.createFromSelection("#ffd400");
				const pr = await waitFor(() => polyClientRect(v, id));
				const x = (pr.left + pr.right) / 2;
				const y = (pr.top + pr.bottom) / 2;
				getSelection().removeAllRanges();
				const target = document.elementFromPoint(x, y);
				target.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, bubbles: true, cancelable: true }));
				const menu = await waitFor(() => v.containerEl.querySelector(".pendf-hl-menu"));
				// recolor via menu
				menu.querySelectorAll(".pendf-swatch")[1].click();
				const recolored = hlById(v, id).color;
				// delete via menu
				target.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, bubbles: true, cancelable: true }));
				const menu2 = await waitFor(() => v.containerEl.querySelector(".pendf-hl-menu"));
				menu2.querySelector(".mod-warning").click();
				const deleted = hlById(v, id).deleted;
				const polyGone = !polyClientRect(v, id);
				v.undo();
				const back = !hlById(v, id).deleted && !!(await waitFor(() => polyClientRect(v, id)));
				v.undo();
				const colorBack = hlById(v, id).color;
				v.redo();
				return { recolored, deleted, polyGone, back, colorBack, ok: recolored !== "#ffd400" && deleted && polyGone && back && colorBack === "#ffd400" && hlById(v, id).color === recolored };
			});

			await check("notes", async () => {
				const { v, leaf } = await openPenDF("a4.pdf");
				await goPage(v, 1); // the file may be remembered at another page
				const s = v.debugSession;
				const store = s.store;
				const res = {};
				const clickAt = (x, y) => {
					const t = document.elementFromPoint(x, y);
					t.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
				};
				// 1. place mode → tap the page → editor modal → save
				s.notes.setPlacing(true);
				const pr = s.viewer.getPageView(0).div.getBoundingClientRect();
				clickAt(pr.left + pr.width * 0.3, pr.top + pr.height * 0.25);
				const ta = await waitFor(() => document.querySelector(".pendf-note-editor textarea"), 5000);
				ta.value = "**bold** from the editor";
				ta.dispatchEvent(new Event("input", { bubbles: true }));
				document.querySelector(".pendf-note-editor").closest(".modal").querySelector("button.mod-cta").click();
				await sleep(200);
				const point = store.all().find((a) => a.type === "note" && a.target.kind === "point");
				res.placed = point ? { page: point.page, body: point.body, x: point.target.x, y: point.target.y } : null;
				res.placingOff = !s.notes.placing;
				// 2. marker drawn; tapping it opens the rendered popover
				const marker = await waitFor(() => s.layers.getLayer(1)?.overlay.querySelector(`.pendf-note[data-id="${point.id}"]`), 5000);
				const mr = marker.getBoundingClientRect();
				const mx = mr.left + mr.width / 2;
				const my = mr.top + mr.height / 2;
				res.markerPx = Math.round(mr.width);
				res.hitTest = s.notes.hitTest(mx, my)?.id === point.id;
				clickAt(mx, my);
				await waitFor(() => s.notes.popoverEl?.querySelector("strong"), 5000).catch(() => {});
				res.popoverBold = s.notes.popoverEl?.querySelector("strong")?.textContent ?? null;
				res.highlightMenuNotOpened = !s.viewerRoot?.querySelector?.(".pendf-hl-menu") && !document.querySelector(".pendf-hl-menu");
				s.notes.closePopover();
				// 3. note on a highlight; deleting the highlight takes the note along, one undo restores both
				const now = Date.now();
				const h = { id: "h-notes-check", type: "highlight", page: 1, createdAt: now, updatedAt: now, deleted: false, quads: [[100, 700, 300, 700, 100, 690, 300, 690]], color: "#ffd400", text: "quoted text" };
				s.undo.record("highlight", [h.id], () => store.upsert(h));
				const hn = s.notes.noteOnHighlight(store.get(h.id), "note on *highlight*");
				const live = () => store.all().filter((a) => a.id === h.id || a.id === hn).length;
				res.beforeDelete = live();
				s.highlights.deleteHighlight(store.get(h.id));
				res.afterDelete = live();
				v.undo();
				res.afterUndo = live();
				// 4. panel lists both, renders Markdown, and follows the view
				await P().showSidebarPanel();
				const panel = await waitFor(() => app.workspace.getLeavesOfType("pendf-annotations")[0]?.view, 5000);
				await waitFor(() => panel.contentEl.querySelectorAll(".pendf-panel-item").length >= 2, 5000).catch(() => {});
				res.panelItems = panel.contentEl.querySelectorAll(".pendf-panel-item").length;
				res.panelBold = panel.contentEl.querySelector(".pendf-panel-note strong")?.textContent ?? null;
				res.panelHighlightNote = !!panel.contentEl.querySelector(".pendf-panel-item.is-highlight .pendf-panel-note em");
				// 5. saved to the sidecar and back after reopening
				await store.flush();
				leaf.detach();
				const again = await openPenDF("a4.pdf");
				const notes = again.v.debugSession.store.all().filter((a) => a.type === "note");
				res.reopened = notes.map((n) => n.body).sort();
				res.ok =
					!!res.placed && res.placed.page === 1 && res.placed.body === "**bold** from the editor" && res.placingOff &&
					res.hitTest && res.popoverBold === "bold" && res.highlightMenuNotOpened &&
					res.beforeDelete === 2 && res.afterDelete === 0 && res.afterUndo === 2 &&
					res.panelItems >= 2 && res.panelBold === "bold" && res.panelHighlightNote &&
					res.reopened.length === 2 && res.reopened.includes("note on *highlight*");
				return res;
			});
			await check("pdf-links", async () => {
				// Phase 4: copy links, follow them from a note (reading view click and editor press)
				const pl = P();
				const ws = app.workspace;
				const res = {};
				pl.settings.openPdfsInPenDF = true;
				const notePath = FIX + "pendf-links-check.md";
				createdPaths.add(notePath);
				try {
					// a highlight and a note in long-300.pdf, page 5
					const { v, leaf } = await openPenDF("long-300.pdf");
					const s = v.debugSession;
					const now = Date.now();
					const h = { id: "links-check-h", type: "highlight", page: 5, createdAt: now, updatedAt: now, deleted: false, quads: [[72, 700, 300, 700, 72, 688, 300, 688]], color: "#5fb236", text: "linked text" };
					s.store.upsert(h);
					const nid = s.notes.createPointNote(9, 200, 400, "linked **note**");
					await s.store.flush();
					const hlLink = v.linkTo({ page: 5, id: h.id }, "linked text");
					const noteLink = v.linkTo({ page: 9, id: nid }, "note");
					const rectLink = v.linkTo({ page: 12, rect: [72, 500, 300, 520] }, "sel");
					res.hlLink = hlLink;
					res.formats = [hlLink, noteLink, rectLink].every((l) => /^\[\[long-300\.pdf#page=\d+&pendf(-rect)?=[^|\]]+\|[^\]]+\]\]$/.test(l));
					leaf.detach();
					await app.vault.create(notePath, `# links\n\nA ${hlLink} B\n\nC ${noteLink} D\n\nE ${rectLink} F\n`);
					const md = app.vault.getAbstractFileByPath(notePath);
					const waitPdf = async (fn) => {
						const l = await waitFor(() => { const x = ws.getMostRecentLeaf(); return x && x.view.getViewType() === VIEW && x.view.debugSession?.ready && x.view.debugSession.store ? x : null; }, 20000);
						await sleep(900);
						return fn(l.view.debugSession, l);
					};
					// 1. reading view: press + click the highlight link
					const nl = ws.getLeaf("tab");
					await nl.setViewState({ type: "markdown", state: { file: md.path, mode: "preview" }, active: true });
					const a = await waitFor(() => nl.view.containerEl.querySelector('a.internal-link[data-href*="links-check-h"]'), 10000);
					a.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0 }));
					a.click();
					res.reading = await waitPdf((ss, l) => {
						const r = { page: ss.viewer.currentPageNumber, flashed: !!ss.layers.getLayer(5)?.group.querySelector('.pendf-hl.is-selected[data-id="links-check-h"]') };
						l.detach();
						return r;
					});
					// 2. editor (source mode): press on the note link, then let Obsidian open it
					const el = ws.getLeaf("tab");
					await el.setViewState({ type: "markdown", state: { file: md.path, mode: "source", source: true }, active: true });
					const cm = await waitFor(() => el.view.containerEl.querySelector(".cm-content"), 10000);
					await sleep(300);
					const line = [...cm.querySelectorAll(".cm-line")].find((x) => x.textContent.includes("pendf=" + nid));
					const range = document.createRange();
					const tn = [...line.childNodes].length ? line : line;
					range.selectNodeContents(tn);
					const lr = range.getClientRects()[0] || line.getBoundingClientRect();
					const txt = line.textContent;
					// pointer over the middle of the link text
					const frac = (txt.indexOf("[[") + 6) / txt.length;
					const x = lr.left + Math.max(4, (line.getBoundingClientRect().width) * frac);
					const y = lr.top + lr.height / 2;
					const target = document.elementFromPoint(x, y) || line;
					target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, view: window }));
					target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, view: window }));
					const linktext = noteLink.slice(2, noteLink.indexOf("|"));
					await ws.openLinkText(linktext, md.path, false);
					res.editor = await waitPdf((ss, l) => {
						const r = { page: ss.viewer.currentPageNumber, visible: ss.layers.visiblePages(), popover: ss.notes.popoverEl?.querySelector("strong")?.textContent ?? null };
						l.detach();
						return r;
					});
					// 3. selection link: rectangle flashed on its page
					const rl = ws.getLeaf("tab");
					await rl.setViewState({ type: "markdown", state: { file: md.path, mode: "preview" }, active: true });
					const ra = await waitFor(() => rl.view.containerEl.querySelector('a.internal-link[data-href*="pendf-rect"]'), 10000);
					ra.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0 }));
					ra.click();
					res.rect = await waitPdf((ss, l) => {
						const r = { page: ss.viewer.currentPageNumber, visible: ss.layers.visiblePages(), flash: !!ss.layers.getLayer(12)?.overlay.querySelector(".pendf-flash") };
						l.detach();
						return r;
					});
					// 4. a plain open (no link pressed) still uses the remembered position, not a stale link
					const pl2 = ws.getLeaf("tab");
					await pl2.openFile(app.vault.getAbstractFileByPath(FIX + "long-300.pdf"), { active: true });
					res.plainOpen = await waitPdf((ss, l) => {
						const r = { type: l.view.getViewType(), page: ss.viewer.currentPageNumber };
						l.detach();
						return r;
					});
					res.ok =
						res.formats &&
						res.reading.page === 5 && res.reading.flashed &&
						// the target page is on screen (pdf.js's "current page" depends on the viewer width
						// earlier checks leave behind, D-37)
						res.editor.visible.includes(9) && res.editor.popover === "note" &&
						res.rect.visible.includes(12) && res.rect.flash &&
						res.plainOpen.type === VIEW;
					return res;
				} finally {
					pl.settings.openPdfsInPenDF = false;
				}
			});
			await check("bookmarks", async () => {
				// Phase 5: PDF outline (read-only) + user bookmarks; the PDF itself never changes
				const f = file("long-300.pdf");
				const hash = async () => {
					const buf = await app.vault.readBinary(f);
					const d = await crypto.subtle.digest("SHA-256", buf);
					return Array.from(new Uint8Array(d).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
				};
				const before = { hash: await hash(), mtime: f.stat.mtime, size: f.stat.size };
				const { v, leaf } = await openPenDF("long-300.pdf");
				const s = v.debugSession;
				const res = {};
				// 1. outline with resolved pages (explicit and named destinations)
				const outline = await v.outline();
				res.outline = { top: outline.length, first: [outline[0].title, outline[0].page], named: [outline[29].title, outline[29].page], child: [outline[3].items[1].title, outline[3].items[1].page] };
				// 2. panel → Outline tab → tap "Chapter 30"
				await P().showSidebarPanel("outline");
				const panel = await waitFor(() => app.workspace.getLeavesOfType("pendf-annotations")[0]?.view, 5000);
				// let the sidebar finish opening: pdf.js re-fits the width on resize and returns to its last
				// recorded spot, so wait until the PDF area's width has been stable for a while
				const settle = async () => {
					let w = -1;
					let same = 0;
					for (let i = 0; i < 40 && same < 3; i++) {
						const cw = s.viewer.container.clientWidth;
						same = cw === w ? same + 1 : 0;
						w = cw;
						await sleep(150);
					}
				};
				await settle();
				const ch30 = await waitFor(() => [...panel.contentEl.querySelectorAll(".pendf-outline-row")].find((r) => r.textContent.startsWith("Chapter 30")), 8000);
				ch30.click();
				await waitFor(() => s.viewer.currentPageNumber === 292, 5000).catch(() => {});
				res.outlineJump = s.viewer.currentPageNumber;
				// 3. bookmarks: one through the prompt (suggested title), three with given titles
				await settle();
				v.goToPage(46);
				await sleep(400);
				const pending = v.addBookmark();
				const input = await waitFor(() => document.querySelector(".pendf-prompt-input"), 5000);
				res.suggested = input.value;
				input.closest(".modal").querySelector("button.mod-cta").click();
				const viaPrompt = await pending;
				const add = async (page, title) => {
					v.goToPage(page);
					await sleep(300);
					return v.addBookmark(title);
				};
				const alpha = await add(50, "Alpha");
				const beta = await add(120, "Beta");
				const gamma = await add(7, "Gamma");
				const titles = () => v.bookmarks().map((b) => b.title);
				res.added = titles();
				res.positions = v.bookmarks().map((b) => [b.page, Math.round(b.y)]);
				v.moveBookmark(gamma, 0);
				res.afterMove = titles();
				await v.renameBookmark(v.bookmarks().find((b) => b.id === beta), "Beta 2");
				v.deleteBookmark(v.bookmarks().find((b) => b.id === alpha));
				res.afterRenameDelete = titles();
				v.undo();
				res.afterUndo = titles();
				// 4. Bookmarks tab lists them in order; tapping one jumps there
				panel.showTab("bookmarks");
				await sleep(300);
				res.panelRows = [...panel.contentEl.querySelectorAll(".pendf-bookmark-title")].map((e) => e.textContent);
				[...panel.contentEl.querySelectorAll(".pendf-bookmark-main")].find((e) => e.textContent.startsWith("Beta 2")).click();
				await waitFor(() => s.viewer.currentPageNumber === 120, 5000).catch(() => {});
				res.bookmarkJump = s.viewer.currentPageNumber;
				// 5. a copied link to a bookmark leads back to it
				res.link = v.linkTo({ page: 50, id: alpha }, "Alpha");
				v.goToPage(1);
				await sleep(300);
				v.setEphemeralState({ subpath: res.link.slice(res.link.indexOf("#"), res.link.indexOf("|")) });
				await waitFor(() => s.viewer.currentPageNumber === 50, 5000).catch(() => {});
				res.linkJump = s.viewer.currentPageNumber;
				// 6. saved, reopened, PDF untouched
				await s.store.flush();
				leaf.detach();
				const again = await openPenDF("long-300.pdf");
				res.reopened = again.v.bookmarks().map((b) => b.title);
				const after = { hash: await hash(), mtime: f.stat.mtime, size: f.stat.size };
				res.pdfUnchanged = before.hash === after.hash && before.mtime === after.mtime && before.size === after.size;
				res.ok =
					res.outline.top === 30 && res.outline.first[1] === 2 && res.outline.named[1] === 292 && res.outline.child[1] === 37 &&
					res.outlineJump === 292 &&
					/^Page 46 — /.test(res.suggested) && !!viaPrompt &&
					res.added.join() === [res.suggested, "Alpha", "Beta", "Gamma"].join() &&
					res.afterMove[0] === "Gamma" &&
					!res.afterRenameDelete.includes("Alpha") && res.afterRenameDelete.includes("Beta 2") &&
					res.afterUndo.includes("Alpha") &&
					res.panelRows.join() === res.afterUndo.join() &&
					res.bookmarkJump === 120 && res.linkJump === 50 &&
					res.reopened.join() === res.afterUndo.join() &&
					res.pdfUnchanged;
				return res;
			});
			await check("ink", async () => {
				// Phase 6: synthetic Pencil events → stored PDF points; touch ignored; eraser, undo, reopen
				const pl = P();
				const inkBefore = structuredClone(pl.settings.ink);
				const res = { geometry: [] };
				const ptr = (type, el, x, y, pointerType = "pen", id = 7) =>
					el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: id, pointerType, button: 0, buttons: type === "pointerup" ? 0 : 1, isPrimary: true, pressure: 0.5, view: window }));
				const clientOf = (s, page, x, y) => {
					const geom = s.layers.geometry(page);
					const div = s.viewer.getPageView(page - 1).div;
					const cs = getComputedStyle(div);
					const r = div.getBoundingClientRect();
					const bl = parseFloat(cs.borderLeftWidth) || 0;
					const bt = parseFloat(cs.borderTopWidth) || 0;
					const w = r.width - bl - (parseFloat(cs.borderRightWidth) || 0);
					const h = r.height - bt - (parseFloat(cs.borderBottomWidth) || 0);
					const v = geom.toView(x, y);
					return [r.left + bl + (v[0] * w) / geom.width, r.top + bt + (v[1] * h) / geom.height];
				};
				// draw a stroke through PDF points on a page; returns the new ink annotation
				const drawPdf = async (v, page, pdfPts, pointerType = "pen") => {
					const s = v.debugSession;
					const before = new Set(s.store.all().map((a) => a.id));
					// bring the stroke's first point to the middle of the view (works for any rotation)
					const c0 = clientOf(s, page, pdfPts[0][0], pdfPts[0][1]);
					const cr = s.viewer.container.getBoundingClientRect();
					s.viewer.container.scrollTop += c0[1] - (cr.top + cr.height / 2);
					s.viewer.container.scrollLeft += c0[0] - (cr.left + cr.width / 3);
					await sleep(250);
					const cl = pdfPts.map(([x, y]) => clientOf(s, page, x, y));
					const target = document.elementFromPoint(cl[0][0], cl[0][1]);
					if (!target) {
						const pr = s.viewer.getPageView(page - 1).div.getBoundingClientRect();
						const cr = s.viewer.container.getBoundingClientRect();
						throw new Error(`no element at ${JSON.stringify(cl.map((c) => c.map(Math.round)))} page=${page} pageRect=${[pr.left, pr.top, pr.width, pr.height].map(Math.round)} container=${[cr.left, cr.top, cr.width, cr.height].map(Math.round)} win=${innerWidth}x${innerHeight} current=${s.viewer.currentPageNumber} scale=${s.viewer.currentScale}`);
					}
					ptr("pointerdown", target, cl[0][0], cl[0][1], pointerType);
					for (let i = 1; i < cl.length; i++) ptr("pointermove", target, cl[i][0], cl[i][1], pointerType);
					ptr("pointerup", target, cl[cl.length - 1][0], cl[cl.length - 1][1], pointerType);
					target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: cl[cl.length - 1][0], clientY: cl[cl.length - 1][1], view: window }));
					await sleep(50);
					return s.store.all().find((a) => !before.has(a.id) && a.type === "ink") ?? null;
				};
				const err = (a, pts) => (a ? Math.max(Math.hypot(a.points[0] - pts[0][0], a.points[1] - pts[0][1]), Math.hypot(a.points[a.points.length - 2] - pts[pts.length - 1][0], a.points[a.points.length - 1] - pts[pts.length - 1][1])) : Infinity);
				try {
					pl.settings.ink = { ...pl.settings.ink, tool: "pen", penColor: "#1f1f1f", penWidth: 1.5, input: "stylus" };
					// 1. ground truth on rotated pages and a CropBox page, at 150 %
					for (const [name, pages] of [["rotations.pdf", [1, 2, 3, 4]], ["cropbox.pdf", [1]]]) {
						const { v } = await openPenDF(name);
						const s = v.debugSession;
						s.viewer.currentScaleValue = "1.5";
						await sleep(300);
						v.toggleInk(true);
						for (const page of pages) {
							v.goToPage(page);
							await waitRendered(v, page);
							await sleep(200);
							const vb = s.layers.geometry(page).viewBox;
							const pts = [[vb[0] + 80, vb[1] + 300], [vb[0] + 140, vb[1] + 320], [vb[0] + 200, vb[1] + 310]];
							const a = await drawPdf(v, page, pts);
							const svg = !!(a && s.layers.getLayer(page)?.ink.querySelector(`.pendf-ink[data-id="${a.id}"]`));
							res.geometry.push({ name, page, rotate: s.layers.geometry(page).rotation, errPt: +err(a, pts).toFixed(3), svg });
						}
						// after rotating the view
						if (name === "rotations.pdf") {
							v.rotate(90);
							await sleep(400);
							v.goToPage(2);
							await waitRendered(v, 2);
							await sleep(200);
							const vb = s.layers.geometry(2).viewBox;
							const pts = [[vb[0] + 100, vb[1] + 500], [vb[0] + 180, vb[1] + 520]];
							const a = await drawPdf(v, 2, pts);
							res.geometry.push({ name, page: 2, viewRotated: true, rotate: s.layers.geometry(2).rotation, errPt: +err(a, pts).toFixed(3) });
						}
						await s.store.flush();
						closeOurs();
					}
					// 2. a4.pdf: touch ignored, click after a stroke opens nothing, eraser + undo, reopen
					const { v, leaf } = await openPenDF("a4.pdf");
					const s = v.debugSession;
					await waitRendered(v, 1);
					const now = Date.now();
					s.store.upsert({ id: "ink-check-h", type: "highlight", page: 1, createdAt: now, updatedAt: now, deleted: false, quads: [[90, 610, 400, 610, 90, 590, 400, 590]], color: "#ffd400", text: "under ink" });
					s.layers.refresh(1);
					v.toggleInk(true);
					res.touch = await drawPdf(v, 1, [[100, 500], [200, 520]], "touch");
					// outside ink mode: the Pencil writes only with "Apple Pencil always writes"
					v.toggleInk(false);
					pl.settings.ink = { ...pl.settings.ink, pencilAlways: true };
					const always = await drawPdf(v, 1, [[120, 450], [220, 460]]);
					const mouseOff = await drawPdf(v, 1, [[120, 420], [220, 425]], "mouse");
					pl.settings.ink = { ...pl.settings.ink, pencilAlways: false };
					const off = await drawPdf(v, 1, [[120, 430], [220, 440]]);
					res.pencilAlways = { writesWhenOn: !!always, mouseIgnored: mouseOff === null, ignoredWhenOff: off === null, inkModeOff: !v.debugSession.ink.active };
					if (always) {
						s.store.remove(always.id);
						s.layers.refresh(1);
					}
					pl.settings.ink = { ...pl.settings.ink, pencilAlways: true };
					v.toggleInk(true);
					const across = await drawPdf(v, 1, [[80, 600], [250, 600], [420, 600]]);
					res.menuAfterStroke = !!s.viewerRoot?.querySelector?.(".pendf-hl-menu") || !!document.querySelector(".pendf-hl-menu");
					const dot = await drawPdf(v, 1, [[300, 300]]);
					res.dot = dot ? { n: dot.points.length, svg: !!s.layers.getLayer(1)?.ink.querySelector(`.pendf-ink[data-id="${dot.id}"]`) } : null;
					pl.settings.ink = { ...pl.settings.ink, tool: "eraser" };
					const live = () => s.store.all().filter((a) => a.type === "ink").length;
					res.beforeErase = live();
					await drawPdf(v, 1, [[250, 640], [250, 560]]); // crosses the long stroke only
					res.afterErase = live();
					res.erasedLong = !s.store.get(across.id) || s.store.get(across.id).deleted;
					v.undo();
					res.afterUndo = live();
					v.toggleInk(false);
					// 3. stress: 1,500 strokes on page 2
					const t0 = performance.now();
					s.store.upsert; // (keep reference)
					const many = [];
					for (let k = 0; k < 1500; k++) {
						const pts = [];
						for (let i = 0; i < 40; i++) pts.push(Math.round((60 + i * 3 + (k % 30) * 15) * 100) / 100, Math.round((780 - Math.floor(k / 30) * 14 + Math.sin(i + k) * 4) * 100) / 100);
						many.push({ id: "stress-" + k, type: "ink", page: 2, createdAt: now + k, updatedAt: now + k, deleted: false, tool: "pen", color: "#1f1f1f", width: 1, points: pts });
					}
					for (const a of many) s.store.upsert(a);
					const tUpsert = performance.now() - t0;
					v.goToPage(2);
					await waitRendered(v, 2);
					const t1 = performance.now();
					s.layers.refresh(2);
					const tRender = performance.now() - t1;
					const t2 = performance.now();
					await s.store.flush();
					const tFlush = performance.now() - t2;
					const size = (await app.vault.adapter.stat(FIX + "a4.pdf.pendf.json"))?.size ?? -1;
					const t3 = performance.now();
					JSON.stringify(s.store.raw());
					const tStringify = performance.now() - t3;
					// eraser drag across the crowded page: cost per pointermove (includes interpolation)
					pl.settings.ink = { ...pl.settings.ink, tool: "eraser" };
					v.toggleInk(true);
					const ec = [clientOf(s, 2, 60, 700), clientOf(s, 2, 520, 600)];
					const etarget = document.elementFromPoint(ec[0][0], ec[0][1]);
					ptr("pointerdown", etarget, ec[0][0], ec[0][1]);
					const moves = 40;
					const t4 = performance.now();
					for (let i = 1; i <= moves; i++) ptr("pointermove", etarget, ec[0][0] + ((ec[1][0] - ec[0][0]) * i) / moves, ec[0][1] + ((ec[1][1] - ec[0][1]) * i) / moves);
					const tErase = (performance.now() - t4) / moves;
					ptr("pointerup", etarget, ec[1][0], ec[1][1]);
					const erasedNow = 1500 - s.store.all().filter((a) => a.type === "ink" && a.page === 2).length;
					v.undo();
					v.toggleInk(false);
					res.stress = { strokes: 1500, upsertMs: Math.round(tUpsert), renderPageMs: Math.round(tRender), flushMs: Math.round(tFlush), stringifyMs: Math.round(tStringify), eraserMsPerMove: +tErase.toFixed(2), erasedInDrag: erasedNow, sidecarBytes: size, paths: s.layers.getLayer(2)?.ink.querySelectorAll(".pendf-ink").length ?? 0 };
					// 4. reopen
					leaf.detach();
					const again = await openPenDF("a4.pdf");
					res.reopenedInk = again.v.debugSession.store.all().filter((a) => a.type === "ink").length;
					const g = res.geometry;
					res.ok =
						g.length === 6 && g.every((x) => x.errPt < 0.5) && g.filter((x) => "svg" in x).every((x) => x.svg) &&
						res.touch === null && !res.menuAfterStroke &&
						res.pencilAlways.writesWhenOn && res.pencilAlways.mouseIgnored && res.pencilAlways.ignoredWhenOff && res.pencilAlways.inkModeOff &&
						!!res.dot && res.dot.n === 2 && res.dot.svg &&
						res.beforeErase === 2 && res.afterErase === 1 && res.erasedLong && res.afterUndo === 2 &&
						res.stress.paths === 1500 && res.stress.sidecarBytes > 0 && res.stress.sidecarBytes < 2e6 &&
						res.reopenedInk === 1502;
					return res;
				} finally {
					pl.settings.ink = inkBefore;
				}
			});
			await check("pages-search", async () => {
				// side panel: page thumbnails (virtualized) and whole-document search
				const res = {};
				const { v } = await openPenDF("long-300.pdf");
				const s = v.debugSession;
				await P().showSidebarPanel("pages");
				const panel = await waitFor(() => app.workspace.getLeavesOfType("pendf-annotations")[0]?.view, 5000);
				await waitFor(() => panel.contentEl.querySelectorAll(".pendf-thumb").length === 300, 8000);
				res.cells = panel.contentEl.querySelectorAll(".pendf-thumb").length;
				await waitFor(() => panel.contentEl.querySelectorAll(".pendf-thumb.is-rendered").length >= 4, 15000).catch(() => {});
				const rendered = [...panel.contentEl.querySelectorAll(".pendf-thumb.is-rendered")];
				res.rendered = rendered.length;
				res.canvases = panel.contentEl.querySelectorAll("canvas").length;
				// each thumbnail stays inside its frame (≈104 px wide)
				const cr = rendered[0]?.querySelector("canvas")?.getBoundingClientRect();
				res.thumbCssWidth = cr ? Math.round(cr.width) : null;
				// the thumbnail really shows the page: some dark (text) pixels on white
				const cv = rendered[0]?.querySelector("canvas");
				if (cv) {
					const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
					let dark = 0;
					for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && d[i] + d[i + 1] + d[i + 2] < 700) dark++; // ink of any color on white
					res.darkPixelShare = +(dark / (d.length / 4)).toFixed(4);
				}
				// scroll the grid to the end: far canvases are released, new ones drawn
				panel.contentEl.scrollTop = panel.contentEl.scrollHeight;
				await sleep(300);
				await waitFor(() => panel.contentEl.querySelector('.pendf-thumb[data-page="300"].is-rendered'), 15000).catch(() => {});
				res.lastRendered = !!panel.contentEl.querySelector('.pendf-thumb[data-page="300"].is-rendered');
				res.firstReleased = !panel.contentEl.querySelector('.pendf-thumb[data-page="1"] canvas');
				res.canvasesAfterScroll = panel.contentEl.querySelectorAll("canvas").length;
				panel.contentEl.querySelector('.pendf-thumb[data-page="297"]').click();
				await waitFor(() => s.viewer.currentPageNumber === 297, 5000).catch(() => {});
				res.thumbJump = s.viewer.currentPageNumber;
				await sleep(200);
				res.currentMarked = panel.contentEl.querySelector(".pendf-thumb.is-current")?.dataset.page;
				// search tab
				panel.showTab("search");
				const input = await waitFor(() => panel.contentEl.querySelector(".pendf-search-panel-input"), 5000);
				input.value = "page 150";
				input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
				await waitFor(() => /match/.test(panel.contentEl.querySelector(".pendf-search-status")?.textContent ?? ""), 30000).catch(() => {});
				res.status = panel.contentEl.querySelector(".pendf-search-status")?.textContent;
				const hits = [...panel.contentEl.querySelectorAll(".pendf-search-hit")];
				res.hits = hits.length;
				res.firstHit = hits[0]?.textContent;
				hits[0]?.click();
				await waitFor(() => s.viewer.currentPageNumber === 150, 5000).catch(() => {});
				res.hitJump = s.viewer.currentPageNumber;
				await waitFor(() => s.layers.getLayer(150)?.overlay.querySelector(".pendf-flash"), 3000).catch(() => {});
				res.flashed = !!s.layers.getLayer(150)?.overlay.querySelector(".pendf-flash");
				// Korean, in an embedded-font PDF
				closeOurs();
				const k = await openPenDF("korean-embedded.pdf");
				await P().showSidebarPanel("search");
				const panel2 = await waitFor(() => app.workspace.getLeavesOfType("pendf-annotations")[0]?.view, 5000);
				await sleep(400);
				const input2 = await waitFor(() => panel2.contentEl.querySelector(".pendf-search-panel-input"), 5000);
				input2.value = "임베디드 글꼴";
				input2.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
				await waitFor(() => /match/.test(panel2.contentEl.querySelector(".pendf-search-status")?.textContent ?? ""), 15000).catch(() => {});
				res.korean = { status: panel2.contentEl.querySelector(".pendf-search-status")?.textContent, hits: panel2.contentEl.querySelectorAll(".pendf-search-hit").length, pages: k.v.pageCount };
				res.ok =
					res.cells === 300 && res.rendered >= 4 && res.canvases <= 40 && res.darkPixelShare > 0.002 && res.thumbCssWidth >= 100 && res.thumbCssWidth <= 108 &&
					res.lastRendered && res.firstReleased && res.canvasesAfterScroll <= 40 &&
					res.thumbJump === 297 && res.currentMarked === "297" &&
					res.hits >= 1 && /page 150/.test(res.firstHit) && res.hitJump === 150 && res.flashed &&
					res.korean.hits === res.korean.pages;
				return res;
			});
			await check("zoom-gesture", async () => {
				// Pinch and trackpad (ctrl+wheel) zoom, measured from the outside so the same check runs on
				// 0.7.1 (baseline) and later builds. Per scenario:
				//   during the gesture: pdf.js scale changes, layer-host removals, full renders, rAF frame gaps;
				//   every frame from gesture start until idle: visible pages that had a canvas but now show
				//     none / a black (unpainted alpha:false) canvas, and layer hosts that went missing;
				//   after the commit: full renders per page; canvas memory peak (w×h×4); finger-centre drift.
				// window.__pendfZoomProfile = { dpr } emulates a device pixel ratio for this check only.
				const res = { scenarios: {} };
				const prof = window.__pendfZoomProfile ?? {};
				const dprDesc = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
				if (prof.dpr) Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => prof.dpr });
				res.profile = { dpr: window.devicePixelRatio, maxCanvasPixels: null };
				let viewClass = null;
				try {
					const { v } = await openPenDF("long-300.pdf");
					// mobile render settings: reopen the file with the view class's test override
					// (0.7.1 has no renderOverride: the profile then only sets the pixel ratio)
					if (prof.render && "renderOverride" in v.constructor) {
						viewClass = v.constructor;
						viewClass.renderOverride = prof.render;
						await v.onLoadFile(v.file);
						await waitFor(() => v.debugSession?.ready, 20000);
						await waitIdle(v);
					}
					const s = v.debugSession;
					const c = s.viewer.container;
					res.profile.maxCanvasPixels = s.viewer.maxCanvasPixels;
					res.profile.preset = s.render?.preset ?? null;
					res.profile.budgetMB = s.render?.budgetMB ?? null;
					const reset = async (page = 5) => {
						s.viewer.currentScaleValue = "page-width";
						await goPage(v, page);
						await waitIdle(v);
						await sleep(300);
					};
					const visiblePageViews = () => {
						const cr = c.getBoundingClientRect();
						const out = [];
						for (let i = 0; i < s.viewer.pagesCount; i++) {
							const pv = s.viewer.getPageView(i);
							const r = pv.div.getBoundingClientRect();
							if (r.bottom > cr.top && r.top < cr.bottom && r.right > cr.left && r.left < cr.right) out.push(pv);
							else if (out.length && r.top > cr.bottom) break;
						}
						return out;
					};
					const canvasState = (pv) => {
						const cv = pv.div.querySelector(".canvasWrapper > canvas");
						if (!cv || !cv.width || !cv.isConnected) return "none";
						try {
							const d = cv.getContext("2d").getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data;
							if (d[3] !== 0 && d[0] + d[1] + d[2] < 30) {
								// the centre of a page can be legitimately dark; check 4 more points
								let dark = 0;
								for (const [fx, fy] of [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]]) {
									const e = cv.getContext("2d").getImageData(Math.floor(cv.width * fx), Math.floor(cv.height * fy), 1, 1).data;
									if (e[0] + e[1] + e[2] < 30) dark++;
								}
								if (dark === 4) return "black";
							}
						} catch {}
						return "ok";
					};
					const probe = () => {
						const st = { scaleEvents: 0, rendered: [], memPeak: 0, canvasPeak: 0, layerRemovals: 0, marks: {}, frames: [], blankFrames: 0, blackFrames: 0, layerMissingFrames: 0, blankPages: new Set(), hadCanvas: new Set(), hadLayer: new Set() };
						for (const pv of visiblePageViews()) {
							if (canvasState(pv) !== "none") st.hadCanvas.add(pv.id);
							if (pv.div.querySelector(".pendf-layer-host")) st.hadLayer.add(pv.id);
						}
						const sampleMem = () => {
							let b = 0;
							let n = 0;
							for (const cv of v.containerEl.querySelectorAll("canvas")) {
								b += cv.width * cv.height * 4;
								n++;
							}
							st.memPeak = Math.max(st.memPeak, b);
							st.canvasPeak = Math.max(st.canvasPeak, n);
						};
						let running = true;
						let last = performance.now();
						const frame = (now) => {
							if (!running) return;
							st.frames.push({ t: now, gap: now - last, top: c.scrollTop, left: c.scrollLeft, scale: s.viewer.currentScale });
							last = now;
							sampleMem();
							let blank = false;
							let black = false;
							let missing = false;
							for (const pv of visiblePageViews()) {
								if (st.hadCanvas.has(pv.id)) {
									const cs = canvasState(pv);
									if (cs === "none") {
										blank = true;
										st.blankPages.add(pv.id);
									} else if (cs === "black") black = true;
								}
								if (st.hadLayer.has(pv.id) && !pv.div.querySelector(".pendf-layer-host")) missing = true;
							}
							if (blank) st.blankFrames++;
							if (black) st.blackFrames++;
							if (missing) st.layerMissingFrames++;
							requestAnimationFrame(frame);
						};
						requestAnimationFrame(frame);
						const onScale = () => st.scaleEvents++;
						const onRendered = (e) => st.rendered.push({ p: e.pageNumber, css: !!e.cssTransform, detail: !!e.isDetailView, t: performance.now() });
						s.eventBus.on("scalechanging", onScale);
						s.eventBus.on("pagerendered", onRendered);
						const mo = new MutationObserver((ms) => {
							for (const m of ms) for (const n of m.removedNodes) if (n.classList?.contains("pendf-layer-host")) st.layerRemovals++;
						});
						mo.observe(c, { childList: true, subtree: true });
						return {
							st,
							mark(name) {
								st.marks[name] = { t: performance.now(), scaleEvents: st.scaleEvents, layerRemovals: st.layerRemovals, rendered: st.rendered.length };
							},
							stop() {
								running = false;
								s.eventBus.off("scalechanging", onScale);
								s.eventBus.off("pagerendered", onRendered);
								mo.disconnect();
								return st;
							},
						};
					};
					// content point under a client position: page + fraction inside the page box
					const anchorAt = (x, y) => {
						const pageDiv = document.elementsFromPoint(x, y).map((e) => e.closest?.(".page[data-page-number]")).find(Boolean);
						if (!pageDiv) return null;
						const r = pageDiv.getBoundingClientRect();
						return { page: Number(pageDiv.dataset.pageNumber), fx: (x - r.left) / r.width, fy: (y - r.top) / r.height };
					};
					let lastXY = null;
					const anchorError = (a, x, y) => {
						if (!a) return null;
						const r = s.viewer.getPageView(a.page - 1).div.getBoundingClientRect();
						lastXY = [+(r.left + a.fx * r.width - x).toFixed(2), +(r.top + a.fy * r.height - y).toFixed(2)];
						return +Math.hypot(r.left + a.fx * r.width - x, r.top + a.fy * r.height - y).toFixed(2);
					};
					// a point of the container's content area (without its scrollbar)
					const at = (fx, fy) => {
						const r = c.getBoundingClientRect();
						return [Math.round(r.left + c.clientLeft + c.clientWidth * fx), Math.round(r.top + c.clientTop + c.clientHeight * fy)];
					};
					const settle = async () => {
						await sleep(450);
						await waitIdle(v);
						await sleep(350);
					};
					const pct = (arr, q) => {
						if (!arr.length) return 0;
						const a = [...arr].sort((x, y) => x - y);
						return a[Math.min(a.length - 1, Math.floor(q * a.length))];
					};
					const summarize = (pr, startScale, extra = {}) => {
						const st = pr.stop();
						const { start, end } = st.marks;
						const during = st.rendered.slice(start.rendered, end.rendered);
						const after = st.rendered.slice(end.rendered).filter((r) => !r.css);
						const perPage = {};
						for (const r of after) if (!r.detail) perPage[r.p] = (perPage[r.p] ?? 0) + 1;
						const gaps = st.frames.filter((f) => f.t >= start.t && f.t <= end.t).slice(1).map((f) => f.gap);
						const gapsAfter = st.frames.filter((f) => f.t > end.t && f.t <= end.t + 1500).map((f) => f.gap);
						return {
							scaleBefore: +startScale.toFixed(3),
							scaleAfter: +s.viewer.currentScale.toFixed(3),
							scaleChangesDuringGesture: end.scaleEvents - start.scaleEvents,
							layerRemovalsDuringGesture: end.layerRemovals - start.layerRemovals,
							cssOnlyRendersDuringGesture: during.filter((r) => r.css).length,
							fullRendersDuringGesture: during.filter((r) => !r.css && !r.detail).length,
							maxRendersPerPageAfter: Math.max(0, ...Object.values(perPage)),
							pagesRenderedAfter: Object.keys(perPage).length,
							detailRendersAfter: after.filter((r) => r.detail).length,
							framesDuring: gaps.length,
							frameGapAvgMs: +(gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length)).toFixed(1),
							frameGapP95Ms: +pct(gaps, 0.95).toFixed(1),
							frameGapMaxMs: +Math.max(0, ...gaps).toFixed(1),
							frameGapMaxAfterMs: +Math.max(0, ...gapsAfter).toFixed(1),
							blankFrames: st.blankFrames,
							blankPages: [...st.blankPages],
							blackFrames: st.blackFrames,
							layerMissingFrames: st.layerMissingFrames,
							memPeakMB: +(st.memPeak / 1048576).toFixed(1),
							canvasPeak: st.canvasPeak,
							// scroll / scale moves from gesture start (ms since start): only the commit should move
							scrollMovesAfter: (() => {
								const after = st.frames;
								const out = [];
								for (let i = 1; i < after.length; i++) {
									const a = after[i - 1];
									const b = after[i];
									if (a.top !== b.top || a.left !== b.left || a.scale !== b.scale) out.push([Math.round(b.t - start.t), +(b.left - a.left).toFixed(1), +(b.top - a.top).toFixed(1), +b.scale.toFixed(3)]);
								}
								return out.slice(0, 8);
							})(),
							...extra,
						};
					};
					const touch = (id, x, y, target) => new Touch({ identifier: id, target, clientX: x, clientY: y, screenX: x, screenY: y, pageX: x, pageY: y, radiusX: 2, radiusY: 2, force: 0.5 });
					// two fingers horizontally around (cx, cy); distance goes d0 → d0·factor in `steps` moves
					const pinchStart = async (cx, cy) => {
						const target = document.elementFromPoint(cx, cy);
						const g = { cx, cy, target, d: 120 };
						g.fire = (type, d) => {
							const a = touch(21, cx - d / 2, cy, target);
							const b = touch(22, cx + d / 2, cy, target);
							const touches = type === "touchend" ? [] : [a, b];
							target.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: [a, b], bubbles: true, cancelable: true, composed: true }));
						};
						g.fire("touchstart", g.d);
						await sleep(16);
						g.move = async (factor, steps = 18) => {
							const d0 = g.d;
							for (let i = 1; i <= steps; i++) {
								g.d = d0 * Math.pow(factor, i / steps);
								g.fire("touchmove", g.d);
								await sleep(16);
							}
						};
						g.lift = () => g.fire("touchend", g.d);
						return g;
					};
					const pinchScenario = async (name, { fx = 0.5, fy = 0.45, factor = 1.8, holdMs = 0, factor2 = null, before = null } = {}) => {
						if (before) await before();
						const [cx, cy] = at(fx, fy);
						const a = anchorAt(cx, cy);
						const scale0 = s.viewer.currentScale;
						const pr = probe();
						pr.mark("start");
						const g = await pinchStart(cx, cy);
						await g.move(factor);
						if (holdMs) {
							await sleep(holdMs);
							await g.move(factor2 ?? 1.3);
						}
						await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
						// the composited preview, just before the fingers lift (rects include the transform)
						const previewErrorPx = anchorError(a, cx, cy);
						const previewXY = lastXY;
						pr.mark("end");
						g.lift();
						await settle();
						res.scenarios[name] = summarize(pr, scale0, { anchorErrorPx: anchorError(a, cx, cy), anchorErrXY: lastXY, previewErrorPx, previewXY, commit: s.zoom?.lastCommit ?? null });
					};
					const wheelScenario = async (name, { n, dy, deltaMode = 0, fx = 0.5, fy = 0.45 }) => {
						const [cx, cy] = at(fx, fy);
						const target = document.elementFromPoint(cx, cy);
						const a = anchorAt(cx, cy);
						const scale0 = s.viewer.currentScale;
						const pr = probe();
						pr.mark("start");
						for (let i = 0; i < n; i++) {
							target.dispatchEvent(new WheelEvent("wheel", { deltaY: dy, deltaMode, ctrlKey: true, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
							await sleep(16);
						}
						pr.mark("end");
						await settle();
						res.scenarios[name] = summarize(pr, scale0, { anchorErrorPx: anchorError(a, cx, cy), anchorErrXY: lastXY, commit: s.zoom?.lastCommit ?? null });
					};

					await reset();
					// sanity: a "pinch" whose finger distance never changes must not move anything
					await pinchScenario("anchor-sanity", { factor: 1 });
					await reset();
					await pinchScenario("pinch-in", { factor: 1.8 });
					await reset();
					await pinchScenario("pinch-hold-continue", { factor: 1.5, holdMs: 600, factor2: 1.3 });
					// again right away, before the previous re-render settled
					{
						const [cx, cy] = at(0.5, 0.45);
						const scale0 = s.viewer.currentScale;
						const g1 = await pinchStart(cx, cy);
						await g1.move(1.3, 10);
						g1.lift();
						await sleep(60);
						const a = anchorAt(cx, cy);
						const pr = probe();
						pr.mark("start");
						const g = await pinchStart(cx, cy);
						await g.move(1.4);
						pr.mark("end");
						g.lift();
						await settle();
						res.scenarios["pinch-again-before-idle"] = summarize(pr, scale0, { anchorErrorPx: anchorError(a, cx, cy), anchorErrXY: lastXY, commit: s.zoom?.lastCommit ?? null });
					}
					await reset();
					await pinchScenario("pinch-off-centre", { fx: 0.25, fy: 0.25, factor: 1.6 });
					await reset();
					await pinchScenario("pinch-out-below-fit", { factor: 0.4 });
					await reset();
					await wheelScenario("trackpad-pinch", { n: 24, dy: -3 });
					await reset();
					await wheelScenario("mouse-notch", { n: 1, dy: -100 });
					// maximum zoom from fit-width: pinch until the scale stops growing
					await reset();
					{
						const [cx, cy] = at(0.5, 0.45);
						const scale0 = s.viewer.currentScale;
						const pr = probe();
						pr.mark("start");
						let prev = -1;
						let rounds = 0;
						while (rounds < 6 && Math.abs(s.viewer.currentScale - prev) > 1e-3) {
							prev = s.viewer.currentScale;
							const g = await pinchStart(cx, cy);
							await g.move(3, 18);
							g.lift();
							await sleep(120);
							rounds++;
						}
						pr.mark("end");
						await settle();
						await sleep(1500);
						res.scenarios["max-zoom"] = summarize(pr, scale0, { rounds, capReached: Math.abs(s.viewer.currentScale - prev) <= 1e-3 });
					}
					await reset();
					res.zoomTimeline = v.lastZoomTimeline?.() ?? null;
					const sc = res.scenarios;
					const gestureOk = (r) => r.scaleChangesDuringGesture === 0 && r.layerRemovalsDuringGesture === 0 && r.fullRendersDuringGesture === 0 && r.maxRendersPerPageAfter <= 1 && r.blankFrames === 0 && r.blackFrames === 0 && r.layerMissingFrames === 0 && r.anchorErrorPx !== null && r.anchorErrorPx <= 2 && (r.commit?.anchorErrorPx ?? 0) <= 2;
					res.failed = Object.entries(sc).filter(([k, r]) => (k === "max-zoom" ? r.blankFrames + r.blackFrames + r.layerMissingFrames > 0 || !r.capReached : k === "mouse-notch" ? r.blankFrames + r.blackFrames > 0 || r.anchorErrorPx > 2 : !gestureOk(r))).map(([k]) => k);
					res.ok = res.failed.length === 0;
				} finally {
					if (viewClass) viewClass.renderOverride = null;
					if (prof.dpr) {
						if (dprDesc) Object.defineProperty(window, "devicePixelRatio", dprDesc);
						else delete window.devicePixelRatio;
					}
				}
				return res;
			});

			await check("zoom-extras", async () => {
				// 0.7.3: what zoom-gesture does not cover — highlight ground truth after a zoom commit,
				// the canvas budget never looping, switching the preset in settings, and the page
				// background in dark reading mode.
				const res = {};
				const pl = P();
				const settingsBefore = { zoomRendering: pl.settings.zoomRendering, invertPages: pl.settings.invertPages };
				try {
					// 1. ground truth after a pinch commit (rotations.pdf, every rotation)
					{
						const { v } = await openPenDF("rotations.pdf");
						const s = v.debugSession;
						s.viewer.currentScaleValue = "page-width";
						await waitIdle(v);
						const rows = [];
						for (const e of cfg.expected["rotations.pdf"] ?? []) {
							await goPage(v, e.page);
							await waitIdle(v);
							const c = s.viewer.container.getBoundingClientRect();
							const x = c.left + c.width / 2;
							const y = c.top + c.height / 2;
							const scale0 = s.viewer.currentScale;
							s.zoom.begin("pinch", x, y);
							s.zoom.update(1.7, x, y);
							await new Promise((r) => requestAnimationFrame(() => r()));
							s.zoom.end();
							await sleep(300);
							await waitIdle(v);
							const range = await waitFor(() => textRange(v, e.page, e.text));
							selectRange(range);
							const ids = v.highlights.createFromSelection("#ff0000");
							const a = hlById(v, ids[0]);
							const bb = quadBBox(a.quads);
							rows.push({ page: e.page, zoomed: +(s.viewer.currentScale / scale0).toFixed(3), scale: +s.viewer.currentScale.toFixed(3), quads: a.quads.length, dxStart: +(bb.minX - e.x).toFixed(2), dxEnd: +(bb.maxX - (e.x + e.width)).toFixed(2) });
							s.store.remove(a.id);
							s.viewer.currentScaleValue = "page-width";
							await waitIdle(v);
						}
						res.groundTruthAfterZoom = rows;
					}
					// 2. a budget far below what is on screen must not make pdf.js render in a loop
					{
						const { v } = await openPenDF("long-300.pdf");
						const cls = v.constructor;
						cls.renderOverride = { budgetMB: 2 };
						try {
							await v.onLoadFile(v.file);
							await waitFor(() => v.debugSession?.ready, 20000);
							const s = v.debugSession;
							s.viewer.currentScaleValue = "page-width";
							await goPage(v, 20);
							await waitIdle(v);
							let n = 0;
							const on = (e) => {
								if (!e.cssTransform) n++;
							};
							s.eventBus.on("pagerendered", on);
							for (let p = 21; p <= 26; p++) {
								s.viewer.currentPageNumber = p;
								await sleep(150);
							}
							await sleep(1500);
							const afterScroll = n;
							await sleep(3000);
							s.eventBus.off("pagerendered", on);
							res.budget = { budgetMB: s.render.budgetMB, rendersWhileScrolling: afterScroll, rendersIn3sIdle: n - afterScroll, canvases: v.containerEl.querySelectorAll("canvas").length };
						} finally {
							cls.renderOverride = null;
							await v.onLoadFile(v.file);
							await waitFor(() => v.debugSession?.ready, 20000);
						}
					}
					// 3. switching the preset in settings reopens the PDF with it
					{
						const { v } = await openPenDF("a4.pdf");
						pl.settings.zoomRendering = "low-memory";
						await pl.saveSettings();
						await waitFor(() => v.debugSession?.ready && v.debugSession.render.preset === "low-memory", 20000);
						res.presetSwitch = { preset: v.debugSession.render.preset, maxCanvasPixels: v.debugSession.viewer.maxCanvasPixels, budgetMB: v.debugSession.render.budgetMB };
						pl.settings.zoomRendering = "default";
						await pl.saveSettings();
						await waitFor(() => v.debugSession?.ready && v.debugSession.render.preset === "default", 20000);
						res.presetSwitch.back = { preset: v.debugSession.render.preset, maxCanvasPixels: v.debugSession.viewer.maxCanvasPixels };
					}
					// 4. dark reading mode: a page without canvas shows inverted (dark) paper, not white
					{
						const { v } = await openPenDF("long-300.pdf");
						pl.settings.invertPages = true;
						await pl.saveSettings();
						const s = v.debugSession;
						await goPage(v, 5);
						await waitIdle(v);
						const far = s.viewer.getPageView(250).div;
						const near = s.viewer.getPageView(4).div;
						res.invert = {
							farHasCanvas: !!far.querySelector("canvas"),
							farPageBg: getComputedStyle(far).backgroundColor,
							nearWrapperBg: getComputedStyle(near.querySelector(".canvasWrapper")).backgroundColor,
							nearWrapperFilter: getComputedStyle(near.querySelector(".canvasWrapper")).filter,
						};
					}
				} finally {
					pl.settings.zoomRendering = settingsBefore.zoomRendering;
					pl.settings.invertPages = settingsBefore.invertPages;
					await pl.saveSettings();
				}
				const gt = res.groundTruthAfterZoom ?? [];
				res.ok =
					gt.length > 0 && gt.every((r) => r.quads === 1 && Math.abs(r.dxStart) < 2.5 && Math.abs(r.dxEnd) < 3 && Math.abs(r.zoomed - 1.7) < 0.02) &&
					res.budget?.rendersIn3sIdle === 0 &&
					res.presetSwitch?.preset === "low-memory" && res.presetSwitch.maxCanvasPixels === 2 ** 23 && res.presetSwitch.back.preset === "default" && res.presetSwitch.back.maxCanvasPixels === 2 ** 25 &&
					res.invert && !res.invert.farHasCanvas && res.invert.farPageBg === "rgb(0, 0, 0)" && res.invert.nearWrapperBg === "rgb(255, 255, 255)" && /invert/.test(res.invert.nearWrapperFilter);
				return res;
			});

			await check("in-view-panel", async () => {
				// 0.8.0 (D-42): the panel inside the view — placement by width, reading position kept when it
				// opens, resizes and closes, thumbnails freed off screen, sidebar setting, overlay closes outside
				const res = {};
				const pl = P();
				const locBefore = pl.settings.panelLocation;
				const sidebarBefore = app.workspace.getLeavesOfType("pendf-annotations").length;
				const rightCollapsed = app.workspace.rightSplit.collapsed;
				const leftCollapsed = app.workspace.leftSplit.collapsed;
				const { v, leaf } = await openPenDF("long-300.pdf");
				const s = v.debugSession;
				const c = s.viewer.container;
				try {
					v.panel.setOpen(false);
					v.setScale("page-width");
					await goPage(v, 40);
					c.scrollTop += Math.round(pageView(v, 40).div.getBoundingClientRect().height * 0.37);
					await sleep(400);
					await waitIdle(v);
					// the content at the view's top edge: page + fraction
					const top = () => {
						const cr = c.getBoundingClientRect();
						for (let n = 1; n <= s.viewer.pagesCount; n++) {
							const r = pageView(v, n).div.getBoundingClientRect();
							if (r.bottom > cr.top) return { page: n, fy: +((cr.top - r.top) / r.height).toFixed(4) };
						}
						return null;
					};
					const drift = (a, b) => (a && b && a.page === b.page ? Math.abs(a.fy - b.fy) * pageView(v, a.page).div.getBoundingClientRect().height : Infinity);
					const before = top();
					const scale0 = s.viewer.currentScale;
					const body = v.containerEl.querySelector(".pendf-body");
					// 1. open (auto placement)
					v.panel.setState({ open: false, tab: "pages", width: 260, prefer: "auto" });
					v.openPanel("pages");
					await sleep(500);
					await waitIdle(v);
					const expectDocked = body.clientWidth >= 260 + 560 || v.panel.currentMode === "docked";
					res.open = { mode: v.panel.currentMode, bodyWidth: body.clientWidth, expectDocked, scale: +s.viewer.currentScale.toFixed(4), scaleBefore: +scale0.toFixed(4), driftPx: +drift(before, top()).toFixed(2) };
					// 1b. not wide enough to dock: collapse Obsidian's left sidebar for the docked case
					if (v.panel.currentMode !== "docked") {
						v.panel.setOpen(false);
						await sleep(300);
						if (!app.workspace.leftSplit.collapsed) app.workspace.leftSplit.collapse();
						await sleep(600);
						await waitIdle(v);
						await goPage(v, 40);
						c.scrollTop += Math.round(pageView(v, 40).div.getBoundingClientRect().height * 0.37);
						await sleep(400);
						await waitIdle(v);
						const b2 = top();
						const sc2 = s.viewer.currentScale;
						v.openPanel("pages");
						await sleep(500);
						await waitIdle(v);
						res.docked = { mode: v.panel.currentMode, bodyWidth: body.clientWidth, scale: +s.viewer.currentScale.toFixed(4), scaleBefore: +sc2.toFixed(4), driftPx: +drift(b2, top()).toFixed(2) };
						before.page = b2.page;
						before.fy = b2.fy;
					}
					// 2. resize (docked only: the pages get narrower, fit width refits)
					if (v.panel.currentMode === "docked") {
						v.panel.setState({ ...v.panel.state, width: 360 });
						await sleep(500);
						await waitIdle(v);
						res.resize = { scale: +s.viewer.currentScale.toFixed(4), driftPx: +drift(before, top()).toFixed(2) };
					}
					// 3. thumbnails: only near-visible ones drawn, all within a few MB
					await waitFor(() => v.panel.el.querySelectorAll(".pendf-thumb.is-rendered").length >= 3, 15000).catch(() => {});
					const scroller = v.panel.el.querySelector(".pendf-inpanel-content");
					res.thumbs = { cells: v.panel.el.querySelectorAll(".pendf-thumb").length, rendered: v.panel.el.querySelectorAll(".pendf-thumb.is-rendered").length, mb: +(v.thumbnailBytes() / 1048576).toFixed(2) };
					scroller.scrollTop = scroller.scrollHeight;
					await sleep(800);
					await waitFor(() => v.panel.el.querySelector('.pendf-thumb[data-page="300"].is-rendered'), 15000).catch(() => {});
					res.thumbs.lastRendered = !!v.panel.el.querySelector('.pendf-thumb[data-page="300"].is-rendered');
					res.thumbs.page40Released = !v.panel.el.querySelector('.pendf-thumb[data-page="40"] canvas');
					res.thumbs.mbAfterScroll = +(v.thumbnailBytes() / 1048576).toFixed(2);
					res.thumbs.currentMarked = v.panel.el.querySelector(".pendf-thumb.is-current")?.dataset.page ?? null;
					// 4. close: back to the old scale, same content at the top
					v.panel.setOpen(false);
					await sleep(500);
					await waitIdle(v);
					res.close = { scale: +s.viewer.currentScale.toFixed(4), driftPx: +drift(before, top()).toFixed(2) };
					// 5. overlay: tap outside closes it, pages untouched
					v.panel.setState({ open: true, tab: "outline", width: 260, prefer: "overlay" });
					await sleep(300);
					const scaleOverlay = s.viewer.currentScale;
					const backdrop = v.containerEl.querySelector(".pendf-inpanel-backdrop");
					res.overlay = { mode: v.panel.currentMode, backdropShown: !!backdrop && !backdrop.hasClass("is-hidden") };
					backdrop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch" }));
					await sleep(200);
					res.overlay.closedByOutsideTap = !v.panel.isOpen;
					res.overlay.scaleUnchanged = s.viewer.currentScale === scaleOverlay;
					// 6. remembered as view state (not per file)
					v.panel.setState({ open: true, tab: "bookmarks", width: 300, prefer: "auto" });
					const st = leaf.getViewState().state?.panel;
					res.viewState = st ?? null;
					v.panel.setOpen(false);
					// 7. setting "Obsidian sidebar": the panel button opens the sidebar panel instead
					pl.settings.panelLocation = "sidebar";
					v.togglePanel();
					await sleep(500);
					res.sidebar = { sidebarLeaves: app.workspace.getLeavesOfType("pendf-annotations").length, inViewOpen: v.panel.isOpen };
				} finally {
					pl.settings.panelLocation = locBefore;
					v.panel?.setState({ open: false, tab: "outline", width: 280, prefer: "auto" });
					if (!sidebarBefore) for (const l of app.workspace.getLeavesOfType("pendf-annotations")) l.detach();
					if (rightCollapsed && !app.workspace.rightSplit.collapsed) app.workspace.rightSplit.collapse();
					if (!leftCollapsed && app.workspace.leftSplit.collapsed) app.workspace.leftSplit.expand();
				}
				const o = res.open;
				res.ok =
					o.mode === (o.expectDocked ? "docked" : "overlay") &&
					o.driftPx <= 2 &&
					(o.mode === "overlay" ? o.scale === o.scaleBefore : o.scale < o.scaleBefore) &&
					(!res.docked || (res.docked.mode === "docked" && res.docked.driftPx <= 2 && res.docked.scale < res.docked.scaleBefore)) &&
					(!res.resize || res.resize.driftPx <= 2) &&
					res.thumbs.cells === 300 && res.thumbs.rendered >= 3 && res.thumbs.rendered < 60 && res.thumbs.lastRendered && res.thumbs.page40Released && res.thumbs.mbAfterScroll < 8 &&
					res.close.driftPx <= 2 && Math.abs(res.close.scale - (res.docked ? res.docked.scaleBefore : o.scaleBefore)) < 0.002 &&
					res.overlay.mode === "overlay" && res.overlay.backdropShown && res.overlay.closedByOutsideTap && res.overlay.scaleUnchanged &&
					res.viewState?.tab === "bookmarks" && res.viewState.width === 300 && res.viewState.open === true &&
					res.sidebar.sidebarLeaves >= 1 && !res.sidebar.inViewOpen;
				return res;
			});

			await check("toolbar-labels", async () => {
				// 0.8.0: every toolbar button labelled; narrow widths move buttons into "More"; a long press
				// shows the name without acting
				const res = {};
				const { v } = await openPenDF("a4.pdf");
				const tb = v.containerEl.querySelector(".pendf-toolbar");
				const buttons = [...tb.querySelectorAll("button")];
				res.buttons = buttons.length;
				res.unlabelled = buttons.filter((b) => !(b.getAttribute("aria-label") || "").trim()).map((b) => b.outerHTML.slice(0, 80));
				res.groups = [...tb.querySelectorAll(".pendf-group")].map((g) => g.getAttribute("aria-label"));
				// narrow: one line, priority-1 buttons stay
				tb.style.width = "360px";
				await sleep(300);
				res.narrow = { overflowed: v.toolbarOverflow, fits: tb.scrollWidth <= tb.clientWidth + 1, moreShown: !tb.querySelector(".pendf-more").hasClass("is-hidden") };
				res.narrow.keptVisible = ["note", "ink", "undo", "panel"].filter((id) => getComputedStyle(tb.querySelector(`[data-tool="${id}"]`)).display !== "none");
				tb.style.width = "";
				await sleep(300);
				res.wide = { overflowed: v.toolbarOverflow, fits: tb.scrollWidth <= tb.clientWidth + 1, width: tb.clientWidth };
				// long press (touch): name shown, button not run
				const btn = tb.querySelector('[data-tool="rotate"]');
				const rot0 = v.debugSession.viewer.pagesRotation;
				btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 51 }));
				await sleep(600);
				const tip = document.querySelector(".pendf-press-tip");
				res.longPress = { tip: tip?.textContent ?? null };
				btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch", pointerId: 51 }));
				btn.click();
				await sleep(100);
				res.longPress.rotated = v.debugSession.viewer.pagesRotation !== rot0;
				if (res.longPress.rotated) v.debugSession.viewer.pagesRotation = rot0;
				res.ok =
					res.buttons >= 14 && res.unlabelled.length === 0 && res.groups.length >= 4 &&
					res.narrow.overflowed.length > 0 && res.narrow.fits && res.narrow.moreShown && res.narrow.keptVisible.length === 4 &&
					res.wide.fits && res.wide.overflowed.length < res.narrow.overflowed.length &&
					res.longPress.tip === "Rotate view" && !res.longPress.rotated;
				return res;
			});

			// ---- 0.8.0 margin (D-41) helpers ----
			const marginRect = (v, n) => {
				// the page's content box and its margin box (client coordinates, right margin, no view rotation)
				const div = pageView(v, n).div;
				const content = div.querySelector(":scope > .canvasWrapper").getBoundingClientRect();
				const cs = getComputedStyle(div);
				const mw = parseFloat(cs.borderRightWidth) - 9;
				return { content, margin: new DOMRect(content.right, content.top, mw, content.height), mw };
			};
			const penStroke = async (v, pts, id = 61) => {
				const c = v.debugSession.viewer.container;
				const fire = (type, x, y) => {
					const target = document.elementFromPoint(x, y) ?? c;
					target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerType: "pen", pointerId: id, isPrimary: true, clientX: x, clientY: y, pressure: 0.5, buttons: type === "pointerup" ? 0 : 1 }));
				};
				fire("pointerdown", pts[0][0], pts[0][1]);
				for (const [x, y] of pts.slice(1)) {
					await sleep(16);
					fire("pointermove", x, y);
				}
				fire("pointerup", pts[pts.length - 1][0], pts[pts.length - 1][1]);
				await sleep(300);
			};
			const inksOn = (v, page) => v.debugSession.store.all().filter((a) => a.type === "ink" && !a.deleted && a.page === page);
			const marginOff = async (v) => {
				v.setMargin({ on: false, side: "right", ratio: 0.5 });
				await sleep(200);
			};

			await check("margin-ink", async () => {
				const res = {};
				const pl = P();
				const inkBefore = { ...pl.settings.ink };
				const { v } = await openPenDF("a4.pdf");
				const s = v.debugSession;
				const made = [];
				try {
					v.setScale("page-width");
					await goPage(v, 1);
					await waitIdle(v);
					const textBefore = pageView(v, 1).textLayer.div.getBoundingClientRect();
					const canvasBefore = pageView(v, 1).div.querySelector(".canvasWrapper").getBoundingClientRect();
					v.setMargin({ on: true, side: "right", ratio: 0.5 });
					await sleep(400);
					await waitIdle(v);
					const m = marginRect(v, 1);
					const text = pageView(v, 1).textLayer.div.getBoundingClientRect();
					// pdf.js layers keep their place inside the page (relative to the page content)
					res.layout = {
						fitScaleBefore: null,
						marginPx: +m.mw.toFixed(1),
						marginShare: +(m.mw / m.content.width).toFixed(3),
						textMatchesCanvas: Math.abs(text.left - m.content.left) < 0.5 && Math.abs(text.width - m.content.width) < 0.5 && Math.abs(text.top - m.content.top) < 0.5,
						textWidthRatio: +(text.width / textBefore.width).toFixed(4),
						canvasWidthRatio: +(m.content.width / canvasBefore.width).toFixed(4),
						fitsContainer: pageView(v, 1).div.getBoundingClientRect().right <= s.viewer.container.getBoundingClientRect().right + 1,
					};
					// a Pencil stroke inside the margin (Pencil always writes, default on)
					pl.settings.ink = { ...pl.settings.ink, tool: "pen", pencilAlways: true };
					const y0 = m.margin.top + m.margin.height * 0.3;
					const x0 = m.margin.left + m.margin.width * 0.2;
					await penStroke(v, [[x0, y0], [x0 + 40, y0 + 10], [x0 + 80, y0 + 20], [x0 + 120, y0 + 10]]);
					const ink = inksOn(v, 1).at(-1);
					if (ink) made.push(ink.id);
					const geom = s.layers.geometry(1);
					res.stroke = { saved: !!ink, minX: ink ? Math.min(...ink.points.filter((_, i) => i % 2 === 0)) : null, pageWidthPt: geom.width, offPage: ink ? Math.min(...ink.points.filter((_, i) => i % 2 === 0)) > geom.viewBox[2] : false };
					const path = () => pageView(v, 1).div.querySelector(`.pendf-ink[data-id="${ink?.id}"]`);
					const pr = path()?.getBoundingClientRect();
					res.stroke.drawnInMargin = !!pr && pr.left >= m.margin.left - 2 && pr.right <= m.margin.right + 2;
					// zoom (D-38 commit) at a point in the margin: the stroke stays at the same place relative to the page
					const frac = (r, c) => [(r.left - c.left) / c.width, (r.top - c.top) / c.height];
					const before = frac(path().getBoundingClientRect(), marginRect(v, 1).content);
					s.zoom.begin("pinch", x0, y0);
					s.zoom.update(1.5, x0, y0);
					await sleep(50);
					s.zoom.end();
					await sleep(300);
					await waitIdle(v);
					const after = frac(path().getBoundingClientRect(), marginRect(v, 1).content);
					res.zoom = { commitErrorPx: s.zoom.lastCommit?.anchorErrorPx ?? null, strokeShift: +Math.hypot(after[0] - before[0], after[1] - before[1]).toFixed(4), marginShareAfter: +(marginRect(v, 1).mw / marginRect(v, 1).content.width).toFixed(3) };
					v.setScale("page-width");
					await sleep(300);
					await waitIdle(v);
					// closing the margin hides the stroke and marks the page edge
					v.toggleMargin(false);
					await sleep(400);
					const host = pageView(v, 1).div.querySelector(".pendf-layer-host");
					res.closed = { marked: pageView(v, 1).div.classList.contains("pendf-hidden-right"), clip: getComputedStyle(host).clipPath, borderRight: getComputedStyle(pageView(v, 1).div).borderRightWidth };
					// reopening the PDF opens the margin by itself, wide enough for the stroke
					await v.onLoadFile(v.file);
					await waitFor(() => v.debugSession?.ready && v.debugSession.store, 20000);
					await sleep(800);
					res.autoOpen = v.marginConfig;
					// eraser in the margin
					const s2 = v.debugSession;
					await waitIdle(v);
					pl.settings.ink = { ...pl.settings.ink, tool: "eraser" };
					const p2 = pageView(v, 1).div.querySelector(`.pendf-ink[data-id="${ink?.id}"]`)?.getBoundingClientRect();
					if (p2) await penStroke(v, [[p2.left + p2.width * 0.5, p2.top - 8], [p2.left + p2.width * 0.5, p2.top + p2.height / 2], [p2.left + p2.width * 0.5, p2.bottom + 8]], 62);
					res.erased = !s2.store.get(ink?.id) || s2.store.get(ink?.id).deleted;
				} finally {
					pl.settings.ink = inkBefore;
					for (const id of made) v.debugSession?.store?.remove(id);
					await marginOff(v);
				}
				const L = res.layout;
				res.ok =
					Math.abs(L.marginShare - 0.5) < 0.02 && L.textMatchesCanvas && L.fitsContainer &&
					res.stroke.saved && res.stroke.offPage && res.stroke.drawnInMargin &&
					res.zoom.commitErrorPx !== null && res.zoom.commitErrorPx <= 2 && res.zoom.strokeShift < 0.002 && Math.abs(res.zoom.marginShareAfter - 0.5) < 0.02 &&
					res.closed.marked && /inset/.test(res.closed.clip) && res.closed.borderRight === "9px" &&
					res.autoOpen?.on === true && res.autoOpen.side === "right" && res.autoOpen.ratio >= 0.5 &&
					res.erased;
				return res;
			});

			await check("margin-ground-truth", async () => {
				// highlight math with the margin open (pdf.js text layer must not move)
				// the views groundTruthRows opens read the margin from each file's view memory
				const files = ["rotations.pdf", "cropbox.pdf"];
				const shown = [];
				const watch = app.workspace.on("layout-change", () => {
					for (const l of app.workspace.getLeavesOfType(VIEW)) {
						const m = l.view.marginConfig;
						if (m && files.includes(l.view.file?.name)) shown.push([l.view.file.name, m.on, m.ratio]);
					}
				});
				let g = { rows: [] };
				try {
					for (const f of files) P().patchFileMemory(FIX + f, { margin: { on: true, side: "right", ratio: 0.75 } });
					g = await groundTruthRows(files);
				} finally {
					app.workspace.offref(watch);
					for (const f of files) P().patchFileMemory(FIX + f, { margin: { on: false, side: "right", ratio: 0.5 } });
				}
				const rows = g.rows;
				return { rows, marginSeen: shown.slice(0, 6), ok: rows.length >= 5 && rows.every((r) => r.quads === 1 && Math.abs(r.dxStart) < 2.5 && Math.abs(r.dxEnd) < 3) && shown.some((x) => x[1] === true && x[2] === 0.75) };
			});

			await check("margin-note", async () => {
				const res = {};
				const { v } = await openPenDF("a4.pdf");
				const s = v.debugSession;
				let id = null;
				try {
					v.setScale("page-width");
					await goPage(v, 1);
					v.setMargin({ on: true, side: "right", ratio: 0.5 });
					await sleep(400);
					await waitIdle(v);
					const m = marginRect(v, 1);
					const x = m.margin.left + m.margin.width * 0.5;
					const y = m.margin.top + m.margin.height * 0.25;
					// create where a tap in the margin points (the same input path a tap uses)
					const spot = s.notes.pointAt(x, y);
					res.spot = spot;
					id = spot ? s.notes.createPointNote(spot.page, spot.x, spot.y, "margin note") : null;
					await sleep(300);
					const marker = () => pageView(v, 1).div.querySelector(`.pendf-note[data-id="${id}"]`)?.getBoundingClientRect();
					const r = marker();
					res.create = { id, drawnAt: r ? [Math.round(r.left + r.width / 2 - x), Math.round(r.top + r.height / 2 - y)] : null, hit: s.notes.hitTest(x, y)?.id === id };
					// move by tap: Move → tap elsewhere in the margin
					const note = s.store.get(id);
					s.notes.startMove(note);
					const x2 = m.margin.left + m.margin.width * 0.7;
					const y2 = m.margin.top + m.margin.height * 0.6;
					document.elementFromPoint(x2, y2).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x2, clientY: y2 }));
					await sleep(300);
					const moved = s.store.get(id);
					const r2 = marker();
					res.move = { target: moved?.target, drawnAt: r2 ? [Math.round(r2.left + r2.width / 2 - x2), Math.round(r2.top + r2.height / 2 - y2)] : null, offPage: moved?.target.x > s.layers.geometry(1).viewBox[2] };
					v.undo();
					await sleep(200);
					res.undo = { backTo: s.store.get(id)?.target };
					s.notes.remove(s.store.get(id));
					res.deleted = !s.store.get(id) || s.store.get(id).deleted;
					id = null;
				} finally {
					if (id) s.store.remove(id);
					await marginOff(v);
				}
				const near = (d) => d && Math.abs(d[0]) <= 2 && Math.abs(d[1]) <= 2;
				res.ok = !!res.spot && res.spot.x > 595 && near(res.create.drawnAt) && res.create.hit && res.move.offPage && near(res.move.drawnAt) && res.undo.backTo?.x === res.spot.x && res.deleted;
				return res;
			});

			await check("margin-with-panel", async () => {
				// the margin and a docked panel side by side: nothing overlaps, fit width includes the margin
				const res = {};
				const { v } = await openPenDF("long-300.pdf");
				const s = v.debugSession;
				const leftCollapsed = app.workspace.leftSplit.collapsed;
				try {
					if (!leftCollapsed) app.workspace.leftSplit.collapse();
					await sleep(500);
					v.setScale("page-width");
					v.setMargin({ on: true, side: "right", ratio: 0.5 });
					v.panel.setState({ open: true, tab: "outline", width: 280, prefer: "auto" });
					await sleep(600);
					await waitIdle(v);
					const page = pageView(v, s.viewer.currentPageNumber).div.getBoundingClientRect();
					const panel = v.panel.el.getBoundingClientRect();
					const cont = s.viewer.container.getBoundingClientRect();
					res.layout = { mode: v.panel.currentMode, panelRight: Math.round(panel.right), pageLeft: Math.round(page.left), pageRight: Math.round(page.right), containerRight: Math.round(cont.right), fitScale: +s.viewer.currentScale.toFixed(3) };
					// canvas memory with margin + panel on, scrolling the 300-page PDF
					let peak = 0;
					let maxCanvases = 0;
					for (const p of [20, 80, 150, 220, 290]) {
						await goPage(v, p);
						await waitIdle(v);
						let b = 0;
						const cvs = v.containerEl.querySelectorAll(".pendf-container canvas");
						for (const c of cvs) b += c.width * c.height * 4;
						peak = Math.max(peak, b);
						maxCanvases = Math.max(maxCanvases, cvs.length);
					}
					res.memory = { pageCanvasesMax: maxCanvases, pageCanvasMBPeak: +(peak / 1048576).toFixed(1), thumbMB: +(v.thumbnailBytes() / 1048576).toFixed(2) };
				} finally {
					v.panel.setState({ open: false, tab: "outline", width: 280, prefer: "auto" });
					await marginOff(v);
					if (!leftCollapsed) app.workspace.leftSplit.expand();
				}
				const L = res.layout;
				res.ok = (L.mode !== "docked" || L.panelRight <= L.pageLeft) && L.pageRight <= L.containerRight + 1 && res.memory.pageCanvasesMax <= 12;
				return res;
			});

			await check("persist-restart-rename", async () => {
				// self-contained: make sure rotations.pdf has a highlight (earlier checks may or may not have run)
				{
					const { v: v0 } = await openPenDF("rotations.pdf");
					const st = store(v0);
					if (!st.all().some((a) => a.type === "highlight")) {
						const t = Date.now();
						st.upsert({ id: "persist-check-h", type: "highlight", page: 1, createdAt: t, updatedAt: t, deleted: false, quads: [[72, 700, 300, 700, 72, 688, 300, 688]], color: "#ffd400", text: "persist" });
					}
					await st.flush();
					closeOurs();
				}
				const before = (await ad.exists(FIX + "rotations.pdf.pendf.json")) && JSON.parse(await ad.read(FIX + "rotations.pdf.pendf.json"));
				const n = before ? before.annotations.filter((a) => !a.deleted).length : 0;
				await reloadPlugin();
				const { v } = await openPenDF("rotations.pdf");
				const afterRestart = store(v).all().length;
				await goPage(v, 1); // the highlight is on page 1; the file may be remembered elsewhere
				await waitFor(() => v.containerEl.querySelector(".pendf-hl polygon"));
				closeOurs();
				const f = file("rotations.pdf");
				await app.fileManager.renameFile(f, FIX + "rotations-renamed.pdf");
				const moved = await waitFor(() => ad.exists(FIX + "rotations-renamed.pdf.pendf.json"), 5000);
				const oldGone = !(await ad.exists(FIX + "rotations.pdf.pendf.json"));
				const { v: v2 } = await openPenDF("rotations-renamed.pdf");
				const afterRename = store(v2).all().length;
				closeOurs();
				await app.fileManager.renameFile(file("rotations-renamed.pdf"), FIX + "rotations.pdf");
				await waitFor(() => ad.exists(FIX + "rotations.pdf.pendf.json"), 5000);
				return { saved: n, afterRestart, moved: !!moved, oldGone, afterRename, ok: n > 0 && afterRestart === n && oldGone && afterRename === n };
			});

			await check("fingerprint-mismatch", async () => {
				// put a4's sidecar next to letter.pdf
				await ad.write(FIX + "letter.pdf.pendf.json", JSON.stringify({ schemaVersion: 1, pdfFingerprint: "not-this-pdf", annotations: [] }));
				const { v } = await openPenDF("letter.pdf");
				const banner = v.containerEl.querySelector(".pendf-banner")?.textContent || "";
				const status = store(v).status;
				const before = await ad.read(FIX + "letter.pdf.pendf.json");
				await v.flush();
				closeOurs();
				const after = await ad.read(FIX + "letter.pdf.pendf.json");
				await ad.remove(FIX + "letter.pdf.pendf.json");
				return { status, banner: banner.slice(0, 80), untouched: before === after, ok: status === "fingerprint-mismatch" && before === after && banner.length > 0 };
			});

			await check("long-300-memory", async () => {
				const { v } = await openPenDF("long-300.pdf");
				const s = v.debugSession;
				let maxCanvas = 0, maxLayers = 0, maxRendered = 0;
				const t0 = performance.now();
				for (const scale of ["page-width", "2", "0.6"]) {
					s.viewer.currentScaleValue = scale;
					for (let p = 1; p <= 300; p += 7) {
						s.viewer.currentPageNumber = p;
						await sleep(40);
						s.layers.sync();
						maxCanvas = Math.max(maxCanvas, v.containerEl.querySelectorAll("canvas").length);
						maxLayers = Math.max(maxLayers, s.layers.attachedPages.length);
					}
					await waitIdle(v);
					let rendered = 0;
					for (let i = 0; i < 300; i++) if (s.viewer.getPageView(i).renderingState === 3) rendered++;
					maxRendered = Math.max(maxRendered, rendered);
				}
				s.viewer.currentPageNumber = 300;
				try {
					await waitRendered(v, 300);
				} catch (e) {
					const hist = {};
					for (let i = 0; i < 300; i++) {
						const st = s.viewer.getPageView(i).renderingState;
						hist[st] = (hist[st] ?? 0) + 1;
					}
					const pv = s.viewer.getPageView(299);
					const c = v.debugSession.viewer.container;
					throw new Error(`page 300 not rendered: current=${s.viewer.currentPageNumber} scale=${s.viewer.currentScale} states=${JSON.stringify(hist)} p300state=${pv.renderingState} p300canvas=${!!pv.div.querySelector("canvas")} scrollTop=${c.scrollTop}/${c.scrollHeight} clientH=${c.clientHeight} visibleNow=${JSON.stringify(s.layers.visiblePages())}`);
				}
				const heap = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
				return { maxCanvas, maxLayers, maxRendered, seconds: +((performance.now() - t0) / 1000).toFixed(1), heapMB: heap, ok: maxCanvas <= 40 && maxLayers <= 12 && maxRendered <= 40 };
			});

			await check("fallback-main-thread", async () => {
				const workerGlobalBefore = window.pdfjsWorker;
				await app.plugins.disablePlugin(ID);
				window.Worker = class {
					constructor() {
						throw new Error("Worker disabled by harness");
					}
				};
				try {
					await app.plugins.enablePlugin(ID);
					await waitFor(() => P() && !!app.viewRegistry?.viewByType?.[VIEW]);
					let v;
					try {
						({ v } = await openPenDF("a4.pdf"));
					} catch (e) {
						// keep the evidence: the plugin's log is gone once the check reloads it
						const lv = app.workspace.getLeavesOfType(VIEW).map((l) => ({ file: l.view.file?.path ?? null, hasSession: !!l.view.debugSession, ready: !!l.view.debugSession?.ready, store: !!l.view.debugSession?.store, text: (l.view.containerEl.querySelector(".pendf-root")?.innerText ?? "").slice(0, 120), banner: l.view.containerEl.querySelector(".pendf-banner")?.innerText ?? null }));
						const all = [];
						app.workspace.iterateAllLeaves((l) => all.push(l.view.getViewType() + ":" + (l.getViewState().state?.file ?? "")));
						return { ok: false, error: String(e).slice(0, 200), leaves: lv, all, registered: !!app.viewRegistry?.viewByType?.[VIEW], enabled: app.plugins.enabledPlugins.has(ID), log: (P()?.getLogText?.() ?? "").split(String.fromCharCode(10)).slice(-30) };
					}
					await waitText(v, v.debugSession.viewer.currentPageNumber);
					const log = P().getLogText();
					return {
						mode: /falling back to main-thread/.test(log) ? "main-thread" : "?",
						rendered: pageView(v, v.debugSession.viewer.currentPageNumber).renderingState === 3,
						pdfjsWorkerUnchanged: window.pdfjsWorker === workerGlobalBefore,
						pdfjsLibUnchanged: window.pdfjsLib === globalsBefore.pdfjsLib || window.pdfjsLib?.version !== cfg.ourVersion,
						ok: /falling back to main-thread/.test(log) && pageView(v, v.debugSession.viewer.currentPageNumber).renderingState === 3 && window.pdfjsWorker === workerGlobalBefore,
					};
				} finally {
					closeOurs();
					await app.plugins.disablePlugin(ID);
					window.Worker = TrackedWorker;
					await app.plugins.enablePlugin(ID);
					await waitFor(() => P() && !!app.viewRegistry?.viewByType?.[VIEW]);
				}
			});

			await check("unload-cleanup", async () => {
				const { v } = await openPenDF("a4.pdf");
				await waitText(v, v.debugSession.viewer.currentPageNumber);
				// a pending (debounced, unsaved) highlight must be written on unload
				const sp = spans(v, v.debugSession.viewer.currentPageNumber);
				select(sp[3], 0, sp[3]);
				const [id] = v.highlights.createFromSelection("#ffd400");
				// every worker penDF started in this run ("pendf-worker"; it may already be running for a tab
				// Obsidian restored, and is shared): other blob workers are the harness's own pdf.js probe (D-37)
				const ours = workers.filter((w) => w.name === "pendf-worker");
				const urls = [...new Set(ours.map((w) => w.url))];
				const logBefore = (P()?.getLogText?.() ?? "").split(String.fromCharCode(10)).filter((l) => /worker|main-thread|opened/.test(l)).slice(-6).map((l) => l.slice(0, 160));
				await app.plugins.disablePlugin(ID);
				await sleep(1500);
				const leftovers = document.querySelectorAll(".pendf-view, .pendf-root, .pendf-floating, .pendf-layer-host, .pendf-hud").length;
				const revoked = [];
				for (const u of urls) {
					try {
						await fetch(u);
						revoked.push(false);
					} catch {
						revoked.push(true);
					}
				}
				const saved = JSON.parse(await ad.read(FIX + "a4.pdf.pendf.json")).annotations.some((a) => a.id === id);
				const styleLeft = [...document.querySelectorAll("style")].some((s) => s.textContent.includes(".pendf-root"));
				const res = {
					leaves: app.workspace.getLeavesOfType(VIEW).length,
					leftovers,
					workers: ours.length,
					allTerminated: ours.every((w) => w.terminated),
					blobWorkersInRun: workers.filter((w) => w.url.startsWith("blob:")).length,
					unterminatedInRun: workers.filter((w) => w.url.startsWith("blob:") && !w.terminated).length,
					workerLog: logBefore,
					workerKinds: workers.map((w) => [w.url.slice(0, 12), !!w.terminated]),
					nativeWorker: String(window.Worker).includes("native code"),
					blobRevoked: revoked,
					pendingHighlightSaved: saved,
					styleLeft,
				};
				await app.plugins.enablePlugin(ID);
				// Obsidian keeps the tab (it remembers the view type for when the plugin returns); none of our DOM may remain
				res.ok = leftovers === 0 && ours.length > 0 && res.allTerminated && revoked.every(Boolean) && saved && !styleLeft;
				return res;
			});

			// Clean-realm check: the main window already carries polyfills from
			// other plugins (and earlier legacy builds), so only a fresh iframe
			// realm can show what our pdf.js does. Load the transformed modern
			// build there, render fixtures through a real worker AND the
			// main-thread fallback, and diff every built-in by identity.
			await check("pdfjs-footprint", async () => {
				const fs = require("fs");
				const src = fs.readFileSync(cfg.probeBundle, "utf8");
				const workerSrc = fs.readFileSync(cfg.probeWorker, "utf8");
				const files = {};
				for (const n of ["a4.pdf", "korean-embedded.pdf", "rotations.pdf", "cropbox.pdf"]) files[n] = new Uint8Array(fs.readFileSync(cfg.fixturesDir + "/" + n));
				const frame = document.createElement("iframe");
				frame.style.display = "none";
				document.body.appendChild(frame);
				try {
					const w = frame.contentWindow;
					// hidden iframe: rAF never fires; shim it *before* the baseline snapshot
					w.requestAnimationFrame = (cb) => w.setTimeout(() => cb(w.performance.now()), 16);
					w.cancelAnimationFrame = (id) => w.clearTimeout(id);
					const NAMES = ["Object", "Function", "Array", "Map", "WeakMap", "Set", "WeakSet", "Promise", "Math", "RegExp", "String", "Number", "Boolean", "Symbol", "JSON", "Reflect", "ArrayBuffer", "SharedArrayBuffer", "DataView", "Uint8Array", "Uint8ClampedArray", "Int32Array", "Float32Array", "Float64Array", "Iterator", "AbortSignal", "AbortController", "URL", "Blob", "Response", "TextDecoder", "Error", "TypeError", "AggregateError", "Intl", "Date", "Atomics", "WeakRef", "FinalizationRegistry", "Proxy", "Worker", "Path2D", "DOMMatrix", "OffscreenCanvas", "CanvasRenderingContext2D", "FontFace", "Document", "Element", "HTMLCanvasElement", "EventTarget", "MessagePort"];
					const snap = () => {
						const out = {};
						const add = (label, obj) => {
							if (!obj) return;
							for (const k of Reflect.ownKeys(obj)) {
								const d = Object.getOwnPropertyDescriptor(obj, k);
								// identities, not source text: core-js patches Function#toString
								// so that its polyfills print "[native code]"
								out[`${label}.${String(k)}`] = d.value ?? d.get;
							}
						};
						for (const n of NAMES) {
							add(n, w[n]);
							if (w[n] && w[n].prototype) add(n + ".prototype", w[n].prototype);
						}
						for (const k of Object.getOwnPropertyNames(w)) out[`globalThis.${k}`] = w[k];
						return out;
					};
					const before = snap();
					w.eval(src);
					// copy the bytes into the iframe realm
					const inRealm = {};
					for (const [k, v] of Object.entries(files)) {
						inRealm[k] = new w.Uint8Array(v.length);
						inRealm[k].set(v);
					}
					const viaWorker = await w.__pendfProbe(inRealm, workerSrc, "web-worker");
					const viaMainThread = await w.__pendfProbe(inRealm, workerSrc, "main-thread");
					const after = snap();
					const added = [], replaced = [], removed = [];
					for (const [k, v] of Object.entries(after)) {
						if (!(k in before)) added.push(k);
						else if (before[k] !== v && (typeof before[k] === "function" || typeof v === "function")) replaced.push(k);
					}
					for (const k of Object.keys(before)) if (!(k in after)) removed.push(k);
					const ownAdded = added.filter((k) => k !== "globalThis.__pendfProbe");
					const rendersOk = (r) => Object.values(r).every((x) => x.rendered > 0 && x.ops > 0) && r["korean-embedded.pdf"].text > 0;
					return {
						viaWorker,
						viaMainThread,
						added: ownAdded,
						replaced,
						removed,
						ok: ownAdded.length === 0 && replaced.length === 0 && removed.length === 0 && rendersOk(viaWorker) && rendersOk(viaMainThread),
					};
				} finally {
					frame.remove();
				}
			});

			return { env, checks };
		};

		run()
			.then((r) => (H.result = r))
			.catch((e) => {
				H.error = String((e && e.stack) || e);
				H.result = { checks, error: H.error };
			})
			.finally(() => {
				H.teardown();
				H.step = "done";
				H.done = true;
			});
	},
});
