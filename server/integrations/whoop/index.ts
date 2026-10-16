// The WHOOP preset (docs/MCP-BROKER.md, "WHOOP: native, each user's own app").

import type { IntegrationPreset, NativeEvents } from "../../broker/types.ts";
import { WHOOP_AUTHORIZE_URL, WHOOP_SCOPES, WHOOP_TOKEN_URL } from "./api.ts";
import { createWhoopEvents } from "./events.ts";
import { CLIENT_ID_INPUT, CLIENT_SECRET_INPUT } from "./oauth.ts";
import { whoopSetupSteps } from "./setup.ts";
import { createWhoopSource } from "./tools.ts";

export { WHOOP_USER_ID_KEY, authorizeUrl, checkClient, exchangeCode, whoopClientFrom, whoopRefreshFn, whoopUserIdFrom } from "./oauth.ts";
export type { WhoopClient, WhoopOAuthConnection } from "./oauth.ts";

export interface WhoopPresetOptions {
  now?: () => number;
}

export function whoopPreset(opts: WhoopPresetOptions = {}): IntegrationPreset {
  // One events instance per preset: it holds the trace_id dedupe memory.
  const events: NativeEvents = createWhoopEvents({ now: opts.now });
  return {
    id: "whoop",
    displayName: "WHOOP",
    slug: "whoop",
    kind: "native",
    auth: {
      type: "user_app",
      authorizeUrl: WHOOP_AUTHORIZE_URL,
      tokenUrl: WHOOP_TOKEN_URL,
      scopes: [...WHOOP_SCOPES],
      clientIdInput: CLIENT_ID_INPUT,
      clientSecretInput: CLIENT_SECRET_INPUT,
    },
    // Every WHOOP tool reads; nothing is risky.
    classify: () => ({ risky: false, read: true, source: "preset" }),
    setupSteps: whoopSetupSteps,
    createSource: (deps) => createWhoopSource(deps, { now: opts.now }),
    events,
  };
}
