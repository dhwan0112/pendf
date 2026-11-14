// One-line text prompt (bookmark titles). Resolves null when cancelled.

import { type App, Modal, Setting, TextComponent } from "obsidian";

export function promptText(app: App, title: string, initial: string, action = "Save"): Promise<string | null> {
	return new Promise((resolve) => {
		let value = initial;
		let done = false;
		const m = new (class extends Modal {
			onOpen(): void {
				this.titleEl.setText(title);
				const input = new TextComponent(this.contentEl);
				input.inputEl.addClass("pendf-prompt-input");
				input.setValue(initial);
				input.onChange((v) => (value = v));
				input.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter" && !e.isComposing) {
						e.preventDefault();
						submit();
					}
				});
				new Setting(this.contentEl)
					.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
					.addButton((b) => b.setButtonText(action).setCta().onClick(() => submit()));
				window.setTimeout(() => {
					input.inputEl.focus();
					input.inputEl.select();
				}, 0);
			}
			onClose(): void {
				if (!done) resolve(null);
				this.contentEl.empty();
			}
		})(app);
		const submit = () => {
			done = true;
			resolve(value.trim() || initial);
			m.close();
		};
		m.open();
	});
}
