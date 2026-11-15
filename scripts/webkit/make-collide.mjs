// Test PDF for the B-06 namespace check: one page whose first font is an
// *embedded* TrueType font different from korean-embedded.pdf's, so that both
// pdf.js copies would register a FontFace named g_d0_f1 for different fonts.
// Written to scripts/webkit/out/ (not a shipped fixture).
import { PDFDocument } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { root } from "../build-lib.mjs";

const candidates = [
	process.env.PENDF_COLLIDE_FONT,
	"C:/Windows/Fonts/arial.ttf",
	"C:/Windows/Fonts/times.ttf",
	"/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
	"/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
	"/System/Library/Fonts/Supplemental/Arial.ttf",
].filter(Boolean);
const fontPath = candidates.find((p) => existsSync(p));
if (!fontPath) {
	console.log("make-collide: no TrueType font found; skipping");
	process.exit(0);
}
const doc = await PDFDocument.create();
doc.registerFontkit(fontkit);
const font = await doc.embedFont(readFileSync(fontPath), { subset: true });
const page = doc.addPage([595.28, 841.89]);
page.drawText("Embedded font collision test — glyphs must not change", { x: 56, y: 760, size: 18, font });
for (let i = 0; i < 20; i++) page.drawText(`Line ${i + 1}: The quick brown fox jumps over the lazy dog 0123456789`, { x: 56, y: 720 - i * 22, size: 12, font });
const out = path.join(root, "scripts", "webkit", "out");
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, "collide-embedded.pdf"), await doc.save({ useObjectStreams: false }));
console.log(`make-collide: ${path.basename(fontPath)} → scripts/webkit/out/collide-embedded.pdf`);
