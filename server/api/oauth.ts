import { createHash } from "node:crypto";
import type { AppContext } from "../context.ts";
import { HttpError } from "../util/errors.ts";
import { asHttpError } from "../google/http.ts";
import { router } from "./util.ts";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** JSON safe to embed in a <script type="application/json"> data block. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/**
 * The callback page's only executable script. It is static (all dynamic data lives in the JSON block
 * #oauth-result), so the CSP can allow exactly this hash instead of inline scripts in general.
 */
export const OAUTH_CALLBACK_SCRIPT = `(function () {
  try {
    var r = JSON.parse(document.getElementById("oauth-result").textContent);
    if (window.opener) {
      window.opener.postMessage({ type: "agentinbox:oauth", ok: r.ok, email: r.email, error: r.error }, r.targetOrigin);
      if (r.ok) setTimeout(function () { window.close(); }, 600);
    }
  } catch (e) {}
})();`;

/** CSP source for OAUTH_CALLBACK_SCRIPT, e.g. script-src 'sha256-…'. */
export const OAUTH_CALLBACK_SCRIPT_HASH = `sha256-${createHash("sha256").update(OAUTH_CALLBACK_SCRIPT).digest("base64")}`;

interface PageInput {
  ok: boolean;
  email?: string | null;
  title: string;
  message: string;
  hint?: string | null;
  /** postMessage target origin for the opener (the console). */
  targetOrigin: string;
}

export function callbackPage(p: PageInput): string {
  const icon = p.ok
    ? `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`
    : `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8v5"/><path d="M12 16.5h.01"/></svg>`;
  const result = { ok: p.ok, email: p.email ?? null, error: p.ok ? null : p.message, targetOrigin: p.targetOrigin };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(p.title)} · agentinbox</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --fg: #111827; --muted: #6b7280; --border: #e5e7eb;
    --ok: #16a34a; --ok-bg: #dcfce7; --err: #dc2626; --err-bg: #fee2e2; --link: #2563eb; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b0d10; --card: #15181d; --fg: #f3f4f6; --muted: #9ca3af; --border: #262a31;
    --ok: #4ade80; --ok-bg: #14301f; --err: #f87171; --err-bg: #3a1717; --link: #60a5fa; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--bg); color: var(--fg);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width: 100%; max-width: 440px; background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 32px;
    box-shadow: 0 1px 2px rgb(0 0 0 / .04), 0 8px 24px rgb(0 0 0 / .06); text-align: center; }
  .icon { width: 52px; height: 52px; margin: 0 auto 16px; border-radius: 999px; display: grid; place-items: center;
    color: ${p.ok ? "var(--ok)" : "var(--err)"}; background: ${p.ok ? "var(--ok-bg)" : "var(--err-bg)"}; }
  h1 { font-size: 19px; margin: 0 0 8px; letter-spacing: -0.01em; }
  p { margin: 0 0 8px; color: var(--muted); overflow-wrap: anywhere; }
  .hint { margin-top: 12px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; text-align: left; font-size: 14px; }
  a.button { display: inline-block; margin-top: 20px; padding: 9px 16px; border-radius: 9px; background: var(--fg); color: var(--card);
    text-decoration: none; font-weight: 500; font-size: 14px; }
  a { color: var(--link); }
  .brand { margin-top: 20px; font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<main>
  <div class="icon">${icon}</div>
  <h1>${escapeHtml(p.title)}</h1>
  <p>${escapeHtml(p.message)}</p>
  ${p.hint ? `<p class="hint">${escapeHtml(p.hint)}</p>` : ""}
  <a class="button" href="${escapeHtml(p.ok && p.email ? `/accounts?connected=${encodeURIComponent(p.email)}` : "/accounts")}">Go to accounts</a>
  <div class="brand">agentinbox</div>
</main>
<script type="application/json" id="oauth-result">${scriptJson(result)}</script>
<script>${OAUTH_CALLBACK_SCRIPT}</script>
</body>
</html>`;
}

/** GET /oauth/callback (unauthenticated, mounted at the root): completes the OAuth flow and renders a result page. */
export function oauthRoutes(ctx: AppContext) {
  const r = router();

  r.get("/oauth/callback", async (c) => {
    const url = new URL(c.req.url);
    // The console that opened the popup lives at publicUrl (in dev, Vite serves it from another port).
    const targetOrigin = ctx.config.dev ? "*" : new URL(ctx.settings.publicUrl()).origin;
    try {
      const account = await ctx.google.completeConnectFromUrl(`?${url.searchParams.toString()}`);
      return c.html(
        callbackPage({
          ok: true,
          email: account.email,
          title: "Account connected",
          message: `Connected ${account.email}. You can close this tab.`,
          targetOrigin,
        }),
      );
    } catch (err) {
      const e = asHttpError(err);
      ctx.log.child("oauth").warn("OAuth callback failed", { error: e instanceof Error ? e.message : String(e) });
      const known = e instanceof HttpError;
      return c.html(
        callbackPage({
          ok: false,
          title: "Couldn't connect the account",
          message: known ? e.message : "Something went wrong while finishing the connection.",
          hint: known ? e.hint : "Check the agentinbox server log, then try connecting again from the console.",
          targetOrigin,
        }),
        known && e.status < 500 ? 400 : 500,
      );
    }
  });

  return r;
}
