declare module "ppp:assets" {
	/** gzip + base64 of the transformed pdf.worker.min.mjs (ES module source). */
	export const WORKER_GZ: string;
	/** "<factory kind>/<filename>" → gzip + base64 bytes. */
	export const ASSETS_GZ: Record<string, string>;
}
