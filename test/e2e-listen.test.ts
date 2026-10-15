// E2E placeholder: `agentinbox connect` (device-flow pairing) + `agentinbox listen` (event stream →
// local command). The feature is being built on feat/listen-{base,server,client}; un-skip once it is
// merged into integration. Harness hooks are ready in test/e2e/listen.ts:
//   startPairing / pollPairing / findPairing / approvePairing / denyPairing   (pairing, both sides)
//   openAgentStream                                                         (/agent/v1/events/stream)
//   spawnCli(["connect" | "listen", …], { home })                           (the real CLI, isolated HOME)
//   commandRecorder(dir)                                                    (exec target: records stdin/env; canary file)
// plus the usual Stack (startStack/bootstrap/connectAccount/createAgent/fake.deliver) from test/e2e/harness.ts.

import { describe, it } from "vitest";
import "./e2e/listen.ts";

describe.skip("listen", () => {
  describe("pairing (device flow)", () => {
    it.todo("connect prints a user code; the console lists it under /api/pairings; approving with a grant delivers the key to the polling CLI exactly once (later polls: consumed)");
    it.todo("the approved agent gets sendMode draft_only by default and the key file is written with mode 0600");
    it.todo("deny: the CLI reports the denial with the console's note and exits non-zero; no agent is created");
    it.todo("expire: an unapproved code expires; polls return expired; approving it afterwards fails with 409");
    it.todo("polling faster than `interval` returns slow_down; pairing is refused when settings.pairingEnabled is false");
    it.todo("every pairing step (request, approve/deny, expiry, key delivery) is in /api/audit and the console SSE stream emits kind=pairing");
  });

  describe("listen (event stream → command)", () => {
    it.todo("a delivered email reaches the listener and the exec command runs once with the WebhookPayload JSON on stdin (and AGENTINBOX_* env)");
    it.todo("include_body: the payload carries cleaned content (hidden text removed), same as webhooks");
    it.todo("a subject containing shell syntax ($(touch canary), `…`, ; rm, quotes) never reaches the shell: the canary file does not exist and stdin has the literal subject");
    it.todo("reconnect resumes: kill the listener, deliver mail, restart it with the same consumer: missed events arrive once, in order, nothing re-delivered after ack");
    it.todo("server restart: the listener reconnects with Last-Event-ID and continues without duplicates");
    it.todo("revoke kills the stream: rotating the key, disabling/deleting the agent or deleting its grant sends event: revoked and closes the connection");
    it.todo("scope filtering: a label-scoped agent's listener only receives events for threads in scope; types= and the listener filter narrow further");
    it.todo("the agent's listeners (consumer, connected, ackedSeq) show up in GET /api/agents/:id");
    it.todo("forward mode: events are POSTed to a localhost URL signed per Standard Webhooks (verifyStandardWebhook)");
  });
});
