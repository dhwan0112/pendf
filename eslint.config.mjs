// Same rule set the Obsidian community plugin scanner builds on
// (eslint-plugin-obsidianmd's recommended config), applied to plugin source.
// Build scripts, the desktop harness, tests and build output are not plugin
// code; the scanner skips them too.
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	globalIgnores(["node_modules", "main.js", "styles.css", "esbuild.config.mjs", "vitest.config.mjs", "scripts", "tests", "fixtures", "docs"]),
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.mjs"],
				},
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
]);
