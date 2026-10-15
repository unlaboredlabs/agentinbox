// The Verify step's checks as a pure function of what the console knows, so they can be tested
// directly. No React and relative imports only (no @ aliases): vitest and the server/test typecheck
// load this module too.

import type { AuditEntry, EventType, ListenerInfo, MailEvent, TestEmailResult } from "../../../shared/types.ts";
import { listenerHandled } from "../agents/listener-handled.ts";

export const TEST_SUBJECT = "agentinbox test: your setup works";
/** A test email older than this is forgotten: its events may have scrolled out of the first page. */
export const TEST_TTL_MS = 60 * 60_000;
/** Read-type tools: the agent reading the test email over MCP. */
export const READ_TOOLS = new Set(["search_threads", "get_thread", "get_message", "list_events", "wait_for_events"]);

export interface VerifyTest extends TestEmailResult {
  accountId: string;
  /**
   * Consumers of the listeners that existed (connected or not) when the test was sent. Only these count for delivery: a
   * listener that connects later starts its cursor at the newest event, so its ackedSeq passes the
   * test email without ever having handled it.
   */
  listenersAtSend?: string[];
}

/** The test, unless it is too old to still be found among recent events. */
export function activeTest(test: VerifyTest | undefined, now: number): VerifyTest | undefined {
  return test && now - Date.parse(test.sentAt) < TEST_TTL_MS ? test : undefined;
}

export interface VerifyInput {
  test: VerifyTest | undefined;
  /** Recent events of the test's account, newest first. */
  events: MailEvent[];
  listeners: ListenerInfo[];
  /** This agent's MCP tool calls (audit entries), newest first. */
  calls: AuditEntry[];
  skipListen: boolean;
}

export interface VerifyResult {
  sent: boolean;
  received: MailEvent | undefined;
  /** A listener that was connected at send time has acknowledged the test email. */
  delivered: boolean;
  /** Received and not delivered, none of the listeners known at send time is connected, but another one is: send another. */
  resendForListener: boolean;
  /** The agent read mail over MCP (successfully) after the test was sent. */
  readIt: boolean;
  /**
   * Received and not delivered, and every listener known at send time asked for event types without
   * message.received (e.g. `--types thread.reply_received`): it acks the test email without running
   * its command. The types they asked for (sorted, no duplicates); null otherwise.
   */
  typesExcludeIt: EventType[] | null;
}

export function verifyChecks({ test, events, listeners, calls, skipListen }: VerifyInput): VerifyResult {
  if (!test) return { sent: false, received: undefined, delivered: false, resendForListener: false, readIt: false, typesExcludeIt: null };
  const ofTest = events.filter(
    (e) => e.accountId === test.accountId && (e.message?.id === test.messageId || (e.message?.subject === TEST_SUBJECT && e.createdAt >= test.sentAt)),
  );
  const received = ofTest.find((e) => e.type === "message.received") ?? ofTest[0];
  const atSend = new Set(test.listenersAtSend ?? []);
  // Of a type the listener asked for, past where its cursor started, and acked (see listenerHandled).
  const delivered = !!received && listeners.some((l) => atSend.has(l.consumer) && listenerHandled(l, received));
  const recorded = listeners.filter((l) => atSend.has(l.consumer));
  const excluding =
    received?.type === "message.received" && !delivered && recorded.length > 0 && recorded.every((l) => l.types && !l.types.includes(received.type));
  return {
    typesExcludeIt: excluding ? [...new Set(recorded.flatMap((l) => l.types ?? []))].sort() : null,
    sent: true,
    received,
    delivered,
    resendForListener:
      !!received && !skipListen && !delivered && !listeners.some((l) => atSend.has(l.consumer) && l.connected) && listeners.some((l) => l.connected),
    readIt: calls.some((e) => e.outcome === "ok" && READ_TOOLS.has(e.action) && e.ts >= test.sentAt),
  };
}

export interface ChecksState {
  mcpDone: boolean;
  listenDone: boolean;
  skipListen: boolean;
  sent: boolean;
  received: boolean;
  delivered: boolean;
}

/**
 * Every required check is green: what shows "Setup complete" and, from then on, marks step 8 done in
 * this browser (SetupDraft.verified) without waiting for "Finish setup". Reading the mail is optional.
 */
export function checksComplete({ mcpDone, listenDone, skipListen, sent, received, delivered }: ChecksState): boolean {
  return mcpDone && (listenDone || skipListen) && sent && received && (delivered || skipListen);
}
