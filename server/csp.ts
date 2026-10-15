import { createHash } from "node:crypto";

/**
 * Content Security Policy. Inline scripts run only when their exact content is known up front:
 * the console's index.html (hashed when the file is read) and scripts registered here by routes
 * that render HTML. Never hash scripts out of a response body: that would bless injected markup.
 *
 * A server-rendered page with an inline script (e.g. the OAuth callback page) must keep that
 * script static, call `registerInlineScript(source)` once at module load with the exact source,
 * and pass per-request data in a `<script type="application/json" id="…">` block, which CSP
 * doesn't execute and the static script reads with JSON.parse.
 */
const registered = new Set<string>();

/** "sha256-…" source for a script's exact text (what goes between <script> and </script>). */
export const scriptHash = (source: string) => `sha256-${createHash("sha256").update(source).digest("base64")}`;

export function registerInlineScript(source: string): void {
  registered.add(scriptHash(source));
}

/** For callers that already have a "sha256-…" value. */
export function registerInlineScriptHash(hash: string): void {
  if (!/^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(hash)) throw new Error(`Invalid CSP hash: ${hash}`);
  registered.add(hash);
}

export function contentSecurityPolicy(extraHashes: readonly string[] = []): string {
  const hashes = [...new Set([...registered, ...extraHashes])];
  return [
    "default-src 'self'",
    `script-src 'self'${hashes.map((h) => ` '${h}'`).join("")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}

/** Hashes of the executable inline scripts in a trusted document (the built index.html). */
export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1]!;
    if (/\bsrc\s*=/i.test(attrs) || !m[2]) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    if (type && type !== "module" && type !== "text/javascript" && type !== "application/javascript") continue;
    hashes.add(scriptHash(m[2]));
  }
  return [...hashes];
}
