import { describe, expect, it } from "vitest";
import { aliasFrom, buildSubpath, linkAt, parseSubpath, splitLinktext } from "../src/links/format";

describe("subpath", () => {
	it("builds page, id and rect parameters", () => {
		expect(buildSubpath({ page: 3 })).toBe("#page=3");
		expect(buildSubpath({ page: 3, id: "5f0c-ab_1" })).toBe("#page=3&pendf=5f0c-ab_1");
		expect(buildSubpath({ page: 2, rect: [72.04, 700.26, 300, 680.5] })).toBe("#page=2&pendf-rect=72,700.3,300,680.5");
		expect(buildSubpath({})).toBe("");
	});
	it("refuses ids that could break the link", () => {
		expect(buildSubpath({ page: 1, id: "a|b]]" })).toBe("#page=1");
	});
	it("round-trips and normalizes the rect", () => {
		const s = buildSubpath({ page: 4, id: "abc", rect: [300, 700, 72, 680] });
		expect(parseSubpath(s)).toEqual({ page: 4, id: "abc", rect: [72, 680, 300, 700] });
	});
	it("ignores unknown and malformed parameters", () => {
		expect(parseSubpath("#page=7&rect=1,2,3,4&color=red")).toEqual({ page: 7 });
		expect(parseSubpath("page=0&pendf=&pendf-rect=1,2,x,4")).toEqual({});
		expect(parseSubpath("#page=2.5")).toEqual({});
		expect(parseSubpath("")).toEqual({});
	});
	it("splits path and subpath", () => {
		expect(splitLinktext("dir/a b.pdf#page=2&pendf=x")).toEqual({ path: "dir/a b.pdf", subpath: "#page=2&pendf=x" });
		expect(splitLinktext("a.pdf")).toEqual({ path: "a.pdf", subpath: "" });
	});
});

describe("linkAt", () => {
	const line = "See [[Papers/x.pdf#page=3&pendf=ab|quote]] and [md](Papers/y%20z.pdf#page=9) or [[Other]] https://e.x";
	it("finds the wikilink under the cursor, without its alias", () => {
		expect(linkAt(line, line.indexOf("quote"))).toBe("Papers/x.pdf#page=3&pendf=ab");
		expect(linkAt(line, line.indexOf("[["))).toBe("Papers/x.pdf#page=3&pendf=ab");
	});
	it("finds a Markdown link and decodes it", () => {
		expect(linkAt(line, line.indexOf("[md]") + 2)).toBe("Papers/y z.pdf#page=9");
	});
	it("returns null between links and for external URLs", () => {
		expect(linkAt(line, 1)).toBeNull();
		expect(linkAt("[site](https://example.com/a.pdf)", 3)).toBeNull();
	});
	it("handles embeds and angle-bracket targets", () => {
		expect(linkAt("![[a.pdf#page=2]]", 4)).toBe("a.pdf#page=2");
		expect(linkAt("[x](<my doc.pdf#page=4>)", 2)).toBe("my doc.pdf#page=4");
	});
});

describe("aliasFrom", () => {
	it("makes a one-line alias without link-breaking characters", () => {
		expect(aliasFrom("  multi\nline [text] | with # and ^ ")).toBe("multi line text with and");
		expect(aliasFrom("x".repeat(80), 10)).toBe("xxxxxxxxx…");
	});
});
