// Pure outline helpers (0.8.0). No DOM.

export interface OutlineLike {
	page: number | null;
	items: OutlineLike[];
}

/** Stable key of a node by its position in the tree ("0.3.1"). */
export function outlineKey(path: readonly number[]): string {
	return path.join(".");
}

/**
 * Key of the node the reader is in on `page`: the last node, in document
 * order, whose page is at or before `page` (deepest wins on ties, because a
 * child comes after its parent in document order). null before the first one.
 */
export function currentOutlineKey(nodes: readonly OutlineLike[], page: number): string | null {
	let best: string | null = null;
	let bestPage = -Infinity;
	const walk = (list: readonly OutlineLike[], path: number[]) => {
		list.forEach((n, i) => {
			const p = [...path, i];
			if (n.page !== null && n.page <= page && n.page >= bestPage) {
				best = outlineKey(p);
				bestPage = n.page;
			}
			walk(n.items, p);
		});
	};
	walk(nodes, []);
	return best;
}
