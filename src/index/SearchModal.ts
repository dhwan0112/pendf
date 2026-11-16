// "Search annotations in vault" (0.8.0): text, type and colour filters over the
// vault-wide index; choosing a result opens penDF at that annotation.
//   words            must all occur in the annotation's text or the PDF's path
//   type:highlight   only that kind (highlight, note, area, bookmark, ink; repeatable)
//   color:yellow     only that colour (a highlight colour name from the settings, or #rrggbb)

import { SuggestModal, type App } from "obsidian";
import type { AnnotationType } from "../store/schema";
import { parseIndexQuery, type SearchQuery, type SearchResult } from "./model";

const ICONS: Record<AnnotationType, string> = { highlight: "Highlight", note: "Note", area: "Excerpt", bookmark: "Bookmark", ink: "Handwriting" };

export class AnnotationSearchModal extends SuggestModal<SearchResult> {
	constructor(
		app: App,
		private readonly search: (q: SearchQuery) => Promise<SearchResult[]>,
		private readonly colors: () => readonly { name: string; hex: string }[],
		private readonly openResult: (r: SearchResult) => void,
	) {
		super(app);
		this.setPlaceholder("Search annotations in all PDFs…");
		this.setInstructions([
			{ command: "type:highlight", purpose: "only highlights (also note, area, bookmark, ink)" },
			{ command: "color:yellow", purpose: "only that colour (name or #hex)" },
			{ command: "↵", purpose: "open in penDF" },
		]);
		this.emptyStateText = "No annotations match.";
	}

	async getSuggestions(query: string): Promise<SearchResult[]> {
		return this.search(parseIndexQuery(query, this.colors()));
	}

	renderSuggestion(r: SearchResult, el: HTMLElement): void {
		el.addClass("pendf-index-result");
		const top = el.createDiv({ cls: "pendf-index-text" });
		if (r.color) top.createSpan({ cls: "pendf-index-swatch" }).setCssProps({ "--pendf-swatch": r.color });
		top.appendText(r.text || (r.type === "ink" ? "(handwriting)" : "(no text)"));
		const path = r.paths[0] ?? "";
		el.createDiv({ cls: "pendf-index-meta", text: `${ICONS[r.type]} · ${path.split("/").pop() ?? path} · p. ${r.page}${r.paths.length > 1 ? ` · ${r.paths.length} copies` : ""}` });
	}

	onChooseSuggestion(r: SearchResult): void {
		this.openResult(r);
	}
}
