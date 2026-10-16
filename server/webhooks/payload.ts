import type { MessageContent, WebhookPayload } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { toMailEvent } from "../events/repo.ts";
import type { StoredEvent } from "../events/types.ts";
import { calendarInScope } from "../policy/calendar.ts";
import { inScope, threadLabels } from "../policy/enforce.ts";
import { errorMessage } from "../util/errors.ts";

/** Webhook body data; `contentError` explains a missing `content` when the body was requested. */
export type PayloadData = WebhookPayload["data"] & { contentError?: string };

const CONTENT_TIMEOUT_MS = 20_000;

const TEST_CONTENT: MessageContent = {
  body: "This is a **test delivery** from xaq. It is not a real email.",
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
 * The Standard Webhooks body for an event, shared by webhook deliveries and `xaq listen`
 * streams. With `includeBody`, message events get cleaned content (or `contentError`), and calendar
 * events other than cancellations get the cleaned description (no `content` when there is none).
 */
export async function buildPayload(ctx: AppContext, event: StoredEvent, includeBody: boolean, opts: PayloadOptions = {}): Promise<WebhookPayload> {
  const data: PayloadData = toMailEvent(event);
  const m = event.message;
  const e = event.calendarEvent;
  if (includeBody && m && opts.isTest) data.content = TEST_CONTENT;
  else if (includeBody && m) {
    await fetchContent(data, "Message body", opts, () => ctx.mail.messageContent(event.accountId, m.id));
  } else if (includeBody && e && event.type !== "calendar.event_cancelled") {
    await fetchContent(data, "Event description", opts, () => ctx.calendar.eventContent(event.accountId, e.calendarId, e.id));
  }
  return { type: event.type, timestamp: event.createdAt, data };
}

async function fetchContent(data: PayloadData, what: string, opts: PayloadOptions, fetch: () => Promise<MessageContent | null>): Promise<void> {
  try {
    const problem = opts.bodyCheck ? await withTimeout(opts.bodyCheck(), CONTENT_TIMEOUT_MS) : null;
    if (problem) data.contentError = `${what} unavailable: ${problem}`.slice(0, 300);
    else {
      const content = await withTimeout(fetch(), CONTENT_TIMEOUT_MS);
      if (content) data.content = content;
    }
  } catch (err) {
    data.contentError = `${what} unavailable: ${errorMessage(err)}`.slice(0, 300);
  }
}

/**
 * Body access checked against the thread's labels as they are now (like MCP fetch-by-id), not the
 * labels stored with the event: a thread relabelled out of the agent's scope since then gets no body.
 * Calendar events: the grant must still read calendars and include the event's calendar.
 */
export function scopeBodyCheck(ctx: AppContext, agentId: string, event: StoredEvent): () => Promise<string | null> {
  return async () => {
    const grant = ctx.policy.grant(agentId, event.accountId);
    if (event.calendarEvent) {
      const ok = !!grant?.capabilities.includes("calendar.read") && calendarInScope(grant, event.calendarEvent.calendarId);
      return ok ? null : "not accessible";
    }
    const scope = grant?.labelScope ?? null;
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
