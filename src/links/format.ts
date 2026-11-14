// Phase 4 — link format. Pure helpers, no DOM / Obsidian.
//
// penDF links are ordinary Obsidian links to the PDF with a subpath:
//   #page=<n>                       the page (Obsidian's own PDF viewer understands this)
//   &pendf=<annotation id>          a highlight or note (penDF only)
//   &pendf-rect=<x0>,<y0>,<x1>,<y1> a text selection, PDF points (penDF only)
// Obsidian's viewer ignores the parameters it does not know and opens the
// page, so links keep working without penDF (verified, DECISIONS D-25).

export interface PdfTarget {
	page?: number;
	/** annotation id */
	id?: string;
	/** PDF user-space box [x0, y0, x1, y1] */
	rect?: [number, number, number, number];
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function buildSubpath(t: PdfTarget): string {
	const parts: string[] = [];
	if (t.page !== undefined) parts.push(`page=${Math.max(1, Math.round(t.page))}`);
	if (t.id !== undefined && ID_RE.test(t.id)) parts.push(`pendf=${t.id}`);
	if (t.rect) parts.push(`pendf-rect=${t.rect.map((v) => (Math.round(v * 10) / 10).toString()).join(",")}`);
	return parts.length ? "#" + parts.join("&") : "";
}

/** Parse "#page=3&pendf=…&pendf-rect=…" (leading "#" optional). Unknown parameters are ignored. */
export function parseSubpath(subpath: string): PdfTarget {
	const out: PdfTarget = {};
	const s = subpath.replace(/^#/, "");
	for (const part of s.split("&")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		const key = part.slice(0, eq).trim();
		const val = decodeSafe(part.slice(eq + 1).trim());
		if (key === "page") {
			const n = Number(val);
			if (Number.isInteger(n) && n >= 1) out.page = n;
		} else if (key === "pendf") {
			if (ID_RE.test(val)) out.id = val;
		} else if (key === "pendf-rect") {
			const nums = val.split(",").map(Number);
			if (nums.length === 4 && nums.every(Number.isFinite)) {
				const [x0, y0, x1, y1] = nums;
				out.rect = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
			}
		}
	}
	return out;
}

function decodeSafe(v: string): string {
	try {
		return decodeURIComponent(v);
	} catch {
		return v;
	}
}

/** Split "path#subpath" (as in a wikilink target, without the alias). */
export function splitLinktext(linktext: string): { path: string; subpath: string } {
	const i = linktext.indexOf("#");
	return i < 0 ? { path: linktext, subpath: "" } : { path: linktext.slice(0, i), subpath: linktext.slice(i) };
}

/**
 * The link target under character `offset` of a Markdown line:
 * `[[target|alias]]`, `![[target]]` or `[text](target)`. Returns the target
 * (path + subpath, URL-decoded for Markdown links) or null.
 */
export function linkAt(line: string, offset: number): string | null {
	const wiki = /!?\[\[([^\]\n]+?)\]\]/g;
	for (let m = wiki.exec(line); m; m = wiki.exec(line)) {
		if (offset >= m.index && offset <= m.index + m[0].length) {
			const inner = m[1];
			const bar = inner.indexOf("|");
			return (bar < 0 ? inner : inner.slice(0, bar)).trim();
		}
	}
	const md = /!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
	for (let m = md.exec(line); m; m = md.exec(line)) {
		if (offset >= m.index && offset <= m.index + m[0].length) {
			let target = m[1];
			if (target.startsWith("<")) target = target.slice(1, -1);
			if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null; // external URL
			return decodeSafe(target);
		}
	}
	return null;
}

/** Safe link alias: one line, no characters that end a wikilink, at most `max` chars. */
export function aliasFrom(text: string, max = 60): string {
	const one = text.replace(/[[\]|#^]/g, " ").replace(/\s+/g, " ").trim();
	return one.length > max ? one.slice(0, max - 1).trimEnd() + "…" : one;
}
