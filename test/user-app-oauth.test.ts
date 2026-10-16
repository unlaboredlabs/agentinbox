// Generic `user_app` OAuth (server/broker/upstream/user-app.ts): what WHOOP's native preset did, now driven by a
// preset's auth (a code extension's manifest `code.auth`). Fake token endpoint, no network.

import { describe, expect, it } from "vitest";
import { SourceError, type StoredTokens } from "../server/broker/types.ts";
import { type UserAppAuth, userAppAuthorizeUrl, userAppClientFrom, userAppExchange, userAppFlow, userAppRefreshFn } from "../server/broker/upstream/user-app.ts";

const AUTH: UserAppAuth = {
  type: "user_app",
  authorizeUrl: "https://api.prod.whoop.com/oauth/oauth2/auth",
  tokenUrl: "https://api.prod.whoop.com/oauth/oauth2/token",
  scopes: ["offline", "read:recovery", "read:profile"],
  clientIdInput: "client_id",
  clientSecretInput: "client_secret",
};
const CLIENT = { clientId: "cid-123", clientSecret: "csecret-456" };

/** A token endpoint that records each form and answers with `answer(form)`. */
function tokenEndpoint(answer: (form: URLSearchParams) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  const forms: URLSearchParams[] = [];
  const urls: string[] = [];
  const fetch = (async (url: URL | string, init?: RequestInit) => {
    urls.push(String(url));
    const form = new URLSearchParams(String(init?.body));
    forms.push(form);
    const a = answer(form);
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status ?? 200, headers: { "content-type": "application/json", ...a.headers } });
  }) as typeof globalThis.fetch;
  return { fetch, forms, urls };
}

describe("user_app OAuth", () => {
  it("the authorize URL: the preset's endpoint, client id, redirect, scopes and state", () => {
    const u = new URL(userAppAuthorizeUrl(AUTH, { clientId: "cid", redirectUri: "https://x.example/oauth/connections/callback", state: "state-12345" }));
    expect(u.origin + u.pathname).toBe(AUTH.authorizeUrl);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: "code",
      client_id: "cid",
      redirect_uri: "https://x.example/oauth/connections/callback",
      scope: "offline read:recovery read:profile",
      state: "state-12345",
    });
    expect(() => userAppAuthorizeUrl(AUTH, { clientId: "c", redirectUri: "r", state: "short" })).toThrow(/8 characters/);
    expect(() => userAppAuthorizeUrl({ ...AUTH, authorizeUrl: "http://plain.example/auth" }, { clientId: "c", redirectUri: "r", state: "state-12345" })).toThrow(/https/);
  });

  it("reads the pasted app from the client record by the preset's input keys", () => {
    expect(userAppClientFrom(AUTH, { client_id: " cid ", client_secret: "s" })).toEqual({ clientId: "cid", clientSecret: "s" });
    expect(userAppClientFrom({ ...AUTH, clientIdInput: "id", clientSecretInput: "secret" }, { id: "a", secret: "b" })).toEqual({ clientId: "a", clientSecret: "b" });
    expect(userAppClientFrom(AUTH, { client_id: "cid" })).toBeNull();
    expect(userAppClientFrom(AUTH, null)).toBeNull();
  });

  it("exchanges the code with the secret in the body (client_secret_post), no PKCE", async () => {
    const t = tokenEndpoint(() => ({ body: { access_token: "at1", refresh_token: "rt1", expires_in: 3600, scope: "offline read:recovery" } }));
    const tokens = await userAppExchange(AUTH, "the-code", { client: CLIENT, redirectUri: "https://x/cb" }, { fetch: t.fetch, now: () => 1000 });
    expect(tokens).toEqual({ accessToken: "at1", refreshToken: "rt1", expiresAt: 1000 + 3_600_000, scope: "offline read:recovery", issuer: null, issuedAt: 1000 });
    expect(t.urls).toEqual([AUTH.tokenUrl]);
    expect(Object.fromEntries(t.forms[0]!)).toEqual({ grant_type: "authorization_code", code: "the-code", redirect_uri: "https://x/cb", client_id: "cid-123", client_secret: "csecret-456" });
  });

  it("refresh: rotates the refresh token (keeps it when none comes back), sends no scope", async () => {
    let n = 0;
    const t = tokenEndpoint(() => (++n === 1 ? { body: { access_token: "at2", refresh_token: "rt2", expires_in: 60 } } : { body: { access_token: "at3", expires_in: 60 } }));
    const refresh = userAppRefreshFn(AUTH, CLIENT, { fetch: t.fetch });
    const current: StoredTokens = { accessToken: "at1", refreshToken: "rt1", expiresAt: 0, scope: "offline read:recovery", issuer: null };
    const next = await refresh(current, AbortSignal.timeout(5000));
    expect(next).toMatchObject({ accessToken: "at2", refreshToken: "rt2", scope: "offline read:recovery" });
    expect(Object.fromEntries(t.forms[0]!)).toEqual({ grant_type: "refresh_token", refresh_token: "rt1", client_id: "cid-123", client_secret: "csecret-456" });
    expect((await refresh(next, AbortSignal.timeout(5000))).refreshToken).toBe("rt2");
    await expect(refresh({ ...current, refreshToken: null }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "needs_reauth" });
  });

  it("maps token endpoint failures: invalid_grant/invalid_client → needs_reauth, 429 → rate_limited, 5xx → unavailable", async () => {
    const at = (status: number, body: unknown, headers?: Record<string, string>) => userAppExchange(AUTH, "c", { client: CLIENT, redirectUri: "r" }, { fetch: tokenEndpoint(() => ({ status, body, headers })).fetch });
    await expect(at(400, { error: "invalid_grant" })).rejects.toMatchObject({ code: "needs_reauth" });
    await expect(at(401, { error: "invalid_client" })).rejects.toMatchObject({ code: "needs_reauth" });
    await expect(at(400, { error: "invalid_request", error_description: "nope" })).rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("nope") });
    await expect(at(429, {}, { "retry-after": "12" })).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 12_000 });
    await expect(at(503, {})).rejects.toMatchObject({ code: "unavailable" });
    await expect(at(200, { token_type: "bearer" })).rejects.toBeInstanceOf(SourceError);
    await expect(userAppExchange({ ...AUTH, tokenUrl: "http://plain.example/token" }, "c", { client: CLIENT, redirectUri: "r" }, { fetch: tokenEndpoint(() => ({ body: {} })).fetch })).rejects.toMatchObject({
      code: "protocol",
    });
  });

  it("the runtime flow: authorize needs the pasted app; exchange and refresh use it", async () => {
    const t = tokenEndpoint(() => ({ body: { access_token: "at", refresh_token: "rt", expires_in: 60 } }));
    const flow = userAppFlow({ id: "whoop", displayName: "WHOOP", auth: AUTH }, { fetch: t.fetch });
    expect(flow.preset).toBe("whoop");
    expect(() => flow.authorizeUrl({ connectionId: "c", client: null, redirectUri: "r", state: "state-12345" })).toThrow(/client ID and secret/);
    const record = { client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret };
    expect(new URL(flow.authorizeUrl({ connectionId: "c", client: record, redirectUri: "r", state: "state-12345" })).searchParams.get("client_id")).toBe("cid-123");
    expect((await flow.exchange("code", { connectionId: "c", client: record, redirectUri: "r", signal: AbortSignal.timeout(5000) })).tokens.accessToken).toBe("at");
    expect(flow.refreshFn(null)).toBeNull();
    expect(flow.refreshFn(record)).toBeTypeOf("function");
  });
});
