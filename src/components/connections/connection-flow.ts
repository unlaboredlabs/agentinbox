// Console decisions for broker connections (docs/MCP-BROKER.md) as pure functions, so they can be tested directly:
// a connection's status in plain words, the Add connection draft, what a probe found, access levels, held-tool
// notices and diffs. No React and relative imports only: vitest and the server typecheck load this module too.

import type {
  AccessLevel,
  AgentLevel,
  Connection,
  ConnectionOAuthMessage,
  CreateConnectionInput,
  HeldTool,
  PresetView,
  ProbeResult,
  SetupStep,
} from "../../lib/broker-dto.ts";

/** A subset of the console's Tone (src/lib/labels.ts). */
type Tone = "good" | "warn" | "bad" | "idle";

const DAY = 86_400_000;

// ───────────── Access levels ─────────────

export const ACCESS_LEVELS = ["full", "ask", "read"] as const satisfies readonly AccessLevel[];
export const DEFAULT_LEVEL: AccessLevel = "ask";

export const LEVEL_INFO: Record<AgentLevel, { label: string; description: string }> = {
  full: { label: "Full access", description: "Agents use every tool without asking you." },
  ask: {
    label: "Ask before risky actions",
    description: "Reading, creating and editing go straight through. Deleting, sending, sharing outside and payments wait for your approval.",
  },
  read: { label: "Read only", description: "Agents can only look things up. Tools that change anything are hidden." },
  none: { label: "No access", description: "This agent doesn't see this connection's tools." },
};

export const AGENT_LEVELS = ["full", "ask", "read", "none"] as const satisfies readonly AgentLevel[];

// ───────────── Status ─────────────

/** Whole days until `iso` (rounded up), negative once past. */
export function daysLeft(iso: string, now: number): number {
  return Math.ceil((Date.parse(iso) - now) / DAY);
}

export interface ConnectionStatusView {
  label: string;
  tone: Tone;
  /** One sentence; names the fix when there is one. */
  description: string;
  /** The button that fixes it. */
  action: "reconnect" | "enable" | null;
}

/** A connection's badge: active / needs reconnect / expiring in N days / disabled. Warns from 7 days before a reconnect date. */
export function connectionStatusView(c: Pick<Connection, "status" | "statusReason" | "reconnectBy" | "displayName">, now: number): ConnectionStatusView {
  switch (c.status) {
    case "disabled":
      return { label: "Disabled", tone: "idle", description: "Agents don't see its tools. Turn it back on to use it again.", action: "enable" };
    case "needs_reauth":
      return {
        label: "Needs reconnect",
        tone: "bad",
        description: `${c.statusReason ?? "Its sign-in stopped working."} Agents' calls to ${c.displayName} fail until you reconnect.`,
        action: "reconnect",
      };
    case "error":
      return {
        label: "Error",
        tone: "bad",
        description: `${c.statusReason ?? "The server isn't answering."} Reconnecting often fixes it.`,
        action: "reconnect",
      };
    case "active": {
      if (!c.reconnectBy) return { label: "Active", tone: "good", description: "Working.", action: null };
      const days = daysLeft(c.reconnectBy, now);
      if (days <= 0) {
        return { label: "Expired", tone: "bad", description: `Its sign-in has expired. Reconnect ${c.displayName} to keep it working.`, action: "reconnect" };
      }
      if (days <= 7) {
        return {
          label: `Expires in ${days} day${days === 1 ? "" : "s"}`,
          tone: days <= 1 ? "bad" : "warn",
          description: `Its sign-in stops working ${days === 1 ? "tomorrow" : `in ${days} days`}. Reconnect now so agents aren't interrupted.`,
          action: "reconnect",
        };
      }
      return { label: "Active", tone: "good", description: `Working. Needs a reconnect in ${days} days.`, action: null };
    }
  }
}

// ───────────── Held tools ─────────────

/** "Notion changed 1 tool", per connection with held tools. */
export function heldNotices(connections: readonly Pick<Connection, "id" | "displayName" | "heldCount" | "status">[]): { id: string; text: string }[] {
  return connections
    .filter((c) => c.heldCount > 0 && c.status !== "disabled")
    .map((c) => ({ id: c.id, text: `${c.displayName} changed ${c.heldCount} tool${c.heldCount === 1 ? "" : "s"}` }));
}

export type DiffLine = { kind: "same" | "add" | "del"; text: string };

/** Line diff (LCS) of two texts, for the accept-change page. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const n = a.length;
  const m = b.length;
  // Big definitions: no LCS table (n×m), just old then new.
  if (n * m > 250_000) return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))];
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ kind: "del", text: a[i++]! });
    else out.push({ kind: "add", text: b[j++]! });
  }
  while (i < n) out.push({ kind: "del", text: a[i++]! });
  while (j < m) out.push({ kind: "add", text: b[j++]! });
  return out;
}

/** What changed in a held tool, as before/after text pairs (description, then the input schema; others when they differ). */
export function heldDiff(t: Pick<HeldTool, "pinned" | "live">): { label: string; before: string; after: string; changed: boolean }[] {
  const json = (v: unknown) => (v === undefined ? "" : JSON.stringify(v, null, 2));
  const p = t.pinned;
  const rows = [
    { label: "Description", before: p?.description ?? "", after: t.live.description },
    { label: "Arguments (input schema)", before: json(p?.inputSchema), after: json(t.live.inputSchema) },
    { label: "Title", before: p?.title ?? "", after: t.live.title ?? "" },
    { label: "Output schema", before: json(p?.outputSchema), after: json(t.live.outputSchema) },
    { label: "Annotations", before: json(p?.annotations), after: json(t.live.annotations) },
  ].map((r) => ({ ...r, changed: r.before !== r.after }));
  // Description and arguments always show (so a reviewer sees them); the rest only when they changed.
  return rows.filter((r, i) => i < 2 || r.changed);
}

// ───────────── Upstream sign-in ─────────────

/** The connection callback page's message (ConnectionOAuthMessage), for the connection being signed in only. */
export function oauthMessageFor(data: unknown, connectionId: string | null): { ok: true } | { ok: false; code: string; error: string; hint: string | null } | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Partial<ConnectionOAuthMessage>;
  if (m.type !== "agentinbox:connection-oauth") return null;
  if (connectionId && m.connectionId && m.connectionId !== connectionId) return null;
  if (m.ok) return { ok: true };
  return { ok: false, code: m.code ?? "oauth_error", error: m.error ?? "The sign-in didn't complete.", hint: m.hint ?? null };
}

/** Checks a pasted callback address before sending it (paste mode); a problem in plain words, or null. */
export function pastedProblem(value: string, state: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "That isn't a full address. Copy everything in the address bar, starting with http.";
  }
  const err = url.searchParams.get("error");
  if (err) return err === "access_denied" ? "This address says the sign-in was cancelled. Start again and approve it." : `The sign-in returned an error: ${err}`;
  if (!url.searchParams.get("code")) return "This address has no authorization code. Copy it after approving the sign-in.";
  const s = url.searchParams.get("state");
  if (s && s !== state) return "This address belongs to an older sign-in attempt. Use the newest one.";
  return null;
}

// ───────────── Add connection ─────────────

const SLUG_RE = /^[a-z0-9-]{1,24}$/;
const GENERIC_LABELS = new Set(["www", "mcp", "api", "app", "server", "com", "net", "org", "io", "dev", "sh", "ai", "co"]);

/** A slug from a URL's host: mcp.notion.com → notion, 127.0.0.1:3773 → local-3773. */
export function suggestSlug(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "";
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(host) || host.includes(":") || host === "localhost") return `local${u.port ? `-${u.port}` : ""}`;
  // Without the TLD, the first label that names something: mcp.notion.com → notion, whoop.weish.me → whoop.
  const all = host.split(".").filter(Boolean);
  const labels = (all.length > 1 ? all.slice(0, -1) : all).filter((l) => !GENERIC_LABELS.has(l));
  const base = (labels[0] ?? all[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.slice(0, 24);
}

/** Why a slug can't be used, or null. Native-name collisions are checked by the server. */
export function slugProblem(slug: string, taken: readonly string[]): string | null {
  if (!slug) return "Give it a short name.";
  if (!SLUG_RE.test(slug)) return "Use up to 24 lowercase letters, digits and dashes.";
  if (taken.includes(slug)) return `You already have a connection named ${slug}.`;
  return null;
}

/** Setup inputs still missing or not matching their pattern, by key. */
export function inputProblems(steps: readonly SetupStep[], values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of steps) {
    if (!s.input) continue;
    const v = (values[s.input.key] ?? "").trim();
    if (!v) out[s.input.key] = `Paste the ${s.input.label.toLowerCase()}.`;
    else if (s.input.pattern) {
      let re: RegExp | null = null;
      try {
        re = new RegExp(`^(?:${s.input.pattern})$`);
      } catch {
        re = null;
      }
      if (re && !re.test(v)) out[s.input.key] = `That doesn't look like a ${s.input.label.toLowerCase()}.`;
    }
  }
  return out;
}

/** How the connection signs in to the upstream, as the dialog's control after the source is known. */
export type AuthControl =
  | { kind: "oauth"; issuer: string | null; needsClientId: boolean }
  | { kind: "header"; headerName: string; prefix?: string }
  | { kind: "none" }
  | { kind: "private"; target: string; address: string; range: Extract<ProbeResult, { kind: "private" }>["range"] }
  | { kind: "steps" };

export function authControl(source: { preset: PresetView } | { probe: ProbeResult }): AuthControl {
  if ("preset" in source) {
    const p = source.preset;
    if (p.auth === "mcp_oauth") return { kind: "oauth", issuer: null, needsClientId: false };
    if (p.auth === "header") return { kind: "header", headerName: p.headerName ?? "Authorization", prefix: p.headerName ? undefined : "Bearer " };
    // user_app (WHOOP): its setup steps collect the app's client id and secret; the sign-in follows.
    if (p.auth === "user_app") return { kind: "steps" };
    return { kind: "none" };
  }
  const r = source.probe;
  switch (r.kind) {
    case "open":
      return { kind: "none" };
    case "oauth":
      return { kind: "oauth", issuer: r.issuer, needsClientId: r.registration === "manual" };
    case "header":
      return { kind: "header", headerName: r.headerName, prefix: r.prefix };
    case "private":
      return { kind: "private", target: r.target, address: r.address, range: r.range };
  }
}

const RANGE_WORDS: Record<Extract<ProbeResult, { kind: "private" }>["range"], string> = {
  loopback: "this computer",
  private: "your local network",
  cgnat: "your Tailscale network",
  ula: "your private network",
};

/** One or two sentences about what the probe found. */
export function probeSummary(r: ProbeResult): string {
  const name = "serverName" in r && r.serverName ? `${r.serverName}: ` : "";
  switch (r.kind) {
    case "open":
      return `${name}an MCP server that needs no sign-in${r.toolCount != null ? `, with ${r.toolCount} tool${r.toolCount === 1 ? "" : "s"}` : ""}.`;
    case "oauth": {
      const host = hostOf(r.issuer);
      if (r.registration === "manual") return `${name}signs in with ${host}. It doesn't register apps automatically, so you'll paste a client ID you created there.`;
      return `${name}signs in with ${host}. agentinbox registers itself automatically, so there's nothing to set up there.`;
    }
    case "header":
      return `${name}needs an API key or token. agentinbox keeps it encrypted and sends it in the ${r.headerName} header; agents never see it.`;
    case "private":
      return `This server is on ${RANGE_WORDS[r.range]} (${r.address}). agentinbox blocks those addresses unless you allow one.`;
  }
}

/** The private-network explanation shown with "Allow host:port". */
export function privateExplanation(target: string, range: Extract<ProbeResult, { kind: "private" }>["range"]): string {
  return (
    `Allowing ${hostPort(target)} lets agentinbox connect to a server on ${RANGE_WORDS[range]}. ` +
    "Only this connection gets it, only at this exact address, and only you can turn it on. " +
    "A server there can reach other services on that machine or network, so allow only servers you run or trust."
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** `host:port` of `scheme://host:port`. */
export function hostPort(target: string): string {
  try {
    const u = new URL(target);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return target;
  }
}

export interface ConnectionDraft {
  preset: PresetView | null;
  url: string;
  probe: ProbeResult | null;
  slug: string;
  displayName: string;
  level: AccessLevel;
  /** "all" by default. */
  agents: "all" | string[];
  headerValue: string;
  clientId: string;
  inputs: Record<string, string>;
  privateTarget: string | null;
}

export const emptyDraft = (preset: PresetView | null = null): ConnectionDraft => ({
  preset,
  url: preset?.url ?? "",
  probe: null,
  slug: preset?.slug ?? "",
  displayName: preset?.displayName ?? "",
  level: DEFAULT_LEVEL,
  agents: "all",
  headerValue: "",
  clientId: "",
  inputs: {},
  privateTarget: null,
});

/** What still blocks "Connect", in the order the dialog shows the fields; empty when ready. */
export function draftProblems(d: ConnectionDraft, taken: readonly string[]): string[] {
  const out: string[] = [];
  if (!d.preset && !d.probe) out.push("Check the address first.");
  if (d.probe?.kind === "private") out.push("Allow the private-network address, or use another one.");
  const slug = slugProblem(d.slug, taken);
  if (slug) out.push(slug);
  const control = d.preset ? authControl({ preset: d.preset }) : d.probe ? authControl({ probe: d.probe }) : null;
  if (control?.kind === "header" && !d.headerValue.trim()) out.push("Paste the API key or token.");
  if (control?.kind === "oauth" && control.needsClientId && !d.clientId.trim()) out.push("Paste the client ID.");
  if (d.preset) out.push(...Object.values(inputProblems(d.preset.setupSteps, d.inputs)));
  if (Array.isArray(d.agents) && d.agents.length === 0) out.push("Pick at least one agent, or all of them.");
  return out;
}

/** The POST /api/connections body for a ready draft. */
export function createInput(d: ConnectionDraft): CreateConnectionInput {
  const control = d.preset ? authControl({ preset: d.preset }) : d.probe ? authControl({ probe: d.probe }) : null;
  const body: CreateConnectionInput = { slug: d.slug, level: d.level, agents: d.agents };
  if (d.preset) body.presetId = d.preset.id;
  else body.url = d.probe?.url ?? d.url.trim();
  if (d.displayName.trim() && d.displayName.trim() !== d.preset?.displayName) body.displayName = d.displayName.trim();
  if (control?.kind === "header") {
    const v = d.headerValue.trim();
    body.header = { name: control.headerName, value: control.prefix && !v.toLowerCase().startsWith(control.prefix.trim().toLowerCase()) ? control.prefix + v : v };
  }
  if (control?.kind === "oauth" && control.needsClientId) body.clientId = d.clientId.trim();
  if (d.privateTarget) body.privateTarget = d.privateTarget;
  if (d.preset && Object.keys(d.inputs).length) body.inputs = Object.fromEntries(Object.entries(d.inputs).map(([k, v]) => [k, v.trim()]));
  return body;
}
