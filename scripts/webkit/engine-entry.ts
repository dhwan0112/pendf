// Engine bundle for the browser smoke tests (scripts/webkit/smoke.mjs).
// Exposes penDF's real PDF engine and highlight geometry code to a plain test
// page — no Obsidian. Built with the same pdf.js plugin as main.js.

import {
	AnnotationMode,
	EventBus,
	PDFFindController,
	PDFLinkService,
	PDFViewer,
	destroyWorker,
	openDocument,
	pdfjsVersion,
	workerMode,
} from "../../src/pdfjs";
import { piecesFromRange } from "../../src/highlight/selection";
import { mergeLineRects } from "../../src/highlight/rects";
import { PageGeometry, type ViewBox } from "../../src/geometry";
import { pageContentRect } from "../../src/layers";
import { ZoomController } from "../../src/zoom/controller";
import { renderArea } from "../../src/area/render";

(window as unknown as { __pendf: unknown }).__pendf = {
	AnnotationMode,
	EventBus,
	PDFFindController,
	PDFLinkService,
	PDFViewer,
	destroyWorker,
	openDocument,
	pdfjsVersion,
	workerMode,
	piecesFromRange,
	mergeLineRects,
	PageGeometry,
	pageContentRect,
	ZoomController,
	renderArea,
	geometryOf(viewport: { viewBox: number[]; userUnit?: number; rotation: number }) {
		return new PageGeometry(viewport.viewBox as ViewBox, viewport.userUnit ?? 1, viewport.rotation);
	},
};
