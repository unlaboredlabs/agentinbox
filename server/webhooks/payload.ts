import type { MessageContent, WebhookPayload } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { toMailEvent } from "../events/repo.ts";
import type { StoredEvent } from "../events/types.ts";
import { inScope, threadLabels } from "../policy/enforce.ts";
import { errorMessage } from "../util/errors.ts";

/** Webhook body data; `contentError` explains a missing `content` when the body was requested. */
export type PayloadData = WebhookPayload["data"] & { contentError?: string };

const CONTENT_TIMEOUT_MS = 20_000;

const TEST_CONTENT: MessageContent = {
  body: "This is a **test delivery** from agentinbox. It is not a real email.",
  truncated: false,
  attachments: [],
  signals: { hiddenContentRemoved: false, suspiciousInstructions: [], auth: null, external: true },
};

export interface PayloadOptions {
  /** Synthetic webhook test event: canned content instead of a Gmail fetch. */
  isTest?: boolean;
  /**
   * Checked before fetching the body (e.g. the thread's current labels against the label scope).
   * Resolve to an error message to skip the body and report it as `contentError`.
   */
  bodyCheck?: () => Promise<string | null>;
}

/**
 * The Standard Webhooks body for an event, shared by webhook deliveries and `agentinbox listen`
 * streams. With `includeBody`, message events get cleaned content (or `contentError`).
 */
export async function buildPayload(ctx: AppContext, event: StoredEvent, includeBody: boolean, opts: PayloadOptions = {}): Promise<WebhookPayload> {
  const data: PayloadData = toMailEvent(event);
  if (includeBody && event.message) {
    if (opts.isTest) data.content = TEST_CONTENT;
    else {
      try {
        const problem = opts.bodyCheck ? await withTimeout(opts.bodyCheck(), CONTENT_TIMEOUT_MS) : null;
        if (problem) data.contentError = `Message body unavailable: ${problem}`.slice(0, 300);
        else data.content = await withTimeout(ctx.mail.messageContent(event.accountId, event.message.id), CONTENT_TIMEOUT_MS);
      } catch (err) {
        data.contentError = `Message body unavailable: ${errorMessage(err)}`.slice(0, 300);
      }
    }
  }
  return { type: event.type, timestamp: event.createdAt, data };
}

/**
 * Body access checked against the thread's labels as they are now (like MCP fetch-by-id), not the
 * labels stored with the event: a thread relabelled out of the agent's scope since then gets no body.
 */
export function scopeBodyCheck(ctx: AppContext, agentId: string, event: StoredEvent): () => Promise<string | null> {
  return async () => {
    const scope = ctx.policy.grant(agentId, event.accountId)?.labelScope ?? null;
    if (scope === null || !event.message) return null;
    const thread = await ctx.google.gmail(event.accountId).getThread(event.message.threadId, "minimal");
    return inScope(scope, threadLabels(thread)) ? null : "not accessible";
  };
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new Error(`timed out after ${ms / 1000} s`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}
