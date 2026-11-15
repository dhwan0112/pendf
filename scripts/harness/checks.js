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
				const rec = { url: String(url), terminated: false };
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
			await waitFor(() => P());
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
			await leaf.setViewState({ type: VIEW, state: { file: FIX + name, ...state }, active: true });
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
				await P().openPdf(file("a4.pdf"), true);
				const v3 = app.workspace.getLeavesOfType(VIEW)[0].view;
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
				await waitText(v, 1);
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
				await P().showAnnotationsPanel();
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
						const r = { page: ss.viewer.currentPageNumber, popover: ss.notes.popoverEl?.querySelector("strong")?.textContent ?? null };
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
						const r = { page: ss.viewer.currentPageNumber, flash: !!ss.layers.getLayer(12)?.overlay.querySelector(".pendf-flash") };
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
						res.editor.page === 9 && res.editor.popover === "note" &&
						res.rect.page === 12 && res.rect.flash &&
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
				await P().showAnnotationsPanel("outline");
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
				await P().showAnnotationsPanel("pages");
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
				await P().showAnnotationsPanel("search");
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
					await waitFor(() => P());
					const { v } = await openPenDF("a4.pdf");
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
					await waitFor(() => P());
				}
			});

			await check("unload-cleanup", async () => {
				const { v } = await openPenDF("a4.pdf");
				await waitText(v, v.debugSession.viewer.currentPageNumber);
				// a pending (debounced, unsaved) highlight must be written on unload
				const sp = spans(v, v.debugSession.viewer.currentPageNumber);
				select(sp[3], 0, sp[3]);
				const [id] = v.highlights.createFromSelection("#ffd400");
				const ours = workers.filter((w) => w.url.startsWith("blob:"));
				const urls = [...new Set(ours.map((w) => w.url))];
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
