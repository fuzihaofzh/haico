// Server-side HTML string helper — mirrors public/js/shared/common.js h/html.
// Independent implementation: src/views/ must not import client ESM modules
// (CommonJS server ↔ ESM browser boundary). Keep the two implementations in
// behavioral sync; both escape the same set of characters.

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
 * Tagged template literal that auto-escapes interpolated values.
 * Pass raw HTML through `html(...)` to opt out of escaping for a value.
 * Arrays must be pre-joined by the caller (same contract as the client helper).
 */
export function h(parts: TemplateStringsArray, ...vals: unknown[]): string {
  return parts.reduce((acc, part, i) => {
    const value = vals[i];
    if (value == null) return acc + part;
    if (typeof value === 'object' && '__html' in value) {
      return acc + part + (value as HtmlFragment).__html;
    }
    return acc + part + escapeHtml(String(value));
  }, '');
}
