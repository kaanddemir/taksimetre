/** Shared boundary rules for network requests and human-readable output. */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_INDEX_BYTES = 2 * 1024 * 1024;

export class UrlError extends Error {}

export function officialUrl(value: string, base?: string): string {
  let url: URL;
  try { url = new URL(value, base); } catch { throw new UrlError("not an official İBB address"); }
  if (value.length > 4096 || /[\u0000-\u0020\u007f\\]/u.test(value) || url.protocol !== "https:" ||
      !/^(?:[a-z0-9-]+\.)*ibb\.gov\.tr$/i.test(url.hostname) || url.port || url.username || url.password) {
    throw new UrlError("not an official İBB address (standard HTTPS on *.ibb.gov.tr required)");
  }
  url.hash = "";
  return url.href;
}

/** Do not retain credentials, queries or fragments in any human-readable output. */
export function safeUrl(value: string): string {
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch { return "[invalid URL]"; }
}

export function safeText(value: string): string {
  return value.replace(/https?:\/\/[^\s<>"'`]+/gi, (url) => safeUrl(url))
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/::/g, ": :").slice(0, 4096);
}

/** Encode untrusted text, including Markdown delimiters and HTML, as literal text. */
export function markdown(value: string): string {
  return safeText(value).replace(/[&<>\\`*_{}\[\]()#+.!|~=:]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Sanitize every string in report JSON, including nested document metadata. */
export function sanitize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, v: unknown) => typeof v === "string" ? safeText(v) : v)) as T;
}
