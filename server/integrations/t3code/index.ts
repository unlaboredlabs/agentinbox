// T3 Code (docs/MCP-BROKER.md, "Hermes's upstreams today"): a remote MCP preset on the generic OAuth upstream. The
// user names the server (one connection per T3 server); T3 is its own authorization server (discovery, DCR as a
// public client, PKCE S256, RFC 9207 `iss`, `resource` accepted), issues no refresh tokens and 30-day access tokens.
// T3 servers usually run on plain http over Tailscale (100.64.0.0/10) or loopback: that goes through the admin's
// private-target allow, the same as any custom connection.

import type { IntegrationPreset, SetupContext, SetupStep, ToolClass, ToolDef } from "../../broker/types.ts";
import { T3_NAME_CHECK_EXEMPT, T3_TOOLS } from "./tools.ts";

export const T3CODE_PRESET_ID = "t3code";
/** T3 serves MCP here; xaq appends it when the user gives only the address they open T3 at. */
export const T3CODE_MCP_PATH = "/mcp";

/** Preset classification; null for tools this table doesn't know (a newer T3: generic rules apply). */
export function classifyT3Tool(tool: ToolDef): ToolClass | null {
  const spec = Object.hasOwn(T3_TOOLS, tool.name) ? T3_TOOLS[tool.name] : undefined;
  if (!spec) return null;
  const cls: ToolClass = { risky: spec.cls === "risky", read: spec.cls === "read", source: "preset" };
  const props = tool.inputSchema.properties;
  if (spec.target && props && typeof props === "object" && Object.hasOwn(props, spec.target)) cls.targetPath = `/${spec.target}`;
  return cls;
}

export function t3codeSetupSteps(_ctx: SetupContext): SetupStep[] {
  return [
    {
      id: "server",
      title: "Enter your T3 Code server's address",
      body:
        "The address you open T3 Code at, such as `http://100.101.102.103:3773` on Tailscale or `http://127.0.0.1:3773` on " +
        "this computer. xaq adds `/mcp`. Plain http is accepted only on this computer and your private network " +
        "(Tailscale's 100.x addresses, 10.x, 172.16 to 172.31, 192.168.x); anywhere else T3 has to be on https. Each T3 " +
        "server is its own connection, named after its address unless you name it.",
    },
    {
      id: "pairing",
      title: "Have a T3 pairing code ready",
      body:
        "T3's approval page asks for a one-time pairing code. Make one in T3 Code under Settings → Connections, or run " +
        "`t3 auth pairing create` on the computer T3 runs on. When `t3 serve` starts it prints one too: the Token line, " +
        "which is also the part after `#token=` in its Pairing URL. A code works once and expires soon after it's made, " +
        "so get it just before you connect.",
    },
    {
      id: "access",
      title: "In T3, choose what agents may do",
      body:
        "T3 asks how much to allow. Pick the least your agents need. Read only: they read projects and threads. " +
        "Supervised (Limited on older T3 versions): they can also start, message and stop threads, and those threads " +
        "still ask before commands and file changes. The levels above it let threads run commands and edit files without " +
        "asking, and Full access also lets agents add and change projects, T3's settings and source control. We recommend " +
        "Supervised (or Limited) unless an agent needs more. Depending on the level, agents can also use T3's browser " +
        "preview, which runs in your browser profile on that computer with its saved logins: they can browse websites as you. " +
        "xaq shows what T3 granted, and still asks you before risky actions such as deleting a project, running " +
        "JavaScript in a page or uploading files to one, at the access level you choose next.",
    },
    {
      id: "reconnect",
      title: "Reconnect every 30 days",
      body:
        "A T3 sign-in lasts 30 days and T3 can't renew it. xaq reminds you 7 days and 1 day before, in the console and " +
        "through your webhooks and listener. Reconnect takes a new pairing code and keeps this connection's name, agents " +
        "and access. If it does expire, agents get a message asking you to reconnect, not a failure in the middle of a task.",
    },
  ];
}

export const t3codePreset: IntegrationPreset = {
  id: T3CODE_PRESET_ID,
  displayName: "T3 Code",
  slug: "t3",
  kind: "remote_http",
  auth: { type: "mcp_oauth" },
  classify: classifyT3Tool,
  setupSteps: t3codeSetupSteps,
  userServer: { defaultPath: T3CODE_MCP_PATH, sameOriginIssuer: true },
  nameCheckExempt: T3_NAME_CHECK_EXEMPT,
};
