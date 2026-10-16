// SourceError → plain words for the agent (docs/MCP-BROKER.md "Every failure names its fix").

import { errorMessage } from "../../util/errors.ts";
import { SourceError, type SourceErrorCode } from "../types.ts";
import type { Scrubber } from "./output.ts";

export interface DescribedFailure {
  /** Audit reason: the SourceError code, or "internal". */
  reason: SourceErrorCode | "internal";
  message: string;
  /** The call may have reached the upstream (and done something): counted toward risky caps, never retried. */
  maybeRan: boolean;
}

/** Codes where the upstream never got the call. Anything else may have run. */
const NOT_SENT = new Set<SourceErrorCode>(["needs_reauth", "blocked_target", "rate_limited"]);

export const reconnectMessage = (name: string) =>
  `The owner must reconnect ${name} in agentinbox (Connections → Reconnect) before its tools work again. Nothing was sent to ${name}.`;

export function describeFailure(err: unknown, connectionName: string, scrubber: Scrubber): DescribedFailure {
  const detail = (msg: string) => {
    const s = scrubber.scrub(msg.replace(/\s+/g, " ").trim().slice(0, 300)).text;
    return s ? ` (${s})` : "";
  };
  if (!(err instanceof SourceError)) {
    return {
      reason: "internal",
      message: `The call to ${connectionName} failed${detail(errorMessage(err))}. It may or may not have run there: check before trying again.`,
      maybeRan: true,
    };
  }
  const maybeRan = !NOT_SENT.has(err.code);
  switch (err.code) {
    case "needs_reauth":
      return { reason: err.code, message: reconnectMessage(connectionName), maybeRan };
    case "timeout":
      return {
        reason: err.code,
        message: `${connectionName} didn't answer in time. The call may or may not have run there: check before trying again.`,
        maybeRan,
      };
    case "rate_limited": {
      const secs = err.retryAfterMs ? Math.max(1, Math.ceil(err.retryAfterMs / 1000)) : null;
      return {
        reason: err.code,
        message: `${connectionName} is limiting requests right now. ${secs ? `Try again in ${secs} second${secs === 1 ? "" : "s"}.` : "Try again in a minute."} Nothing was sent.`,
        maybeRan,
      };
    }
    case "blocked_target":
      return {
        reason: err.code,
        message: `agentinbox blocked the connection to ${connectionName}: its address is on a private or blocked network. Nothing was sent. The owner can allow this host for the connection in agentinbox (Connections → ${connectionName}).`,
        maybeRan,
      };
    case "unavailable":
      return {
        reason: err.code,
        message: `${connectionName} is unavailable right now${detail(err.message)}. The call may or may not have run there: check before trying again.`,
        maybeRan,
      };
    case "protocol":
      return {
        reason: err.code,
        message: `${connectionName} sent an answer agentinbox couldn't understand${detail(err.message)}. The call may or may not have run there: check before trying again.`,
        maybeRan,
      };
  }
}
