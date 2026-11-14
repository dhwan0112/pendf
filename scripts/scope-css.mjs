// Scope pdf.js's viewer CSS under one container class so nothing leaks into
// Obsidian's UI (and Obsidian's core PDF viewer, which uses the same class
// names, is not restyled by us).
import postcss from "postcss";

const IMAGE_URL = /url\(\s*["']?images\//;

/**
 * @param {string} css
 * @param {string} scope e.g. ".pendf-root"
 */
export function scopeCss(css, scope) {
  const rootAst = postcss.parse(css);
  rootAst.walkComments((c) => {
    // keep the licence header only
    if (!/Copyright/.test(c.text)) c.remove();
  });
  rootAst.walkDecls((decl) => {
    // pdf.js editor/toolbar icons are loaded from ./images/, which does not
    // exist next to an Obsidian plugin; we never render those widgets.
    if (IMAGE_URL.test(decl.value)) decl.remove();
  });
  rootAst.walkRules((rule) => {
    // pdf.js 6 uses native CSS nesting: only top-level rules get the scope;
    // nested selectors stay relative to their (already scoped) parent rule.
    for (let p = rule.parent; p && p.type !== "root"; p = p.parent) {
      if (p.type === "rule") return;
      if (p.type === "atrule" && /keyframes$/i.test(p.name)) return;
    }
    rule.selectors = rule.selectors.map((sel) => scopeSelector(sel.trim(), scope));
  });
  rootAst.walkRules((rule) => {
    if (rule.nodes.length === 0) rule.remove();
  });
  return rootAst.toString();
}

/** @param {string} sel @param {string} scope */
export function scopeSelector(sel, scope) {
  if (sel.startsWith(scope)) return sel;
  if (sel === ":root" || sel === "html" || sel === "body") return scope;
  for (const head of [":root", "html", "body"]) {
    if (sel.startsWith(head)) {
      const rest = sel.slice(head.length);
      // ":root:not(...)" / ":root[dir=rtl]" attach to the scope element itself
      if (/^[:[.#]/.test(rest)) return scope + rest;
      return scope + rest;
    }
  }
  return `${scope} ${sel}`;
}
