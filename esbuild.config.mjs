// Build: main.js (plugin + bundled pdf.js + embedded worker/assets) and styles.css.
// The pdf.js plugin and CSS scoping live in scripts/build-lib.mjs.
import esbuild from "esbuild";
import { writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { TARGET, buildCss, buildInfo, pdfjsPlugin, ponyfillStats, root } from "./scripts/build-lib.mjs";

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
	entryPoints: [path.join(root, "src", "main.ts")],
	bundle: true,
	external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
	format: "cjs",
	target: TARGET,
	platform: "browser",
	logLevel: "info",
	logOverride: { "empty-import-meta": "silent" },
	sourcemap: prod ? false : "inline",
	minify: prod,
	treeShaking: true,
	legalComments: "none",
	banner: { js: "/* penDF — bundles pdf.js (Apache-2.0, Mozilla Foundation). See LICENSE and THIRD_PARTY_NOTICES.md. */" },
	outfile: path.join(root, "main.js"),
	plugins: [pdfjsPlugin()],
});

if (prod) {
	await ctx.rebuild();
	await ctx.dispose();
	buildCss();
	const mainSize = statSync(path.join(root, "main.js")).size;
	const cssSize = statSync(path.join(root, "styles.css")).size;
	const report = { mainJs: mainSize, stylesCss: cssSize, assets: buildInfo.assetSizes, ponyfills: ponyfillStats, limit: 5 * 1024 * 1024 };
	writeFileSync(path.join(root, "build-size.json"), JSON.stringify(report, null, 2) + "\n");
	const mb = (n) => (n / 1024 / 1024).toFixed(2) + " MB";
	console.log(`main.js ${mb(mainSize)}  styles.css ${(cssSize / 1024).toFixed(0)} KB`);
	if (mainSize >= report.limit) {
		console.error(`main.js is ${mb(mainSize)}, over the 5 MB Obsidian Sync Standard limit`);
		process.exit(1);
	}
} else {
	buildCss();
	await ctx.watch();
}
