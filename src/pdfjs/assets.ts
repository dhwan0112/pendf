// Embedded pdf.js worker and binary assets (CMaps, standard fonts, wasm image
// decoders). The build stores each as gzip+base64 inside main.js so the plugin
// is a single file that works on iOS and never fetches anything over the
// network. See esbuild.config.mjs and docs/INVESTIGATION.md.
import { ASSETS_GZ, WORKER_GZ } from "ppp:assets";

export function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

const cache = new Map<string, Promise<Uint8Array>>();

export type AssetKind = "cMapUrl" | "standardFontDataUrl" | "wasmUrl";

export function hasAsset(kind: AssetKind, filename: string): boolean {
	return Object.prototype.hasOwnProperty.call(ASSETS_GZ, `${kind}/${filename}`);
}

export function getAsset(kind: AssetKind, filename: string): Promise<Uint8Array> {
	const key = `${kind}/${filename}`;
	let p = cache.get(key);
	if (!p) {
		const enc = ASSETS_GZ[key];
		if (enc === undefined) return Promise.reject(new Error(`PDF+++: no embedded asset ${key}`));
		p = gunzip(base64ToBytes(enc));
		cache.set(key, p);
	}
	return p;
}

export async function getWorkerSource(): Promise<string> {
	const bytes = await gunzip(base64ToBytes(WORKER_GZ));
	return new TextDecoder().decode(bytes);
}

export function clearAssetCache(): void {
	cache.clear();
}

export function assetKeys(): string[] {
	return Object.keys(ASSETS_GZ);
}
