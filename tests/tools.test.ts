import { describe, expect, it } from "vitest";
import { DEFAULT_HIGHLIGHTER_OPACITY, afterOneShot, fingerUsesTool, hasOptions, isInkTool, isToolId, normalizeOpacity, pencilAction } from "../src/tools/model";
import { validateAnnotation, type InkAnnotation } from "../src/store/schema";
import * as v073 from "./compat/v073/schema";

describe("tool palette model (D-46)", () => {
	it("the Pencil follows the selected tool", () => {
		expect(pencilAction("area", true, "pen")).toBe("area");
		expect(pencilAction("text", false, "pen")).toBe("text");
		expect(pencilAction("eraser", false, "pen")).toBe("eraser");
	});
	it("with no tool, the Pencil writes with the last ink tool only if “always writes” is on", () => {
		expect(pencilAction("none", true, "highlighter")).toBe("highlighter");
		expect(pencilAction("none", false, "highlighter")).toBe("none");
	});
	it("knows tools, ink tools, options and one-shot tools", () => {
		expect(isToolId("pen")).toBe(true);
		expect(isToolId("lasso")).toBe(false);
		expect(isInkTool("eraser")).toBe(true);
		expect(isInkTool("text")).toBe(false);
		expect(hasOptions("pen") && hasOptions("text") && hasOptions("area")).toBe(true);
		expect(hasOptions("none") || hasOptions("note") || hasOptions("eraser")).toBe(false);
		expect(afterOneShot("note")).toBe("none");
		expect(afterOneShot("pen")).toBe("pen");
	});
	it("fingers use a tool only in “Everything writes”, never the text tool", () => {
		expect(fingerUsesTool("pen", "stylus")).toBe(false);
		expect(fingerUsesTool("area", "stylus")).toBe(false);
		expect(fingerUsesTool("area", "exclusive")).toBe(true);
		expect(fingerUsesTool("text", "exclusive")).toBe(false);
	});
	it("normalizes the highlighter opacity", () => {
		expect(normalizeOpacity(0.5)).toBe(0.5);
		expect(normalizeOpacity(0)).toBe(DEFAULT_HIGHLIGHTER_OPACITY);
		expect(normalizeOpacity("x")).toBe(DEFAULT_HIGHLIGHTER_OPACITY);
	});
});

describe("ink opacity in the sidecar", () => {
	const ink: InkAnnotation = { id: "i", type: "ink", page: 1, createdAt: 1, updatedAt: 1, deleted: false, tool: "highlighter", color: "#ffd400", width: 12, points: [1, 2, 3, 4], opacity: 0.5 };
	it("validates the optional opacity", () => {
		expect(validateAnnotation(ink)).toBeNull();
		expect(validateAnnotation({ ...ink, opacity: undefined })).toBeNull();
		expect(validateAnnotation({ ...ink, opacity: 2 })).toBe("opacity");
		expect(validateAnnotation({ ...ink, opacity: 0 })).toBe("opacity");
	});
	it("0.7.3 still reads such a stroke (it keeps the extra field)", () => {
		expect(v073.validateAnnotation(ink)).toBeNull();
		const r = v073.parseSidecar({ schemaVersion: 1, pdfFingerprint: "fp", annotations: [ink] });
		expect(r.sidecar.annotations[0]).toEqual(ink);
	});
});
