// POST /api/google/client/check and the automatic check after saving/importing the OAuth client.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiError, GoogleClientCheck, GoogleClientImportResult, GoogleClientSaveResult } from "../shared/types.ts";
import { googleApi } from "../server/api/google.ts";
import type { AppEnv } from "../server/api/util.ts";
import type { AppContext } from "../server/context.ts";
import { HttpError } from "../server/util/errors.ts";
import { connectFakeAccount, FAKE_CLIENT, type FakeGoogle, recordingEvents, startFakeGoogle } from "./fake-google.ts";
import { testContext } from "./helpers.ts";

let fake: FakeGoogle;
let ctx: AppContext;
let dispose: () => Promise<void>;

async function setup(google?: Partial<FakeGoogle["google"]>) {
  const t = testContext({ events: recordingEvents().factory }, { google: { ...fake.google, ...google } });
  ctx = t.ctx;
  dispose = t.dispose;
}

beforeEach(async () => {
  fake = await startFakeGoogle();
  await setup();
});

afterEach(async () => {
  await dispose();
  await fake.close();
});

function withErrors<T extends Hono<AppEnv>>(app: T): T {
  app.onError((err, c) =>
    err instanceof HttpError ? c.json(err.toJSON(), err.status as ContentfulStatusCode) : c.json({ error: { code: "internal", message: err.message } }, 500),
  );
  return app;
}

async function call<T>(method: string, path: string, body?: unknown) {
  const res = await withErrors(googleApi(ctx)).request(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: (await res.json()) as T & ApiError };
}

const put = (patch: Record<string, unknown> = {}) => call<GoogleClientSaveResult>("PUT", "/google/client", { ...FAKE_CLIENT, appType: "internal", ...patch });
const check = () => call<GoogleClientCheck>("POST", "/google/client/check");
const setupCodes = () => ctx.google.setupWarnings().map((w) => w.code);

describe("OAuth client check", () => {
  it("confirms a working client on save and on demand", async () => {
    const saved = await put();
    expect(saved.status).toBe(200);
    expect(saved.body.check).toEqual({ clientId: "ok", redirectUri: "ok", secret: "ok", warnings: [] });
    expect(saved.body.warnings).toEqual([]);
    expect(saved.body.secretHint).toBe(FAKE_CLIENT.clientSecret.slice(-4));
    expect((await check()).body).toEqual({ clientId: "ok", redirectUri: "ok", secret: "ok", warnings: [] });
    // The probes didn't use up or disturb a real consent.
    await connectFakeAccount(ctx, fake, "a@example.com");
  });

  it("needs a saved client", async () => {
    const res = await check();
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("google_client_missing");
  });

  it("flags an unknown client ID (and can't judge the secret then)", async () => {
    const saved = await put({ clientId: "123-typo.apps.googleusercontent.com" });
    expect(saved.status).toBe(200); // never blocks saving
    expect(saved.body.check).toMatchObject({ clientId: "invalid", secret: "unknown", redirectUri: "unknown" });
    expect(saved.body.warnings).toEqual([expect.objectContaining({ code: "client_invalid", severity: "error" })]);
    expect(saved.body.warnings[0]!.message).toContain("123-typo.apps.googleusercontent.com");
    expect(setupCodes()).toContain("client_invalid");
    // Fixing it (a new save) replaces the result.
    await put();
    expect(setupCodes()).not.toContain("client_invalid");
  });

  it("reads a client the token endpoint doesn't know as an invalid client, not a wrong secret", async () => {
    // The consent page's answer was unclear, but the token endpoint says the client doesn't exist.
    fake.failNext({ path: "/o/oauth2/v2/auth", status: 500 });
    const saved = await put({ clientId: "123-typo.apps.googleusercontent.com" });
    expect(saved.body.check).toMatchObject({ clientId: "invalid", secret: "unknown" });
    expect(saved.body.warnings.map((w) => w.code)).toEqual(["client_invalid"]);
  });

  it("asks for English pages and treats unauthorized_client as inconclusive for the secret", async () => {
    const seen: string[] = [];
    const google = createServer((req, res) => {
      seen.push(req.url ?? "");
      if (req.url?.startsWith("/token")) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized_client", error_description: "Unauthorized" }));
      } else res.writeHead(302, { location: "/v3/signin/identifier" }).end();
    });
    await new Promise<void>((r) => google.listen(0, "127.0.0.1", r));
    try {
      const base = `http://127.0.0.1:${(google.address() as AddressInfo).port}`;
      await dispose();
      await setup({ authBase: base, oauthBase: base });
      ctx.google.setClient({ ...FAKE_CLIENT, appType: "internal" });
      const res = await check();
      expect(res.body).toEqual({ clientId: "ok", redirectUri: "ok", secret: "unknown", warnings: [] });
      const auth = new URL(seen.find((u) => u.startsWith("/o/oauth2/v2/auth"))!, base);
      expect(auth.searchParams.get("hl")).toBe("en");
    } finally {
      google.close();
    }
  });

  it("flags a wrong secret, naming its last 4 characters", async () => {
    const saved = await put({ clientSecret: "GOCSPX-wrong-WXYZ" });
    expect(saved.body.check).toMatchObject({ clientId: "ok", redirectUri: "ok", secret: "invalid" });
    expect(saved.body.secretHint).toBe("WXYZ");
    const [w] = saved.body.warnings;
    expect(w).toMatchObject({ code: "client_secret_invalid", severity: "error" });
    expect(w!.message).toContain("ending in WXYZ");
    expect(w!.hint).toMatch(/Add secret/);
    expect(JSON.stringify(ctx.audit.list({ action: "google.client.update" }).items)).not.toContain("GOCSPX-wrong-WXYZ");
    expect(setupCodes()).toEqual(["client_secret_invalid"]);
  });

  it("flags an unregistered redirect URI until Google accepts it", async () => {
    fake.registeredRedirectUris = ["https://elsewhere.example/oauth/callback"];
    const saved = await put();
    expect(saved.body.check).toMatchObject({ clientId: "ok", redirectUri: "missing", secret: "ok" });
    expect(saved.body.warnings).toEqual([expect.objectContaining({ code: "redirect_uri_missing" })]);
    expect(saved.body.warnings[0]!.message).toMatch(/^Google says .* isn't an Authorized redirect URI/);
    expect(setupCodes()).toEqual(["redirect_uri_missing"]);

    fake.registeredRedirectUris = [ctx.google.redirectUri()];
    expect((await check()).body).toMatchObject({ redirectUri: "ok", warnings: [] });
    expect(setupCodes()).toEqual([]);
  });

  it("prefers Google's answer over the imported JSON", async () => {
    // The JSON was downloaded before the URI was added; Google already has it.
    const json = JSON.stringify({ web: { client_id: FAKE_CLIENT.clientId, client_secret: FAKE_CLIENT.clientSecret, project_id: FAKE_CLIENT.projectId, redirect_uris: [] } });
    const res = await call<GoogleClientImportResult>("POST", "/google/client/import", { json });
    expect(res.body.check).toMatchObject({ clientId: "ok", redirectUri: "ok", secret: "ok" });
    expect(res.body.warnings).toEqual([]);
    // When Google's answer is unclear, the JSON's list still warns.
    fake.failNext({ path: "/o/oauth2/v2/auth", status: 500 });
    const unclear = await call<GoogleClientImportResult>("POST", "/google/client/import", { json });
    expect(unclear.body.check.redirectUri).toBe("unknown");
    expect(unclear.body.warnings.map((w) => w.code)).toEqual(["redirect_uri_missing"]);
  });

  it("answers unknown, without blocking the save, when Google's responses are unexpected", async () => {
    fake.failNext({ path: "/o/oauth2/v2/auth", status: 500 });
    fake.failNext({ path: "/token", status: 503 });
    const saved = await put();
    expect(saved.status).toBe(200);
    expect(saved.body.check).toEqual({ clientId: "unknown", redirectUri: "unknown", secret: "unknown", warnings: [] });
    expect(saved.body.hasSecret).toBe(true);
  });

  it("follows redirects only on Google's hosts", async () => {
    let hits = 0;
    const other = createServer((_req, res) => {
      hits++;
      res.writeHead(200).end("<title>Sign in</title>");
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    const elsewhere = `http://localhost:${(other.address() as AddressInfo).port}/v3/signin/identifier`;
    const bouncer = createServer((_req, res) => res.writeHead(302, { location: elsewhere }).end());
    await new Promise<void>((r) => bouncer.listen(0, "127.0.0.1", r));
    try {
      await dispose();
      await setup({ authBase: `http://127.0.0.1:${(bouncer.address() as AddressInfo).port}` });
      ctx.google.setClient({ ...FAKE_CLIENT, appType: "internal" });
      const res = await check();
      expect(res.body).toMatchObject({ clientId: "unknown", redirectUri: "unknown", secret: "ok" });
      expect(hits).toBe(0);
    } finally {
      bouncer.close();
      other.close();
    }
  });

  it("is cleared by a successful connection and shows a hint for clients saved before hints existed", async () => {
    fake.registeredRedirectUris = [];
    await put({ appType: "external" });
    expect(setupCodes()).toEqual(["redirect_uri_missing"]);
    fake.registeredRedirectUris = null;
    await connectFakeAccount(ctx, fake, "a@example.com");
    expect(setupCodes()).toEqual([]);
    expect(ctx.settings.getState("google.client")?.check).toBeUndefined();

    const { secretHint: _h, ...legacy } = ctx.settings.getState("google.client")!;
    ctx.settings.setState("google.client", legacy);
    expect(ctx.google.clientView().secretHint).toBe(FAKE_CLIENT.clientSecret.slice(-4));
  });
});
