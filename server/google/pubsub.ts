import type { PubsubState, PubsubTestResult } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { now } from "../db/index.ts";
import { ensureWatches } from "../ingest/watch.ts";
import type { InternalState } from "../settings.ts";
import { badRequest, errorMessage, HttpError, notFound } from "../util/errors.ts";
import { randomToken } from "../util/ids.ts";
import { accountScopes, allRows, getRow } from "./accounts.ts";
import { projectId } from "./client.ts";
import { hasReason, isAbortError, sleep } from "./http.ts";
import { PUBSUB_SCOPE } from "./oauth.ts";
import { googleRuntime, type RequestOptions } from "./runtime.ts";
import { AccountNeedsReauthError, GoogleApiError } from "./types.ts";

export const TOPIC_ID = "agentinbox-gmail";
export const SUBSCRIPTION_ID = "agentinbox-gmail-pull";
export const GMAIL_PUSH_MEMBER = "serviceAccount:gmail-api-push@system.gserviceaccount.com";
const PUBLISHER_ROLE = "roles/pubsub.publisher";

type StoredPubsub = InternalState["pubsub"];

export function readPubsub(ctx: AppContext): StoredPubsub {
  return (
    ctx.settings.getState("pubsub") ?? { topic: null, subscription: null, lastError: null, lastMessageAt: null, principalAccountId: null }
  );
}

export function writePubsub(ctx: AppContext, patch: Partial<StoredPubsub>): StoredPubsub {
  const next = { ...readPubsub(ctx), ...patch };
  ctx.settings.setState("pubsub", next);
  return next;
}

export function pubsubState(ctx: AppContext): PubsubState {
  const { principalAccountId: _p, pendingPrincipalAccountId: _q, ...rest } = readPubsub(ctx);
  const principal = pubsubPrincipal(ctx);
  const pending = pendingPrincipal(ctx);
  return {
    mode: ctx.settings.get().ingestMode,
    ...rest,
    principalAccountId: principal?.id ?? null,
    principalEmail: principal?.email ?? null,
    pendingPrincipalAccountId: pending?.id ?? null,
    pendingPrincipalEmail: pending?.email ?? null,
  };
}

export interface PubsubProblem {
  /**
   * ApiError code: pubsub_scope_required | pubsub_permission_denied | pubsub_billing | pubsub_org_policy |
   * pubsub_api_disabled | gmail_api_disabled | pubsub_publish_denied | pubsub_project_not_found | needs_reauth |
   * pubsub_provision_failed (anything else).
   */
  code: string;
  message: string;
  hint: string;
}

/**
 * Explanation with a remediation hint for a provisioning/test/watch/pull failure. `email` is the
 * principal account (whose token made the call). Messages for different codes are worded so they can't
 * be mistaken for each other by text: only pubsub_scope_required talks about granting agentinbox access.
 */
/** Google Cloud console flow that enables one API in the project (same links as the console's setup guide). */
function enableApiUrl(api: string, project: string | null): string {
  return `https://console.cloud.google.com/flows/enableapi?apiid=${api}${project ? `&project=${encodeURIComponent(project)}` : ""}`;
}

export function explainPubsubError(err: unknown, project: string | null, email?: string): PubsubProblem {
  const p = project ?? "your project";
  const q = project ? `?project=${encodeURIComponent(project)}` : "";
  const who = email ?? "the account agentinbox uses for Pub/Sub";
  if (err instanceof AccountNeedsReauthError) {
    return { code: "needs_reauth", message: `${err.email} needs to be reconnected.`, hint: "Reconnect it on the Accounts page, then retry." };
  }
  if (err instanceof HttpError) return { code: err.code, message: err.message, hint: err.hint ?? "" };
  if (!(err instanceof GoogleApiError)) {
    return { code: "pubsub_provision_failed", message: errorMessage(err), hint: "Check the server log for details, then retry." };
  }
  const msg = err.message;
  const service = err.details.metadata?.service ?? "";
  const billing: PubsubProblem = {
    code: "pubsub_billing",
    message: `Google requires billing to be enabled on project ${p} to use Cloud Pub/Sub.`,
    hint:
      `Link a billing account at https://console.cloud.google.com/billing/linkedaccount${q} (Billing → Link a billing account), wait a minute, then retry. ` +
      "Gmail notifications stay far inside Pub/Sub's free tier. Or skip Pub/Sub: polling needs no billing.",
  };
  // Only Google's reason codes are trusted here; the message text is checked after the permission and API checks.
  if (hasReason(err, "BILLING_DISABLED", "billingNotEnabled", "UREQ_PROJECT_BILLING_NOT_FOUND")) return billing;
  if (hasReason(err, "SERVICE_DISABLED", "accessNotConfigured") || /has not been used in project|is disabled/i.test(msg)) {
    if (/gmail/i.test(service) || (!service && /gmail/i.test(msg))) {
      return {
        code: "gmail_api_disabled",
        message: "The Gmail API isn't enabled in the Google Cloud project.",
        hint: `Enable it at ${enableApiUrl("gmail.googleapis.com", project)}, wait a minute, then retry.`,
      };
    }
    return {
      code: "pubsub_api_disabled",
      message: "The Cloud Pub/Sub API isn't enabled in the Google Cloud project.",
      hint:
        `Enable it at ${enableApiUrl("pubsub.googleapis.com", project)}, wait a minute, then retry. ` +
        "If Google asks for a billing account and you'd rather not add one, use polling: it needs no billing.",
    };
  }
  if (hasReason(err, "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "insufficientPermissions") || /insufficient authentication scopes/i.test(msg)) {
    return scopeRequired(who, project);
  }
  if (hasReason(err, "constraints/iam.allowedPolicyMemberDomains") || /allowedPolicyMemberDomains|permitted customer|Domain Restricted Sharing/i.test(msg)) {
    return {
      code: "pubsub_org_policy",
      message:
        "Your Google Workspace organization policy (Domain Restricted Sharing, iam.allowedPolicyMemberDomains) blocks granting Gmail's push service account publish rights on the topic.",
      hint:
        `The alternative is polling: ingest keeps working in poll mode, so you can simply stay on it. For real-time Pub/Sub, an org admin with the ` +
        `Organization Policy Administrator role (roles/orgpolicy.policyAdmin) must override iam.allowedPolicyMemberDomains for project ${p} ` +
        `at https://console.cloud.google.com/iam-admin/orgpolicies${q} to allow the principal ${GMAIL_PUSH_MEMBER} ` +
        "(or allow all values on this project), then retry provisioning.",
    };
  }
  if (/Error sending test message to Cloud PubSub/i.test(msg)) {
    return {
      code: "pubsub_publish_denied",
      message: "Gmail couldn't publish to the Pub/Sub topic.",
      hint: `Make sure ${GMAIL_PUSH_MEMBER.slice("serviceAccount:".length)} has the Pub/Sub Publisher role on projects/${p}/topics/${TOPIC_ID}, then retry provisioning.`,
    };
  }
  // A JSON NOT_FOUND means the project/topic is missing; an HTML 404 (no reason) is a wrong URL or verb.
  if (err.status === 404 && err.reason) {
    return {
      code: "pubsub_project_not_found",
      message: `Google Cloud project "${p}" or its Pub/Sub resources were not found.`,
      hint: "Check the project ID in the Google step of the setup wizard (the ID, not the name or number), then retry provisioning.",
    };
  }
  if (/requires billing to be enabled|enable billing/i.test(msg)) return billing;
  if (err.status === 403 || hasReason(err, "PERMISSION_DENIED")) {
    const member = email ? `user:${email}` : "user:<email>";
    return {
      code: "pubsub_permission_denied",
      message: `${who} lacks the Google Cloud IAM role needed to create the topic and subscription in project ${p}.`,
      hint:
        `In IAM (https://console.cloud.google.com/iam-admin/iam${q}), grant ${who} the Pub/Sub Admin role (roles/pubsub.admin) or Owner ` +
        `(Editor can't change topic permissions), or run: gcloud projects add-iam-policy-binding ${p} --member=${member} --role=roles/pubsub.admin. ` +
        "Then retry, or provision with an account that already has the role (for example the project owner's).",
    };
  }
  return { code: "pubsub_provision_failed", message: `Google returned an error: ${msg}`, hint: "Retry in a minute. If it persists, check the server log." };
}

function scopeRequired(email: string, project: string | null): PubsubProblem {
  return {
    code: "pubsub_scope_required",
    message: `agentinbox needs access to Pub/Sub as ${email}.`,
    hint:
      `Grant Pub/Sub access for ${email} on Google's consent screen, then provision again. ` +
      `The account also needs Owner or Pub/Sub Admin on project ${project ?? "your project"}.`,
  };
}

/**
 * The account whose token pulls the subscription: the one the last successful provisioning used, if
 * active, else the first active account with the Pub/Sub scope, else the first active account.
 */
export function pubsubPrincipal(ctx: AppContext) {
  const stored = readPubsub(ctx).principalAccountId;
  const row = stored ? getRow(ctx, stored) : undefined;
  if (row && row.status === "active") return row;
  const candidates = allRows(ctx).filter((r) => r.status === "active");
  return candidates.find((r) => accountScopes(r).includes(PUBSUB_SCOPE)) ?? candidates[0] ?? row ?? null;
}

/** The account chosen with provision {accountId} that hasn't provisioned successfully yet (if still active). */
export function pendingPrincipal(ctx: AppContext) {
  const id = readPubsub(ctx).pendingPrincipalAccountId;
  const row = id ? getRow(ctx, id) : undefined;
  return row && row.status === "active" ? row : null;
}

/** The account provisioning (and its incremental Pub/Sub consent) uses: the pending choice, else the principal. */
export function provisioningPrincipal(ctx: AppContext) {
  return pendingPrincipal(ctx) ?? pubsubPrincipal(ctx);
}

const pubsubCall = <T>(ctx: AppContext, accountId: string, path: string, opts: RequestOptions = {}) =>
  googleRuntime(ctx).request<T>(accountId, ctx.config.google.pubsubBase, `/v1/${path}`, opts);

/** Treats 409 ALREADY_EXISTS as success. */
async function idempotent(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof GoogleApiError && (err.status === 409 || hasReason(err, "ALREADY_EXISTS"))) return;
    throw err;
  }
}

interface IamPolicy {
  version?: number;
  etag?: string;
  bindings?: { role: string; members: string[] }[];
}

/**
 * Creates the topic, grants Gmail's push service account publish rights, creates the pull subscription
 * and starts watches, as the provisioning principal. `accountId` chooses it: the choice is saved as
 * pending (so a following incremental consent, POST /api/accounts/connect {scopes: ["pubsub"]}, targets
 * it) and becomes the principal that pulls only once provisioning and its watch succeed, so a failed
 * attempt never disturbs a working setup.
 */
export async function provisionPubsub(ctx: AppContext, opts: { accountId?: string } = {}): Promise<PubsubState> {
  const project = projectId(ctx);
  if (!project) {
    throw new HttpError(400, "pubsub_project_missing", "Set your Google Cloud project ID first.", "Add the project ID in the Google step of the setup wizard.");
  }
  if (opts.accountId) {
    const chosen = getRow(ctx, opts.accountId);
    if (!chosen) throw notFound("Account");
    if (chosen.status === "needs_reauth") {
      throw new HttpError(409, "needs_reauth", `${chosen.email} needs to be reconnected first.`, "Reconnect it on the Accounts page, then provision again.");
    }
    if (chosen.status !== "active") {
      throw new HttpError(409, "account_paused", `${chosen.email} is ${chosen.status === "paused" ? "paused" : "not active"}.`, "Resume it on the Accounts page, or choose another account.");
    }
    const pending = pubsubPrincipal(ctx)?.id === chosen.id ? null : chosen.id;
    if (readPubsub(ctx).pendingPrincipalAccountId !== pending) {
      writePubsub(ctx, { pendingPrincipalAccountId: pending });
      if (pending) ctx.log.child("google").info("Pub/Sub principal chosen (pending provisioning)", { principal: chosen.email });
    }
  }
  const acct = provisioningPrincipal(ctx);
  if (!acct) {
    throw new HttpError(400, "pubsub_no_account", "Connect a Gmail account first.", "Pub/Sub is provisioned with a connected account's permissions.");
  }
  const topic = `projects/${project}/topics/${TOPIC_ID}`;
  const subscription = `projects/${project}/subscriptions/${SUBSCRIPTION_ID}`;
  const fail = (err: unknown): never => {
    if (isAbortError(err)) throw err;
    const { code, message, hint } = explainPubsubError(err, project, acct.email);
    // A failed switch to another account leaves the working principal's health alone.
    if (acct.id === pubsubPrincipal(ctx)?.id) writePubsub(ctx, { lastError: `${message} ${hint}`.trim() });
    ctx.log.child("google").warn("Pub/Sub provisioning failed", { error: errorMessage(err), principal: acct.email });
    throw new HttpError(code === "needs_reauth" ? 409 : 400, code, message, hint);
  };

  if (!accountScopes(acct).includes(PUBSUB_SCOPE)) {
    // Pub/Sub access is requested only for the provisioning account, on demand (incremental consent).
    const { code, message, hint } = scopeRequired(acct.email, project);
    throw new HttpError(409, code, message, hint);
  }
  try {
    await idempotent(() => pubsubCall(ctx, acct.id, topic, { method: "PUT", body: {} }));
    const policy = await pubsubCall<IamPolicy>(ctx, acct.id, `${topic}:getIamPolicy`, {
      query: { "options.requestedPolicyVersion": 3 },
    });
    const bindings = policy?.bindings ?? [];
    const binding = bindings.find((b) => b.role === PUBLISHER_ROLE);
    if (!binding?.members.includes(GMAIL_PUSH_MEMBER)) {
      const next = binding
        ? bindings.map((b) => (b === binding ? { ...b, members: [...b.members, GMAIL_PUSH_MEMBER] } : b))
        : [...bindings, { role: PUBLISHER_ROLE, members: [GMAIL_PUSH_MEMBER] }];
      await pubsubCall(ctx, acct.id, `${topic}:setIamPolicy`, { method: "POST", body: { policy: { ...policy, bindings: next } } });
    }
    await idempotent(() =>
      pubsubCall(ctx, acct.id, subscription, {
        method: "PUT",
        body: { topic, ackDeadlineSeconds: 60, messageRetentionDuration: "86400s", expirationPolicy: {} },
      }),
    );
  } catch (err) {
    fail(err);
  }

  writePubsub(ctx, { topic, subscription });
  // Start watches before switching modes so a Gmail-side failure (API disabled, publish denied) surfaces here.
  const results = await ensureWatches(ctx, { force: true, topic });
  const own = results.find((r) => r.accountId === acct.id);
  if (own?.error) fail(own.error);
  writePubsub(ctx, { principalAccountId: acct.id, pendingPrincipalAccountId: null, lastError: null });
  // Always broadcast, so an ingest loop that was polling while unprovisioned switches to pulling.
  ctx.settings.update({ ingestMode: "pubsub" });
  ctx.log.child("google").info("Pub/Sub provisioned", { topic, subscription, principal: acct.email });
  return pubsubState(ctx);
}

export interface PulledMessage {
  ackId: string;
  /** Parsed Gmail notification, or null for undecodable data. */
  notification: { emailAddress: string; historyId: string } | null;
}

interface RawReceived {
  ackId: string;
  message?: { data?: string; messageId?: string; attributes?: Record<string, string> };
}

/**
 * One pull on the subscription as the principal account. Test messages (from testPubsub) are acked and
 * resolved here, so they never reach ingest. Updates lastMessageAt when anything arrives.
 */
export async function pullPubsub(
  ctx: AppContext,
  opts: { signal?: AbortSignal; maxMessages?: number; returnImmediately?: boolean } = {},
): Promise<PulledMessage[]> {
  const state = readPubsub(ctx);
  if (!state.subscription) throw badRequest("Pub/Sub isn't provisioned yet.", "Provision it in the setup wizard or stay on poll mode.");
  const acct = pubsubPrincipal(ctx);
  if (!acct) throw badRequest("No active account can pull the Pub/Sub subscription.", "Connect or reconnect an account.");
  if (acct.id !== state.principalAccountId) writePubsub(ctx, { principalAccountId: acct.id });
  // Long-polling pulls wait until messages arrive; bound them so shutdown and retries stay responsive.
  // Note: aborting a pull in flight can strand messages Google already put in its response (they are
  // redelivered only after the ack deadline), so only the ingest loop long-polls, and only it aborts.
  const signal = AbortSignal.any([AbortSignal.timeout(90_000), ...(opts.signal ? [opts.signal] : [])]);
  const res = await pubsubCall<{ receivedMessages?: RawReceived[] }>(ctx, acct.id, `${state.subscription}:pull`, {
    method: "POST",
    body: { maxMessages: opts.maxMessages ?? 100, ...(opts.returnImmediately ? { returnImmediately: true } : {}) },
    signal,
    timeoutMs: opts.returnImmediately ? undefined : 0,
  });
  const received = res?.receivedMessages ?? [];
  if (!received.length) return [];
  writePubsub(ctx, { lastMessageAt: now(), lastError: null });
  const tests: string[] = [];
  const out: PulledMessage[] = [];
  const waiters = googleRuntime(ctx).pubsubTests;
  for (const r of received) {
    let data: Record<string, unknown> | null = null;
    try {
      data = JSON.parse(Buffer.from(r.message?.data ?? "", "base64").toString("utf8")) as Record<string, unknown>;
    } catch {
      // not JSON
    }
    if (typeof data?.agentinboxTest === "string") {
      tests.push(r.ackId);
      waiters.get(data.agentinboxTest)?.();
      continue;
    }
    const email = typeof data?.emailAddress === "string" ? data.emailAddress : null;
    const historyId = data?.historyId !== undefined ? String(data.historyId) : null;
    out.push({ ackId: r.ackId, notification: email && historyId ? { emailAddress: email, historyId } : null });
  }
  if (tests.length) await ackPubsub(ctx, tests).catch(() => undefined);
  return out;
}

export async function ackPubsub(ctx: AppContext, ackIds: string[]): Promise<void> {
  const state = readPubsub(ctx);
  const acct = pubsubPrincipal(ctx);
  if (!ackIds.length || !state.subscription || !acct) return;
  await pubsubCall(ctx, acct.id, `${state.subscription}:acknowledge`, { method: "POST", body: { ackIds } });
}

/** Returns messages to the subscription for immediate redelivery (ackDeadlineSeconds 0). */
export async function nackPubsub(ctx: AppContext, ackIds: string[]): Promise<void> {
  const state = readPubsub(ctx);
  const acct = pubsubPrincipal(ctx);
  if (!ackIds.length || !state.subscription || !acct) return;
  await pubsubCall(ctx, acct.id, `${state.subscription}:modifyAckDeadline`, { method: "POST", body: { ackIds, ackDeadlineSeconds: 0 } });
}

/** Publishes a test message to the topic and waits until a pull (ours or the ingest loop's) receives it. */
export async function testPubsub(ctx: AppContext, timeoutMs = 20_000): Promise<PubsubTestResult> {
  const state = readPubsub(ctx);
  const project = projectId(ctx);
  if (!state.topic || !state.subscription) return { ok: false, message: "Pub/Sub isn't provisioned yet. Run provisioning first." };
  const acct = pubsubPrincipal(ctx);
  if (!acct) return { ok: false, message: "Connect a Gmail account first." };
  const nonce = randomToken(16);
  const waiters = googleRuntime(ctx).pubsubTests;
  let resolve!: () => void;
  const received = new Promise<void>((r) => (resolve = r));
  waiters.set(nonce, resolve);
  const started = Date.now();
  let got = false;
  void received.then(() => (got = true));
  try {
    const data = Buffer.from(JSON.stringify({ agentinboxTest: nonce })).toString("base64");
    await pubsubCall(ctx, acct.id, `${state.topic}:publish`, { method: "POST", body: { messages: [{ data }] } });
    // Pull ourselves too, in case the ingest loop isn't running in pubsub mode. These pulls return
    // immediately and are never aborted mid-flight: an abandoned pull would strand whatever Google put
    // in its response (e.g. a Gmail notification) until the ack deadline.
    while (!got && Date.now() - started < timeoutMs) {
      const msgs = await pullPubsub(ctx, { maxMessages: 10, returnImmediately: true });
      // Real Gmail notifications we happened to pull go straight back to the subscription for the ingest loop.
      await nackPubsub(ctx, msgs.map((m) => m.ackId));
      if (!got) await Promise.race([received, sleep(250)]);
    }
    if (got) {
      const ms = Date.now() - started;
      writePubsub(ctx, { lastError: null });
      return { ok: true, message: `Published and received a test message in ${ms} ms. Pub/Sub is working.` };
    }
    return {
      ok: false,
      message: `Published a test message but didn't receive it within ${Math.round(timeoutMs / 1000)}s. Check that ${state.subscription} is attached to ${state.topic}.`,
    };
  } catch (err) {
    const { message, hint } = explainPubsubError(err, project, acct.email);
    writePubsub(ctx, { lastError: `${message} ${hint}`.trim() });
    return { ok: false, message: `${message} ${hint}`.trim() };
  } finally {
    waiters.delete(nonce);
  }
}
