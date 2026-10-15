import type { TestEmailResult } from "../../shared/types.ts";
import { ADMIN_ACTOR } from "../api/util.ts";
import type { AppContext } from "../context.ts";
import { now } from "../db/index.ts";
import { errorMessage, HttpError } from "../util/errors.ts";
import { googleRuntime } from "./runtime.ts";

/**
 * Header that marks the setup test email. Ingest reports a self-addressed message as message.sent
 * only; for this one it also emits message.received, so webhooks and listeners left on the default
 * "message.received" filter see the test arrive too.
 */
export const TEST_EMAIL_HEADER = "X-Agentinbox-Test";
export const TEST_EMAIL_SUBJECT = "agentinbox test: your setup works";

const LIMIT = 5;
const WINDOW_MS = 10 * 60_000;

const BODY = `This message was sent by agentinbox to check that mail delivery works end to end: \
agentinbox sent it from this account to itself through the Gmail API, and should report it as a new \
event within moments.

Nobody else received it. It's safe to delete.
`;

/** POST /api/accounts/:id/test-email. */
export async function sendTestEmail(ctx: AppContext, accountId: string): Promise<TestEmailResult> {
  const account = ctx.accounts.require(accountId);
  if (account.status === "paused") {
    throw new HttpError(409, "account_paused", `${account.email} is paused.`, "Resume the account first: paused accounts don't pick up new mail, so the test would never arrive.");
  }

  const sent = googleRuntime(ctx).testEmails;
  const t = Date.now();
  const recent = (sent.get(account.id) ?? []).filter((at) => t - at < WINDOW_MS);
  if (recent.length >= LIMIT) {
    const retryMin = Math.max(1, Math.ceil((recent[0]! + WINDOW_MS - t) / 60_000));
    throw new HttpError(
      429,
      "rate_limited",
      `Already sent ${LIMIT} test emails from ${account.email} in the last 10 minutes.`,
      `Try again in ${retryMin} minute${retryMin === 1 ? "" : "s"}. Earlier test emails are in the account's inbox; check Events for them.`,
    );
  }
  recent.push(t);
  sent.set(account.id, recent);

  const self = { name: account.displayName, email: account.email };
  try {
    const raw = await ctx.google.mime.compose({
      from: self,
      to: [self],
      subject: TEST_EMAIL_SUBJECT,
      text: BODY,
      headers: { [TEST_EMAIL_HEADER]: "setup" },
    });
    const msg = await ctx.google.gmail(account.id).send(raw);
    const result: TestEmailResult = { messageId: msg.id, threadId: msg.threadId, sentAt: now() };
    ctx.audit.record({ ...ADMIN_ACTOR, action: "account.test_email", accountId: account.id, target: msg.id, outcome: "ok", detail: { email: account.email } });
    ctx.ingest.kick(account.id);
    return result;
  } catch (err) {
    ctx.audit.record({
      ...ADMIN_ACTOR,
      action: "account.test_email",
      accountId: account.id,
      outcome: "error",
      detail: { email: account.email, error: errorMessage(err) },
    });
    throw err;
  }
}
