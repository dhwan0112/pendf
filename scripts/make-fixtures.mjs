#!/usr/bin/env node
// Generate deterministic test PDFs into fixtures/out/ (gitignored).
//
//   node scripts/make-fixtures.mjs [--out dir] [--korean-font path.ttf]
//
// Fixtures:
//   a4.pdf               3 A4 pages, non-embedded standard fonts (Helvetica/Times)
//   letter.pdf           2 US Letter pages
//   rotations.pdf        4 pages with /Rotate 0, 90, 180, 270
//   cropbox.pdf          CropBox ≠ MediaBox (offset origin)
//   two-column.pdf       2-column body text
//   korean-cmap.pdf      Korean text in a NON-embedded CID font (UniKS-UCS2-H) —
//                        renders only if the CMaps are available
//   korean-embedded.pdf  Korean text in an embedded subset font (needs a Hangul
//                        TTF/OTF; auto-detected on Windows/Ubuntu/macOS)
//   links.pdf            internal GoTo links between pages + one URI link
//   long-300.pdf         300 pages, page 1 = table of contents with links;
//                        document outline: 30 chapters × 2 sections (chapter 30 via a named destination)
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	PDFDocument,
	PDFName,
	PDFString,
	PDFHexString,
	StandardFonts,
	rgb,
	degrees,
	PageSizes,
	beginText,
	endText,
	setFontAndSize,
	moveText,
	showText,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (k) => {
	const i = args.indexOf(k);
	return i >= 0 ? args[i + 1] : undefined;
};
const outDir = path.resolve(argVal("--out") ?? path.join(root, "fixtures", "out"));
mkdirSync(outDir, { recursive: true });

const EPOCH = new Date("2026-01-01T00:00:00Z");

// Ground truth for highlight tests: where known text lines were drawn
// (PDF user space, baseline y, advance width from the font metrics).
const expected = {};
function expect(file, page, text, x, baseline, size, font) {
	(expected[file] ??= []).push({ page, text, x, baseline, size, width: font.widthOfTextAtSize(text, size) });
}

async function newDoc(title) {
	const doc = await PDFDocument.create();
	doc.setTitle(title);
	doc.setAuthor("pendf fixtures");
	doc.setProducer("pendf make-fixtures");
	doc.setCreator("pendf make-fixtures");
	doc.setCreationDate(EPOCH);
	doc.setModificationDate(EPOCH);
	return doc;
}

async function save(doc, name) {
	const bytes = await doc.save({ useObjectStreams: false });
	writeFileSync(path.join(outDir, name), bytes);
	console.log(`${name.padEnd(22)} ${(bytes.length / 1024).toFixed(1).padStart(7)} KB  ${doc.getPageCount()} page(s)`);
}

// deterministic pseudo-text
const WORDS = (
	"the quick brown fox jumps over a lazy dog while seven wizards quietly box " +
	"jackdaws in a frozen lake of liquid helium measured with careful precision " +
	"electrons orbit nuclei and molecules vibrate at characteristic frequencies " +
	"spectra reveal structure through peaks whose positions encode bonding"
).split(" ");
function* rng(seed) {
	let s = seed >>> 0;
	for (;;) {
		s = (s * 1664525 + 1013904223) >>> 0;
		yield s;
	}
}
function sentence(gen, n) {
	const w = [];
	for (let i = 0; i < n; i++) w.push(WORDS[gen.next().value % WORDS.length]);
	w[0] = w[0][0].toUpperCase() + w[0].slice(1);
	return w.join(" ") + ".";
}
function wrap(text, font, size, width) {
	const lines = [];
	let line = "";
	for (const word of text.split(" ")) {
		const t = line ? line + " " + word : word;
		if (font.widthOfTextAtSize(t, size) > width && line) {
			lines.push(line);
			line = word;
		} else line = t;
	}
	if (line) lines.push(line);
	return lines;
}
function paragraph(page, font, text, x, y, width, size = 11, lead = 1.4) {
	for (const l of wrap(text, font, size, width)) {
		page.drawText(l, { x, y, size, font, color: rgb(0.1, 0.1, 0.1) });
		y -= size * lead;
	}
	return y;
}

async function a4() {
	const doc = await newDoc("A4 fixture");
	const helv = await doc.embedFont(StandardFonts.Helvetica);
	const times = await doc.embedFont(StandardFonts.TimesRoman);
	const bold = await doc.embedFont(StandardFonts.HelveticaBold);
	const gen = rng(1);
	for (let p = 1; p <= 3; p++) {
		const page = doc.addPage(PageSizes.A4);
		const { width, height } = page.getSize();
		page.drawText(`A4 fixture — page ${p}`, { x: 56, y: height - 72, size: 20, font: bold });
		let y = height - 110;
		for (let i = 0; i < 8; i++) {
			y = paragraph(page, i % 2 ? times : helv, Array.from({ length: 4 }, () => sentence(gen, 12)).join(" "), 56, y, width - 112) - 10;
		}
		page.drawText(`p. ${p}`, { x: width / 2 - 10, y: 30, size: 9, font: helv });
	}
	await save(doc, "a4.pdf");
}

async function letter() {
	const doc = await newDoc("Letter fixture");
	const helv = await doc.embedFont(StandardFonts.Helvetica);
	const gen = rng(2);
	for (let p = 1; p <= 2; p++) {
		const page = doc.addPage(PageSizes.Letter);
		const { width, height } = page.getSize();
		page.drawText(`US Letter — page ${p}`, { x: 72, y: height - 72, size: 18, font: helv });
		let y = height - 108;
		for (let i = 0; i < 6; i++) y = paragraph(page, helv, Array.from({ length: 5 }, () => sentence(gen, 10)).join(" "), 72, y, width - 144) - 10;
	}
	await save(doc, "letter.pdf");
}

async function rotations() {
	const doc = await newDoc("Rotation fixture");
	const helv = await doc.embedFont(StandardFonts.Helvetica);
	const bold = await doc.embedFont(StandardFonts.HelveticaBold);
	const gen = rng(3);
	for (const r of [0, 90, 180, 270]) {
		const page = doc.addPage(PageSizes.A4);
		page.setRotation(degrees(r));
		const { width, height } = page.getSize();
		page.drawText(`/Rotate ${r}`, { x: 56, y: height - 72, size: 24, font: bold });
		const marker = "This line is near the top-left corner of the unrotated page.";
		page.drawText(marker, { x: 56, y: height - 104, size: 12, font: helv });
		expect("rotations.pdf", doc.getPageCount(), marker, 56, height - 104, 12, helv);
		let y = height - 140;
		for (let i = 0; i < 6; i++) y = paragraph(page, helv, Array.from({ length: 3 }, () => sentence(gen, 11)).join(" "), 56, y, width - 112) - 8;
		page.drawRectangle({ x: 20, y: 20, width: 40, height: 40, color: rgb(0.9, 0.2, 0.2) });
		page.drawText("origin", { x: 22, y: 64, size: 8, font: helv });
	}
	await save(doc, "rotations.pdf");
}

async function cropbox() {
	const doc = await newDoc("CropBox fixture");
	const helv = await doc.embedFont(StandardFonts.Helvetica);
	const gen = rng(4);
	const page = doc.addPage([612, 792]);
	page.setCropBox(100, 150, 400, 550); // x, y, width, height → [100 150 500 700]
	page.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(1, 0.85, 0.85) });
	page.drawRectangle({ x: 100, y: 150, width: 400, height: 550, color: rgb(1, 1, 1) });
	page.drawText("Inside the CropBox [100 150 500 700]", { x: 110, y: 680, size: 14, font: helv });
	expect("cropbox.pdf", 1, "Inside the CropBox [100 150 500 700]", 110, 680, 14, helv);
	let y = 650;
	for (let i = 0; i < 10; i++) y = paragraph(page, helv, sentence(gen, 14) + " " + sentence(gen, 9), 110, y, 380) - 8;
	page.drawText("OUTSIDE (should be cropped)", { x: 10, y: 20, size: 14, font: helv });
	await save(doc, "cropbox.pdf");
}

async function twoColumn() {
	const doc = await newDoc("Two-column fixture");
	const helv = await doc.embedFont(StandardFonts.Helvetica);
	const bold = await doc.embedFont(StandardFonts.HelveticaBold);
	const gen = rng(5);
	for (let p = 1; p <= 2; p++) {
		const page = doc.addPage(PageSizes.A4);
		const { width, height } = page.getSize();
		page.drawText(`Two-column layout — page ${p}`, { x: 56, y: height - 66, size: 16, font: bold });
		const colW = (width - 112 - 24) / 2;
		for (const [ci, x] of [56, 56 + colW + 24].entries()) {
			let y = height - 100;
			for (let i = 0; i < 9; i++) y = paragraph(page, helv, `[${p}.${ci + 1}.${i + 1}] ` + Array.from({ length: 3 }, () => sentence(gen, 9)).join(" "), x, y, colW, 10, 1.35) - 8;
		}
	}
	await save(doc, "two-column.pdf");
}

function ucs2Hex(s) {
	return Array.from(s)
		.map((ch) => ch.codePointAt(0).toString(16).padStart(4, "0"))
		.join("")
		.toUpperCase();
}

async function koreanCMap() {
	const doc = await newDoc("Korean (CMap) fixture");
	const ctx = doc.context;
	const fd = ctx.register(
		ctx.obj({
			Type: "FontDescriptor",
			FontName: "HYSMyeongJo-Medium",
			Flags: 6,
			FontBBox: [-0, -148, 1001, 880],
			ItalicAngle: 0,
			Ascent: 880,
			Descent: -120,
			CapHeight: 880,
			StemV: 93,
		}),
	);
	const cid = ctx.register(
		ctx.obj({
			Type: "Font",
			Subtype: "CIDFontType0",
			BaseFont: "HYSMyeongJo-Medium",
			CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Korea1"), Supplement: 2 },
			FontDescriptor: fd,
			DW: 1000,
		}),
	);
	const font = ctx.register(
		ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: "HYSMyeongJo-Medium", Encoding: "UniKS-UCS2-H", DescendantFonts: [cid] }),
	);
	const lines = [
		"한국어 CMap 테스트 문서입니다.",
		"이 글꼴은 PDF에 들어 있지 않습니다.",
		"CMap이 없으면 글자가 보이지 않거나 깨집니다.",
		"하이라이트: 가나다라마바사 아자차카타파하",
		"두 번째 문단은 여러 줄에 걸쳐 있습니다.",
	];
	for (let p = 1; p <= 2; p++) {
		const page = doc.addPage(PageSizes.A4);
		page.node.setFontDictionary(PDFName.of("FK"), font);
		const ops = [beginText(), setFontAndSize("FK", 18), moveText(56, 760)];
		for (const [i, l] of lines.entries()) {
			if (i > 0) ops.push(moveText(0, -32));
			ops.push(showText(PDFHexString.of(ucs2Hex(`${p}-${i + 1}. ${l}`))));
		}
		ops.push(endText());
		page.pushOperators(...ops);
	}
	await save(doc, "korean-cmap.pdf");
}

function findKoreanFont() {
	// PENDF_NO_HANGUL_FONT=1 simulates a machine without Hangul fonts (CI path check)
	if (process.env.PENDF_NO_HANGUL_FONT === "1") return undefined;
	const explicit = argVal("--korean-font");
	const candidates = [
		explicit,
		"C:/Windows/Fonts/NanumGothic.ttf",
		"C:/Windows/Fonts/malgun.ttf",
		"/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
		"/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
		"/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
		"/System/Library/Fonts/AppleSDGothicNeo.ttc",
	].filter(Boolean);
	return candidates.find((p) => existsSync(p));
}

/**
 * fontkit for pdf-lib that accepts font *collections* (.ttc/.otc, e.g. Ubuntu's
 * NotoSansCJK-Regular.ttc): fontkit returns a collection object for those,
 * which pdf-lib cannot subset. Pick one face — a Korean one (PostScript name
 * with "KR") if there is one, else the first — and hand pdf-lib that font.
 */
export const collectionAwareFontkit = {
	...fontkit,
	create(buffer, postscriptName) {
		const f = fontkit.create(buffer, postscriptName);
		if (postscriptName || !Array.isArray(f?.fonts)) return f;
		const faces = f.fonts;
		const face = faces.find((x) => /KR/.test(x.postscriptName ?? "")) ?? faces[0];
		console.log(`  font collection with ${faces.length} faces: using ${face.postscriptName}`);
		return fontkit.create(buffer, face.postscriptName);
	},
};

async function koreanEmbedded() {
	const fontPath = findKoreanFont();
	if (!fontPath) return { skipped: "no Hangul font found (install fonts-noto-cjk / fonts-nanum, or pass --korean-font <file>)" };
	console.log(`  Hangul font: ${fontPath}`);
	const doc = await newDoc("Korean (embedded) fixture");
	doc.registerFontkit(collectionAwareFontkit);
	const font = await doc.embedFont(readFileSync(fontPath), { subset: true });
	const gen = rng(6);
	const text =
		"물리화학은 분자의 구조와 에너지, 그리고 반응 속도를 다룬다. 분광학은 빛과 물질의 상호작용을 통해 분자의 성질을 밝혀낸다. " +
		"이 문단은 여러 줄에 걸쳐 있어서 줄 단위 하이라이트 병합을 확인하기에 알맞다. 한글과 English 단어가 섞인 문장도 있다.";
	for (let p = 1; p <= 2; p++) {
		const page = doc.addPage(PageSizes.A4);
		const { width, height } = page.getSize();
		page.drawText(`한국어 임베디드 글꼴 — ${p}쪽`, { x: 56, y: height - 72, size: 18, font });
		let y = height - 110;
		for (let i = 0; i < 5; i++) y = paragraph(page, font, text + " " + sentence(gen, 6), 56, y, width - 112, 12, 1.6) - 12;
	}
	await save(doc, "korean-embedded.pdf");
}

function addLink(doc, page, rect, action) {
	const ctx = doc.context;
	const annot = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: rect, Border: [0, 0, 0], ...action }));
	const annots = page.node.lookup(PDFName.of("Annots"));
	if (annots) annots.push(annot);
	else page.node.set(PDFName.of("Annots"), ctx.obj([annot]));
}

function goTo(doc, targetPage) {
	return { Dest: [targetPage.ref, "XYZ", null, null, null] };
}

async function links() {
	const doc = await newDoc("Links fixture");
	const helv = await doc.embedFont(StandardFonts.Helvetica);
	const pages = [1, 2, 3].map(() => doc.addPage(PageSizes.A4));
	pages.forEach((p, i) => p.drawText(`Links fixture — page ${i + 1}`, { x: 56, y: 780, size: 18, font: helv }));
	const blue = rgb(0.1, 0.3, 0.9);
	pages[0].drawText("Go to page 2", { x: 56, y: 700, size: 14, font: helv, color: blue });
	addLink(doc, pages[0], [54, 695, 150, 715], goTo(doc, pages[1]));
	pages[0].drawText("Go to page 3", { x: 56, y: 670, size: 14, font: helv, color: blue });
	addLink(doc, pages[0], [54, 665, 150, 685], goTo(doc, pages[2]));
	pages[0].drawText("External: https://example.com", { x: 56, y: 640, size: 14, font: helv, color: blue });
	addLink(doc, pages[0], [54, 635, 260, 655], { A: { S: "URI", URI: PDFString.of("https://example.com/") } });
	pages[2].drawText("Back to page 1", { x: 56, y: 700, size: 14, font: helv, color: blue });
	addLink(doc, pages[2], [54, 695, 160, 715], goTo(doc, pages[0]));
	await save(doc, "links.pdf");
}

/**
 * Document outline (the PDF's own bookmarks). entries: [{ title, dest, children? }]
 * where dest is a PDFPage (explicit destination) or a string (named destination).
 */
function addOutline(doc, entries) {
	const ctx = doc.context;
	const destOf = (d) => (typeof d === "string" ? PDFName.of(d) : ctx.obj([d.ref, "XYZ", null, null, null]));
	const build = (list, parentRef) => {
		const refs = list.map(() => ctx.nextRef());
		let total = 0;
		list.forEach((e, i) => {
			const dict = { Title: PDFHexString.fromText(e.title), Parent: parentRef, Dest: destOf(e.dest) };
			if (i > 0) dict.Prev = refs[i - 1];
			if (i < list.length - 1) dict.Next = refs[i + 1];
			if (e.children?.length) {
				const sub = build(e.children, refs[i]);
				dict.First = sub.refs[0];
				dict.Last = sub.refs[sub.refs.length - 1];
				dict.Count = -sub.total; // closed by default
				total += sub.total;
			}
			ctx.assign(refs[i], ctx.obj(dict));
			total += 1;
		});
		return { refs, total };
	};
	const rootRef = ctx.nextRef();
	const top = build(entries, rootRef);
	ctx.assign(rootRef, ctx.obj({ Type: "Outlines", First: top.refs[0], Last: top.refs[top.refs.length - 1], Count: top.total }));
	doc.catalog.set(PDFName.of("Outlines"), rootRef);
}

async function long300() {
	const doc = await newDoc("300-page fixture");
	const helv = await doc.embedFont(StandardFonts.Helvetica);
	const bold = await doc.embedFont(StandardFonts.HelveticaBold);
	const gen = rng(7);
	const pages = [];
	for (let p = 1; p <= 300; p++) {
		const page = doc.addPage(PageSizes.A4);
		pages.push(page);
		const { width, height } = page.getSize();
		if (p === 1) {
			page.drawText("300-page fixture — contents", { x: 56, y: height - 72, size: 20, font: bold });
			continue;
		}
		page.drawText(`Chapter ${Math.ceil(p / 10)} · page ${p}`, { x: 56, y: height - 72, size: 16, font: bold });
		let y = height - 104;
		for (let i = 0; i < 5; i++) y = paragraph(page, helv, Array.from({ length: 4 }, () => sentence(gen, 10)).join(" "), 56, y, width - 112, 10.5) - 8;
		page.drawText(String(p), { x: width / 2 - 8, y: 30, size: 10, font: helv });
	}
	// TOC on page 1 linking to every 10th page
	const toc = pages[0];
	for (let k = 0; k < 30; k++) {
		const target = Math.min(300, k * 10 + 2);
		const x = 56 + (k % 2) * 250;
		const y = 740 - Math.floor(k / 2) * 22;
		toc.drawText(`Chapter ${k + 1} … p. ${target}`, { x, y, size: 12, font: helv, color: rgb(0.1, 0.3, 0.9) });
		addLink(doc, toc, [x - 2, y - 4, x + 180, y + 14], goTo(doc, pages[target - 1]));
	}
	// outline: chapter k starts on page 10k-8 (k ≥ 2; chapter 1 = page 2), sections a few pages in
	const chapters = [];
	for (let k = 1; k <= 30; k++) {
		const start = Math.min(300, (k - 1) * 10 + 2);
		chapters.push({
			title: `Chapter ${k}`,
			dest: k === 30 ? "chapter-30" : pages[start - 1],
			children: [
				{ title: `${k}.1 Introduction`, dest: pages[Math.min(299, start)] },
				{ title: `${k}.2 Results`, dest: pages[Math.min(299, start + 4)] },
			],
		});
	}
	doc.catalog.set(PDFName.of("Dests"), doc.context.obj({ "chapter-30": doc.context.obj([pages[291].ref, "XYZ", null, null, null]) }));
	addOutline(doc, chapters);
	await save(doc, "long-300.pdf");
}

// Each fixture on its own: one failure must not stop the others. The outcome
// goes to manifest.json, which tests/global-setup.mjs reads.
const FIXTURES = [
	["a4.pdf", a4],
	["letter.pdf", letter],
	["rotations.pdf", rotations],
	["cropbox.pdf", cropbox],
	["two-column.pdf", twoColumn],
	["korean-cmap.pdf", koreanCMap],
	["korean-embedded.pdf", koreanEmbedded],
	["links.pdf", links],
	["long-300.pdf", long300],
];
const manifest = { made: [], skipped: {}, failed: {} };
for (const [name, make] of FIXTURES) {
	try {
		const r = await make();
		if (r?.skipped) {
			manifest.skipped[name] = r.skipped;
			console.log(`${name.padEnd(22)} skipped: ${r.skipped}`);
		} else manifest.made.push(name);
	} catch (e) {
		const why = String(e?.stack ?? e).split("\n").slice(0, 3).join(" | ");
		manifest.failed[name] = why;
		console.error(`${name.padEnd(22)} FAILED: ${why}`);
	}
}
writeFileSync(path.join(outDir, "expected.json"), JSON.stringify(expected, null, 2) + "\n");
writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`→ ${outDir}  (${manifest.made.length} made, ${Object.keys(manifest.skipped).length} skipped, ${Object.keys(manifest.failed).length} failed)`);
if (Object.keys(manifest.failed).length) process.exitCode = 1;
