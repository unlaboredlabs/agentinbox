// Everything the console tells people to paste into a terminal: the npm package name, the
// `connect` / `listen` commands and per-tool recipes. Mirrors server/listen/recipes.ts (agent side).

import type { AgentTool } from "@shared/agent-api";

/** The npm package; the command it installs is `agentinbox`. Swap for NPM_PACKAGE from @shared/types once it exists. */
export const NPM_PACKAGE = "agentinbox-cli";
export const NPX = `npx ${NPM_PACKAGE}`;

export const TOOLS: AgentTool[] = ["claude-code", "codex", "cursor", "hermes", "other"];

export const TOOL_LABEL: Record<AgentTool, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  hermes: "Hermes",
  other: "Other",
};

export interface Recipe {
  /** What the CLI's own recipe (`listen --print-recipe <tool>`) does and doesn't confine. */
  note: string;
}

/**
 * The console never spells out `listen --exec` commands itself: for known tools it defers to
 * `listen --print-recipe <tool>`, so the confined command (and this machine's paths) always come
 * from the CLI that runs it. The trigger is an email anyone can send, so confinement matters.
 */
export const RECIPES: Record<AgentTool, Recipe> = {
  "claude-code": {
    note: "Claude reads the event from stdin with its built-in tools turned off, only the agentinbox MCP server loaded and project settings ignored.",
  },
  codex: {
    note: "Codex runs in a read-only sandbox with its shell tool off. Other MCP servers you configured stay available, so give listener agents draft-only access.",
  },
  cursor: {
    note: "Cursor's CLI can't be confined by flags: deny other tools in its permissions config (see docs/listen.md) and give listener agents draft-only access.",
  },
  hermes: {
    note: "Hermes runs one prompt with only the agentinbox toolset enabled.",
  },
  other: {
    note: "Your command gets the event as JSON on stdin (also in $AGENTINBOX_EVENT_FILE). Exit 0 when done; anything else is retried.",
  },
};

/** Single-quotes a string for POSIX shells. */
export const shellQuote = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'"'"'`)}'`);

// ───────────── Transport rule ─────────────

function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

export type Transport = "https" | "loopback" | "tailscale" | "insecure" | "invalid";

/**
 * Same rule as the CLI (server/listen/transport.ts): the agent's key crosses the network on every
 * request, so plain http is only fine to loopback or over Tailscale (100.64.0.0/10, *.ts.net).
 * The CLI refuses anything else unless --insecure is passed.
 */
export function transportOf(publicUrl: string): Transport {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return "invalid";
  }
  if (url.protocol === "https:") return "https";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return "loopback";
  const v4 = ipv4(host);
  if (v4 && v4[0] === 127) return "loopback";
  if (v4 && v4[0] === 100 && v4[1]! >= 64 && v4[1]! <= 127) return "tailscale";
  if (host.endsWith(".ts.net")) return "tailscale";
  // Tailscale's IPv6 range fd7a:115c:a1e0::/48 (URL hosts are normalized to lowercase, compressed form).
  if (/^fd7a:115c:a1e0:/.test(host)) return "tailscale";
  return "insecure";
}

// ───────────── Commands ─────────────

export interface ConnectCommands {
  connect: string;
  listen: string;
  selfSetup: string;
  skillInstall: string;
  insecure: boolean;
}

/** `acceptInsecure`: the human explicitly accepted plain http; only then is --insecure added. */
export function connectCommands(publicUrl: string, tool: AgentTool, acceptInsecure = false): ConnectCommands {
  const insecure = transportOf(publicUrl) === "insecure";
  const flag = insecure && acceptInsecure ? " --insecure" : "";
  const toolFlags = tool === "other" ? "" : ` --tool ${tool} --setup-mcp`;
  return {
    connect: `${NPX} connect ${shellQuote(publicUrl)}${toolFlags}${flag}`,
    listen:
      tool === "other"
        ? `${NPX} listen service install --exec /path/to/handle-email.sh${flag}`
        : `${NPX} listen service install --exec "$(${NPX} listen --print-recipe ${tool})"${flag}`,
    selfSetup: `Read ${publicUrl}/skill.md and set yourself up with agentinbox.`,
    skillInstall: `${NPX} skill install --url ${shellQuote(publicUrl)}`,
    insecure,
  };
}
