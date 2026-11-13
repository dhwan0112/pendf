// Build-time "ponyfill" transform for the modern pdf.js build.
//
// The modern build calls a handful of very new built-ins (Map#getOrInsert…,
// Math.sumPrecise, Uint8Array base64/hex…) that Obsidian's Chromium 138 and
// possibly iPadOS WebKit lack. pdf.js's own answer is the legacy build, whose
// core-js polyfills install themselves on the shared window — and in
// Chromium 138 even *replace* native Promise.try / Iterator#take / #drop
// (measured, docs/INVESTIGATION.md §10). That breaks "no contact with other
// plugins". Instead we rewrite the call sites to module-local helpers that use
// the native method when present and a local implementation otherwise.
// Nothing global is touched.
//
// Unhandled shapes (computed access, optional call on a complex receiver,
// method used as a value) fail the build; so does any remaining access after
// the rewrite (assertNoTargets).
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import MagicString from "magic-string";

export const INSTANCE_METHODS = ["getOrInsert", "getOrInsertComputed", "toHex", "toBase64", "setFromBase64", "setFromHex", "join"];
export const STATIC_METHODS = {
	"Math.sumPrecise": "__ppp_sumPrecise",
	"Uint8Array.fromBase64": "__ppp_fromBase64",
	"Promise.try": "__ppp_promiseTry",
	"RegExp.escape": "__ppp_regExpEscape",
	"URL.parse": "__ppp_urlParse",
};

/** Module-local helpers prepended to every transformed module (and the worker). */
export const HELPERS = String.raw`
const __ppp_getOrInsertComputed = (m, k, f) => {
  if (typeof m.getOrInsertComputed === "function") return m.getOrInsertComputed(k, f);
  if (m.has(k)) return m.get(k);
  const v = f(k);
  m.set(k, v);
  return v;
};
const __ppp_getOrInsert = (m, k, v) => {
  if (typeof m.getOrInsert === "function") return m.getOrInsert(k, v);
  if (!m.has(k)) m.set(k, v);
  return m.get(k);
};
const __ppp_join = (o, ...a) => (typeof o.join === "function" ? o.join(...a) : Array.from(o).join(...a));
const __ppp_sumPrecise = (iterable) => {
  if (typeof Math.sumPrecise === "function") return Math.sumPrecise(iterable);
  // Neumaier compensated summation
  let sum = -0, c = 0, any = false;
  for (const x of iterable) {
    if (typeof x !== "number") throw new TypeError("sumPrecise: not a number");
    if (!any) { sum = x; any = true; continue; }
    const t = sum + x;
    c += Math.abs(sum) >= Math.abs(x) ? sum - t + x : x - t + sum;
    sum = t;
  }
  return any && Number.isFinite(sum) ? sum + c : sum;
};
const __ppp_b64chars = (alphabet) => (alphabet === "base64url" ? "-_" : "+/");
const __ppp_toBase64 = (u8, opts) => {
  if (typeof u8.toBase64 === "function") return u8.toBase64(opts);
  let bin = "";
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  let s = btoa(bin);
  if (opts?.alphabet === "base64url") s = s.replace(/\+/g, "-").replace(/\//g, "_");
  if (opts?.omitPadding) s = s.replace(/=+$/, "");
  return s;
};
const __ppp_decodeBase64 = (str, opts) => {
  let s = String(str).replace(/[\t\n\f\r ]+/g, "");
  if (opts?.alphabet === "base64url") s = s.replace(/-/g, "+").replace(/_/g, "/");
  else if (/[-_]/.test(s)) throw new SyntaxError("invalid base64");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const __ppp_fromBase64 = (str, opts) =>
  typeof Uint8Array.fromBase64 === "function" ? Uint8Array.fromBase64(str, opts) : __ppp_decodeBase64(str, opts);
const __ppp_setFromBase64 = (u8, str, opts) => {
  if (typeof u8.setFromBase64 === "function") return u8.setFromBase64(str, opts);
  const bytes = __ppp_decodeBase64(str, opts);
  const n = Math.min(bytes.length, u8.length);
  u8.set(bytes.subarray(0, n));
  return { read: String(str).length, written: n };
};
const __ppp_toHex = (u8) => {
  if (typeof u8.toHex === "function") return u8.toHex();
  let s = "";
  for (let i = 0; i < u8.length; i++) s += (u8[i] < 16 ? "0" : "") + u8[i].toString(16);
  return s;
};
const __ppp_setFromHex = (u8, str) => {
  if (typeof u8.setFromHex === "function") return u8.setFromHex(str);
  const s = String(str);
  if (s.length % 2 || /[^0-9a-fA-F]/.test(s)) throw new SyntaxError("invalid hex");
  const n = Math.min(s.length / 2, u8.length);
  for (let i = 0; i < n; i++) u8[i] = parseInt(s.substr(i * 2, 2), 16);
  return { read: n * 2, written: n };
};
const __ppp_promiseTry = (f, ...a) =>
  typeof Promise.try === "function" ? Promise.try(f, ...a) : new Promise((resolve) => resolve(f(...a)));
const __ppp_regExpEscape = (s) => {
  if (typeof RegExp.escape === "function") return RegExp.escape(s);
  return String(s).replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&").replace(/^[0-9A-Za-z]/, (c) => "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0"));
};
const __ppp_urlParse = (u, b) => {
  if (typeof URL.parse === "function") return URL.parse(u, b);
  try { return new URL(u, b); } catch { return null; }
};
`;

/** The pdf.js modern build installs this polyfill on the shared Iterator.prototype. */
const ITERATOR_JOIN_POLYFILL = /if \(typeof Iterator\.prototype\.join !== "function"\) \{\s*Iterator\.prototype\.join = function \(separator\) \{\s*return \[\.\.\.this\]\.join\(separator\);\s*\};\s*\}/g;

const PARSE = { ecmaVersion: "latest", sourceType: "module", allowHashBang: true };

function staticName(node) {
	if (node.type !== "MemberExpression" || node.computed) return null;
	if (node.object.type !== "Identifier" || node.property.type !== "Identifier") return null;
	const key = `${node.object.name}.${node.property.name}`;
	return Object.prototype.hasOwnProperty.call(STATIC_METHODS, key) ? key : null;
}

function isSimpleReceiver(node) {
	if (node.type === "Identifier" || node.type === "ThisExpression") return true;
	if (node.type === "MemberExpression" && !node.computed && !node.optional) return isSimpleReceiver(node.object);
	return false;
}

/**
 * Rewrite call sites. Returns { code, stats }. Throws on unhandled shapes.
 * @param {string} src
 * @param {string} name for error messages
 */
export function ponyfill(src, name) {
	const joinHits = src.match(ITERATOR_JOIN_POLYFILL)?.length ?? 0;
	if (joinHits > 1) throw new Error(`${name}: Iterator.prototype.join polyfill found ${joinHits} times`);
	src = src.replace(ITERATOR_JOIN_POLYFILL, "/* pdf-ppp: Iterator.prototype.join polyfill removed; calls go through __ppp_join */");
	const ast = acorn.parse(src, PARSE);
	const ms = new MagicString(src);
	const stats = {};
	const bump = (k) => (stats[k] = (stats[k] ?? 0) + 1);
	const errors = [];

	walk.fullAncestor(ast, (node, _state, ancestors) => {
		if (node.type !== "MemberExpression") return;
		const parent = ancestors[ancestors.length - 2];
		// static: Math.sumPrecise etc. (call or reference)
		const sk = staticName(node);
		if (sk) {
			ms.overwrite(node.start, node.end, STATIC_METHODS[sk]);
			bump(sk);
			return;
		}
		if (node.computed || node.property.type !== "Identifier") return;
		const m = node.property.name;
		if (!INSTANCE_METHODS.includes(m)) return;
		const where = `${name}:${src.slice(0, node.start).split("\n").length}`;
		if (!parent || parent.type !== "CallExpression" || parent.callee !== node) {
			// XFA objects have a data property called "join"; that is not the builtin
			if (m === "join") return;
			errors.push(`${where}: .${m} used as a value (${src.slice(node.start, Math.min(node.end + 20, src.length)).replace(/\s+/g, " ")})`);
			return;
		}
		if (parent.optional) {
			errors.push(`${where}: optional call ?.() on .${m}`);
			return;
		}
		const helper = `__ppp_${m}`;
		const obj = node.object;
		// acorn ranges exclude grouping parentheses: `(a ??= b).m()` has the
		// object ending before ")". Widen the receiver span to include them.
		let recvStart = obj.start;
		let recvEnd = obj.end;
		const dot = src.lastIndexOf(node.optional ? "?." : ".", node.property.start);
		const between = src.slice(obj.end, dot);
		const closing = (between.match(/\)/g) ?? []).length;
		if (/[^\s)]/.test(between)) {
			errors.push(`${where}: unexpected text between receiver and .${m}`);
			return;
		}
		for (let k = 0; k < closing; k++) {
			let p = recvStart - 1;
			while (p >= 0 && /\s/.test(src[p])) p--;
			if (src[p] !== "(") {
				errors.push(`${where}: unbalanced parentheses around receiver of .${m}`);
				return;
			}
			recvStart = p;
		}
		recvEnd = dot;
		// position of "(" that opens the argument list
		let paren = node.end;
		while (paren < parent.end && src[paren] !== "(") paren++;
		if (src[paren] !== "(") {
			errors.push(`${where}: cannot find argument list`);
			return;
		}
		if (node.optional) {
			const chain = ancestors[ancestors.length - 3];
			if (!chain || chain.type !== "ChainExpression" || chain.expression !== parent) {
				errors.push(`${where}: optional chain continues after .${m}()`);
				return;
			}
			// obj?.m(args) → (obj == null ? void 0 : helper(obj, args)); obj must be side-effect free
			if (!isSimpleReceiver(obj)) {
				errors.push(`${where}: optional member call on a complex receiver`);
				return;
			}
			const objText = src.slice(recvStart, recvEnd);
			ms.prependLeft(recvStart, `(${objText} == null ? void 0 : ${helper}(`);
			ms.overwrite(recvEnd, paren + 1, parent.arguments.length ? ", " : "");
			ms.appendLeft(parent.end, ")");
		} else {
			ms.prependLeft(recvStart, `${helper}(`);
			ms.overwrite(recvEnd, paren + 1, parent.arguments.length ? ", " : "");
		}
		bump(`.${m}`);
	});
	if (errors.length) throw new Error(`pdfjs-ponyfill: unhandled call shapes\n  ${errors.slice(0, 20).join("\n  ")}`);
	const body = ms.toString();
	assertNoTargets(body, name);
	return { code: HELPERS + body, stats };
}

/** After the rewrite (helpers excluded), nothing may still reach the targeted built-ins. */
export function assertNoTargets(code, name) {
	const ast = acorn.parse(code, PARSE);
	const bad = [];
	walk.fullAncestor(ast, (node, _s, ancestors) => {
		if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
			const p = node.property.name;
			const sk = staticName(node);
			const parent = ancestors[ancestors.length - 2];
			const isCall = parent && parent.type === "CallExpression" && parent.callee === node;
			if (sk) bad.push(sk);
			else if (INSTANCE_METHODS.includes(p) && (p !== "join" || isCall)) bad.push("." + p);
		}
		if (node.type === "AssignmentExpression" && node.left.type === "MemberExpression") {
			const t = code.slice(node.left.start, node.left.end);
			if (/^(Object|Array|Map|WeakMap|Set|WeakSet|Promise|Math|RegExp|String|Number|Iterator|Uint8Array|Function|JSON|Reflect|Symbol|URL|Error)(\.prototype)?\.[\w$]+$/.test(t)) bad.push("assign " + t);
		}
	});
	if (bad.length) throw new Error(`${name}: targeted built-ins still reachable after ponyfill: ${[...new Set(bad)].join(", ")}`);
}
