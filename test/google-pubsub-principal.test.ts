// Choosing the Pub/Sub principal account and the distinct provisioning error codes.

import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiError, PubsubState } from "../shared/types.ts";
import { googleApi } from "../server/api/google.ts";
import type { AppEnv } from "../server/api/util.ts";
import type { AppContext } from "../server/context.ts";
import { HttpError } from "../server/util/errors.ts";
import { connectFakeAccount, FAKE_CLIENT, type FakeGoogle, recordingEvents, startFakeGoogle } from "./fake-google.ts";
import { testContext } from "./helpers.ts";

let fake: FakeGoogle;
let ctx: AppContext;
let dispose: () => Promise<void>;

beforeEach(async () => {
  fake = await startFakeGoogle();
  fake.pullWaitMs = 200;
  const t = testContext({ events: recordingEvents().factory }, { google: fake.google });
  ctx = t.ctx;
  dispose = t.dispose;
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

async function provision(body?: { accountId?: string }) {
  const res = await withErrors(googleApi(ctx)).request("/google/pubsub/provision", { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: (await res.json()) as PubsubState & ApiError };
}

/** The console's scope detection (src/components/google/pubsub-panel.tsx) as of this change. */
const CONSOLE_SCOPE_RE = /access to (cloud )?pub\/?sub|manage pub\/?sub|pub\/?sub (access|scope|permission)/i;

/** Runs the incremental Pub/Sub consent the console starts on pubsub_scope_required. */
async function grantPubsubScope(email: string) {
  fake.consentAs(email);
  const { authUrl } = ctx.google.startConnect({ scopes: ["pubsub"] });
  expect(new URL(authUrl).searchParams.get("login_hint")).toBe(email);
  const res = await fetch(authUrl, { redirect: "manual" });
  await ctx.google.completeConnectFromUrl(res.headers.get("location")!);
}

describe("Pub/Sub principal", () => {
  it("lets a shared mailbox that isn't the project owner switch to the owner's account", async () => {
    fake.addAccount("ops@example.com", { projectAccess: false });
    const ops = await connectFakeAccount(ctx, fake, "ops@example.com", { pubsub: true });
    const owner = await connectFakeAccount(ctx, fake, "owner@example.com");
    expect(ctx.google.pubsubState()).toMatchObject({ principalAccountId: ops.id, principalEmail: "ops@example.com" });

    // Default principal: ops@ (it has the Pub/Sub scope) → IAM refuses.
    const denied = await provision();
    expect(denied.status).toBe(400);
    expect(denied.body.error.code).toBe("pubsub_permission_denied");
    expect(denied.body.error.message).toContain("ops@example.com");
    expect(denied.body.error.hint).toContain("--member=user:ops@example.com");
    // Can't be mistaken for the missing-scope case by text.
    expect(CONSOLE_SCOPE_RE.test(`${denied.body.error.message} ${denied.body.error.hint}`)).toBe(false);

    // "Use a different account": the choice is saved even though the owner still needs the scope.
    const scope = await provision({ accountId: owner.id });
    expect(scope.status).toBe(409);
    expect(scope.body.error.code).toBe("pubsub_scope_required");
    expect(scope.body.error.message).toContain("owner@example.com");
    expect(CONSOLE_SCOPE_RE.test(scope.body.error.message)).toBe(true);
    expect(ctx.google.pubsubState()).toMatchObject({ principalAccountId: owner.id, principalEmail: "owner@example.com" });

    await grantPubsubScope("owner@example.com");
    const ok = await provision({ accountId: owner.id });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ mode: "pubsub", principalAccountId: owner.id, principalEmail: "owner@example.com", lastError: null });
    // Both mailboxes are watched on the topic the owner created.
    expect(fake.watch("ops@example.com")?.topic).toBe(ok.body.topic);
    expect(fake.watch("owner@example.com")?.topic).toBe(ok.body.topic);
    // Later provisioning without a body keeps the chosen principal.
    expect((await provision()).body.principalEmail).toBe("owner@example.com");
    expect(ctx.audit.list({ action: "pubsub.provision" }).items[0]).toMatchObject({ outcome: "ok", accountId: owner.id });
  });

  it("validates the chosen account", async () => {
    const a = await connectFakeAccount(ctx, fake, "a@example.com", { pubsub: true });
    const b = await connectFakeAccount(ctx, fake, "b@example.com");
    expect((await provision({ accountId: "acc_nope" })).status).toBe(404);
    ctx.accounts.setStatus(b.id, "paused");
    const paused = await provision({ accountId: b.id });
    expect(paused.status).toBe(409);
    expect(paused.body.error.code).toBe("account_paused");
    ctx.accounts.setStatus(b.id, "needs_reauth", "x");
    expect((await provision({ accountId: b.id })).body.error.code).toBe("needs_reauth");
    expect(ctx.google.pubsubState().principalAccountId).toBe(a.id);
  });

  it("explains a billing requirement", async () => {
    await connectFakeAccount(ctx, fake, "a@example.com", { pubsub: true });
    fake.failNext({
      method: "PUT",
      path: "/topics/",
      status: 403,
      reason: "BILLING_DISABLED",
      message: "This API method requires billing to be enabled. Please enable billing on project #123 then retry.",
    });
    const res = await provision();
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("pubsub_billing");
    expect(res.body.error.hint).toContain(`https://console.cloud.google.com/billing/linkedaccount?project=${FAKE_CLIENT.projectId}`);
    expect(res.body.error.hint).toMatch(/polling/);
  });

  it("gives the pre-checks their own codes", async () => {
    ctx.google.setClient({ ...FAKE_CLIENT, projectId: "", appType: "internal" });
    expect((await provision()).body.error.code).toBe("pubsub_project_missing");
    ctx.google.setClient({ ...FAKE_CLIENT, appType: "internal" });
    expect((await provision()).body.error.code).toBe("pubsub_no_account");
  });
});
