import { Platform, apiVersion } from "obsidian";

/** Platform summary for diagnostics (logs, pen probe), via the public Platform API. */
export function describePlatform(): Record<string, unknown> {
	const flags = ["isIosApp", "isAndroidApp", "isDesktopApp", "isMacOS", "isWin", "isLinux", "isTablet", "isPhone", "isSafari"] as const;
	return {
		obsidianApi: apiVersion,
		platform: flags.filter((f) => Platform[f]).map((f) => f.slice(2)),
	};
}
