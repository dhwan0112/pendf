// The bottom tool palette ("pencil case", D-46). Pure — no DOM.
//
// One tool is selected at a time. It decides what the Pencil does; fingers keep
// scrolling, selecting and pinching (except in "Everything writes" ink input mode).

export type ToolId = "none" | "pen" | "highlighter" | "eraser" | "text" | "area" | "note";
export type InkToolId = "pen" | "highlighter" | "eraser";

export const TOOL_IDS: readonly ToolId[] = ["none", "pen", "highlighter", "eraser", "text", "area", "note"];

export function isToolId(v: unknown): v is ToolId {
	return typeof v === "string" && (TOOL_IDS as readonly string[]).includes(v);
}

export function isInkTool(t: ToolId): t is InkToolId {
	return t === "pen" || t === "highlighter" || t === "eraser";
}

/** Tools whose button opens an options popover when pressed again. */
export function hasOptions(t: ToolId): boolean {
	return t === "pen" || t === "highlighter" || t === "text" || t === "area";
}

export type PenToolId = "pen" | "highlighter";

/**
 * What the Pencil does with `tool` selected. With no tool and "Apple Pencil always writes"
 * on, it writes with the last pen tool (pen or highlighter — never the eraser); with it off,
 * it behaves like a finger.
 */
export function pencilAction(tool: ToolId, pencilAlways: boolean, lastPen: PenToolId): ToolId {
	if (tool !== "none") return tool;
	return pencilAlways ? lastPen : "none";
}

/** Fingers use the selected tool only in "Everything writes" input mode (and never the text tool). */
export function fingerUsesTool(tool: ToolId, input: "stylus" | "exclusive"): boolean {
	return input === "exclusive" && (isInkTool(tool) || tool === "area");
}

/** Tool to come back to after a one-shot tool (placing a note) is done. */
export function afterOneShot(previous: ToolId): ToolId {
	return previous === "note" ? "none" : previous;
}

export const HIGHLIGHTER_OPACITIES = [0.25, 0.35, 0.5] as const;
export const DEFAULT_HIGHLIGHTER_OPACITY = 0.35;

export function normalizeOpacity(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_HIGHLIGHTER_OPACITY;
}

/** The palette shows text labels next to the icons when the page area is at least this wide (px). */
export const LABELS_MIN_WIDTH = 720;
