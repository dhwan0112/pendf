// Markdown note editor. A modal works best on iPad: it gets the keyboard and
// does not fight the PDF view for touch input.

import { type App, Modal, Setting, TextAreaComponent } from "obsidian";

export interface NoteEditorOptions {
	title: string;
	/** quoted above the editor (the highlighted text) */
	quote?: string;
	initial: string;
	onSave: (body: string) => void;
	/** shown only for an existing note */
	onDelete?: () => void;
}

export class NoteEditorModal extends Modal {
	private body: string;
	private done = false;

	constructor(app: App, private readonly opts: NoteEditorOptions) {
		super(app);
		this.body = opts.initial;
	}

	onOpen(): void {
		const { contentEl, opts } = this;
		this.titleEl.setText(opts.title);
		contentEl.addClass("pendf-note-editor");
		if (opts.quote) contentEl.createEl("blockquote", { cls: "pendf-note-quote", text: opts.quote });
		const ta = new TextAreaComponent(contentEl);
		ta.inputEl.addClass("pendf-note-input");
		ta.inputEl.rows = 8;
		ta.setPlaceholder("Write a note (Markdown)…");
		ta.setValue(this.body);
		ta.onChange((v) => (this.body = v));
		ta.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				this.save();
			}
		});
		const row = new Setting(contentEl);
		if (opts.onDelete) {
			row.addButton((b) =>
				b
					.setButtonText("Delete")
					.setClass("mod-warning")
					.onClick(() => {
						this.done = true;
						opts.onDelete?.();
						this.close();
					}),
			);
		}
		row.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
		row.addButton((b) => b.setButtonText("Save").setCta().onClick(() => this.save()));
		window.setTimeout(() => ta.inputEl.focus(), 0);
	}

	private save(): void {
		if (this.done) return;
		this.done = true;
		this.opts.onSave(this.body);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
