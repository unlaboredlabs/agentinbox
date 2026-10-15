import type { PubsubState, PubsubTestResult } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { now } from "../db/index.ts";
import { ensureWatches } from "../ingest/watch.ts";
import type { InternalState } from "../settings.ts";
import { badRequest, errorMessage, HttpError } from "../util/errors.ts";
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
  const { principalAccountId: _p, ...rest } = readPubsub(ctx);
  return { mode: ctx.settings.get().ingestMode, ...rest };
}

/** Human-readable explanation with a remediation hint for a provisioning/test/watch failure. */
export function explainPubsubError(err: unknown, project: string | null, email?: string): { message: string; hint: string } {
  const p = project ?? "your project";
  if (err instanceof AccountNeedsReauthError) {
    return { message: `${err.email} needs to be reconnected.`, hint: "Reconnect it on the Accounts page, then retry." };
  }
  if (err instanceof HttpError) return { message: err.message, hint: err.hint ?? "" };
  if (!(err instanceof GoogleApiError)) return { message: errorMessage(err), hint: "Check the server log for details, then retry." };
  const msg = err.message;
  const service = err.details.metadata?.service ?? "";
  if (hasReason(err, "SERVICE_DISABLED", "accessNotConfigured") || /has not been used in project|is disabled/i.test(msg)) {
    if (/gmail/i.test(service) || (!service && /gmail/i.test(msg))) {
      return {
        message: "The Gmail API isn't enabled in the Google Cloud project.",
        hint: `Enable it at https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=${p}, wait a minute, then retry.`,
      };
    }
    return {
      message: "The Cloud Pub/Sub API isn't enabled in the Google Cloud project.",
      hint: `Enable it at https://console.cloud.google.com/apis/library/pubsub.googleapis.com?project=${p}, wait a minute, then retry.`,
    };
  }
  if (hasReason(err, "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "insufficientPermissions") || /insufficient authentication scopes/i.test(msg)) {
    return {
      message: `${email ?? "The account"} didn't grant agentinbox access to Pub/Sub.`,
      hint: "Reconnect the account on the Accounts page and keep every permission checked on Google's consent screen, then retry.",
    };
  }
  if (hasReason(err, "constraints/iam.allowedPolicyMemberDomains") || /allowedPolicyMemberDomains|permitted customer|Domain Restricted Sharing/i.test(msg)) {
    return {
      message:
        "Your Google Workspace organization policy (Domain Restricted Sharing, iam.allowedPolicyMemberDomains) blocks granting Gmail's push service account access to the topic.",
      hint:
        "Ingest keeps working in poll mode, so you can simply stay on polling. For real-time Pub/Sub, ask your org admin to allow an exception for " +
        `project ${p} (override iam.allowedPolicyMemberDomains on the project), or use a project outside the organization.`,
    };
  }
  if (/Error sending test message to Cloud PubSub/i.test(msg)) {
    return {
      message: "Gmail couldn't publish to the Pub/Sub topic.",
      hint: `Make sure ${GMAIL_PUSH_MEMBER.slice("serviceAccount:".length)} has the Pub/Sub Publisher role on projects/${p}/topics/${TOPIC_ID}, then retry provisioning.`,
    };
  }
  // A JSON NOT_FOUND means the project/topic is missing; an HTML 404 (no reason) is a wrong URL or verb.
  if (err.status === 404 && err.reason) {
    return {
      message: `Google Cloud project "${p}" or its Pub/Sub resources were not found.`,
      hint: "Check the project ID in the Google step of the setup wizard (the ID, not the name or number), then retry provisioning.",
    };
  }
  if (err.status === 403 || hasReason(err, "PERMISSION_DENIED")) {
    return {
      message: `${email ?? "The account"} doesn't have permission to manage Pub/Sub in project ${p}.`,
      hint: "Grant that account Owner or Pub/Sub Admin (roles/pubsub.admin) on the project in IAM & Admin (Editor can't change topic permissions), or connect an account that has it, then retry.",
    };
  }
  return { message: `Google returned an error: ${msg}`, hint: "Retry in a minute. If it persists, check the server log." };
}

/** The account whose token manages and pulls the subscription: the stored one if usable, else the first active account. */
export function pubsubPrincipal(ctx: AppContext) {
  const stored = readPubsub(ctx).principalAccountId;
  const row = stored ? getRow(ctx, stored) : undefined;
  if (row && row.status === "active") return row;
  const candidates = allRows(ctx).filter((r) => r.status === "active");
  return candidates.find((r) => accountScopes(r).includes(PUBSUB_SCOPE)) ?? candidates[0] ?? row ?? null;
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

export async function provisionPubsub(ctx: AppContext): Promise<PubsubState> {
  const project = projectId(ctx);
  if (!project) {
    throw badRequest("Set your Google Cloud project ID first.", "Add the project ID in the Google step of the setup wizard.");
  }
  const acct = pubsubPrincipal(ctx);
  if (!acct) throw badRequest("Connect a Gmail account first.", "Pub/Sub is provisioned with a connected account's permissions.");
  const topic = `projects/${project}/topics/${TOPIC_ID}`;
  const subscription = `projects/${project}/subscriptions/${SUBSCRIPTION_ID}`;
  const fail = (err: unknown): never => {
    if (isAbortError(err)) throw err;
    const { message, hint } = explainPubsubError(err, project, acct.email);
    writePubsub(ctx, { lastError: `${message} ${hint}`.trim() });
    ctx.log.child("google").warn("Pub/Sub provisioning failed", { error: errorMessage(err) });
    throw new HttpError(400, "pubsub_provision_failed", message, hint);
  };

  if (!accountScopes(acct).includes(PUBSUB_SCOPE)) {
    // Pub/Sub access is requested only for the provisioning account, on demand (incremental consent).
    throw new HttpError(
      409,
      "pubsub_scope_required",
      `agentinbox needs permission to manage Pub/Sub as ${acct.email}.`,
      `Grant Pub/Sub access for ${acct.email} on Google's consent screen, then provision again. ` +
        `The account also needs Owner or Pub/Sub Admin on project ${project}.`,
    );
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

  writePubsub(ctx, { topic, subscription, principalAccountId: acct.id, lastError: null });
  // Start watches before switching modes so a Gmail-side failure (API disabled, publish denied) surfaces here.
  const results = await ensureWatches(ctx, { force: true, topic });
  const own = results.find((r) => r.accountId === acct.id);
  if (own?.error) fail(own.error);
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
export async function pullPubsub(ctx: AppContext, opts: { signal?: AbortSignal; maxMessages?: number } = {}): Promise<PulledMessage[]> {
  const state = readPubsub(ctx);
  if (!state.subscription) throw badRequest("Pub/Sub isn't provisioned yet.", "Provision it in the setup wizard or stay on poll mode.");
  const acct = pubsubPrincipal(ctx);
  if (!acct) throw badRequest("No active account can pull the Pub/Sub subscription.", "Connect or reconnect an account.");
  if (acct.id !== state.principalAccountId) writePubsub(ctx, { principalAccountId: acct.id });
  // Real pulls long-poll until messages arrive; bound them so shutdown and retries stay responsive.
  const signal = AbortSignal.any([AbortSignal.timeout(90_000), ...(opts.signal ? [opts.signal] : [])]);
  const res = await pubsubCall<{ receivedMessages?: RawReceived[] }>(ctx, acct.id, `${state.subscription}:pull`, {
    method: "POST",
    body: { maxMessages: opts.maxMessages ?? 100 },
    signal,
    timeoutMs: 0,
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

/** Publishes a test message to the topic and waits until a pull (ours or the ingest loop's) receives it. */
/** Returns messages to the subscription for immediate redelivery (ackDeadlineSeconds 0). */
export async function nackPubsub(ctx: AppContext, ackIds: string[]): Promise<void> {
  const state = readPubsub(ctx);
  const acct = pubsubPrincipal(ctx);
  if (!ackIds.length || !state.subscription || !acct) return;
  await pubsubCall(ctx, acct.id, `${state.subscription}:modifyAckDeadline`, { method: "POST", body: { ackIds, ackDeadlineSeconds: 0 } });
}

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
  const stop = new AbortController();
  try {
    const data = Buffer.from(JSON.stringify({ agentinboxTest: nonce })).toString("base64");
    await pubsubCall(ctx, acct.id, `${state.topic}:publish`, { method: "POST", body: { messages: [{ data }] } });
    const deadline = AbortSignal.any([stop.signal, AbortSignal.timeout(timeoutMs)]);
    // Pull ourselves too, in case the ingest loop isn't running in pubsub mode.
    const pulling = (async () => {
      while (!deadline.aborted) {
        const msgs = await pullPubsub(ctx, { signal: deadline, maxMessages: 10 }).catch((err: unknown) => {
          if (!isAbortError(err)) throw err;
          return [];
        });
        // Real Gmail notifications we happened to pull go straight back to the subscription for the ingest loop.
        await nackPubsub(ctx, msgs.map((m) => m.ackId));
        if (msgs.length) await sleep(250, deadline);
      }
    })();
    const outcome = await Promise.race([
      received.then(() => "ok" as const),
      pulling.then(() => "timeout" as const),
    ]);
    stop.abort();
    await pulling.catch(() => undefined);
    if (outcome === "ok") {
      const ms = Date.now() - started;
      writePubsub(ctx, { lastError: null });
      return { ok: true, message: `Published and received a test message in ${ms} ms. Pub/Sub is working.` };
    }
    return {
      ok: false,
      message: `Published a test message but didn't receive it within ${Math.round(timeoutMs / 1000)}s. Check that ${state.subscription} is attached to ${state.topic}.`,
    };
  } catch (err) {
    stop.abort();
    const { message, hint } = explainPubsubError(err, project, acct.email);
    writePubsub(ctx, { lastError: `${message} ${hint}`.trim() });
    return { ok: false, message: `${message} ${hint}`.trim() };
  } finally {
    waiters.delete(nonce);
  }
}
