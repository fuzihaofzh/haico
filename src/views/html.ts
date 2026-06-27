// Server-side HTML string helper — mirrors public/js/shared/common.js h/html.
// Independent implementation: src/views/ must not import client ESM modules
// (CommonJS server ↔ ESM browser boundary). Keep the two implementations in
// escaping behavior sync; both escape the same set of characters.
//
// Divergence from client: server-side `h` returns `HtmlFragment` (not string)
// so that sub-views compose without `html()` wrappers — the outer `h`
// recognizes `__html` and passes it through unescaped. Use `renderToString`
// at the route boundary to convert back to a plain string for Fastify.

export interface HtmlFragment {
  __html: string;
}

/** Mark a string as already-safe HTML so h() skips escaping. */
export function html(value: unknown): HtmlFragment {
  return { __html: String(value == null ? '' : value) };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Resolve a single interpolated value to its HTML string form:
 * - null/undefined → empty
 * - Array → each element resolved recursively, then joined (no separator)
 * - HtmlFragment → raw HTML, pass-through (no escaping)
 * - everything else → escapeHtml(String(value))
 */
function renderValue(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(renderValue).join('');
  if (typeof value === 'object' && '__html' in value) return (value as HtmlFragment).__html;
  return escapeHtml(String(value));
}

/**
 * Tagged template literal that auto-escapes interpolated values.
 *
 * Returns `HtmlFragment` (not `string`) so the result can be safely
 * interpolated into an outer `h\`...\`` without an `html()` wrapper —
 * the outer `h` recognizes `__html` and passes it through unescaped.
 *
 * Arrays are handled natively: `${items.map(fn)}` works directly, no
 * `.join('')` or `html()` wrapper needed. Each element is resolved via
 * `renderValue`, so an array of `HtmlFragment` composes without escaping.
 *
 * Use `renderToString` to convert the final `HtmlFragment` to a plain
 * string at the route boundary.
 */
export function h(parts: TemplateStringsArray, ...vals: unknown[]): HtmlFragment {
  return { __html: parts.reduce((acc, part, i) => acc + part + renderValue(vals[i]), '') };
}

/** Convert an `HtmlFragment` (or pass-through string) to a plain string. */
export function renderToString(fragment: HtmlFragment | string): string {
  return typeof fragment === 'string' ? fragment : fragment.__html;
}
