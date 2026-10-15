import { afterEach, describe, expect, it } from "vitest";
import { OAUTH_CALLBACK_SCRIPT, OAUTH_CALLBACK_SCRIPT_HASH } from "../server/api/oauth.ts";
import { createApp } from "../server/app.ts";
import { testContext } from "./helpers.ts";

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

describe("oauth callback page under the console CSP", () => {
  it("allows exactly the static callback script", async () => {
    const t = testContext();
    dispose = t.dispose;
    const res = await createApp(t.ctx).request("/oauth/callback?error=access_denied&state=x");
    const html = await res.text();
    expect(html).toContain(`<script>${OAUTH_CALLBACK_SCRIPT}</script>`);
    const csp = res.headers.get("content-security-policy") ?? "";
    const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src ")) ?? "";
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain(`'${OAUTH_CALLBACK_SCRIPT_HASH}'`);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });
});
