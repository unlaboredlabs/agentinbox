// Console decisions for broker connections (docs/MCP-BROKER.md) as pure functions, so they can be tested directly:
// a connection's status in plain words, the Add connection draft and the request sequence it turns into, what a
// probe found, access levels and held-tool notices. Built on the /api/connections DTOs in shared/types.ts.
// No React and relative imports only: vitest and the server typecheck load this module too.

import type {
  AccessLevel,
  ConnectionGrant,
  ConnectionProbe,
  ConnectionView,
  CreateConnectionInput,
  PresetView,
  SetupStepView,
  StartConnectInput,
} from "../../../shared/types.ts";
import type { AgentConnection, AgentLevel } from "../../lib/broker-dto.ts";

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
  /** The button that fixes it. A disabled connection (the kill switch) comes back with a reconnect too. */
  action: "reconnect" | null;
}

/** A connection's badge: active / needs reconnect / expiring in N days / disabled. Warns from 7 days before expiresAt. */
export function connectionStatusView(
  c: Pick<ConnectionView, "status" | "statusReason" | "expiresAt" | "name"> & Partial<Pick<ConnectionView, "authType" | "toolsCachedAt" | "tools">>,
  now: number,
): ConnectionStatusView {
  // Never got as far as listing tools: an OAuth sign-in that was abandoned (or a credential that never worked).
  const neverListed = c.toolsCachedAt === null && (c.tools?.total ?? 0) === 0;
  if (neverListed && (c.status === "needs_reauth" || (c.status === "active" && c.authType === "oauth"))) {
    return { label: "Not signed in", tone: "warn", description: `The sign-in to ${c.name} wasn't finished. Agents can't use it until you sign in.`, action: "reconnect" };
  }
  switch (c.status) {
    case "disabled":
      return {
        label: "Disabled",
        tone: "idle",
        description: `${c.statusReason ? `${cap(c.statusReason)}. ` : ""}Agents don't see its tools. Reconnect to use it again.`,
        action: "reconnect",
      };
    case "needs_reauth":
      return {
        label: "Needs reconnect",
        tone: "bad",
        description: `${c.statusReason ?? "Its sign-in stopped working."} Agents' calls to ${c.name} fail until you reconnect.`,
        action: "reconnect",
      };
    case "error":
      return { label: "Error", tone: "bad", description: `${c.statusReason ?? "The server isn't answering."} Reconnecting often fixes it.`, action: "reconnect" };
    case "active": {
      if (!c.expiresAt) return { label: "Active", tone: "good", description: "Working.", action: null };
      const days = daysLeft(c.expiresAt, now);
      if (days <= 0) return { label: "Expired", tone: "bad", description: `Its sign-in has expired. Reconnect ${c.name} to keep it working.`, action: "reconnect" };
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

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Notion changed 1 tool", per connection with held tools. */
export function heldNotices(connections: readonly Pick<ConnectionView, "id" | "name" | "tools" | "status">[]): { id: string; text: string }[] {
  return connections
    .filter((c) => c.tools.held > 0 && c.status !== "disabled")
    .map((c) => ({ id: c.id, text: `${c.name} changed ${c.tools.held} tool${c.tools.held === 1 ? "" : "s"}` }));
}

// ───────────── Agent access (adapter over per-connection grants) ─────────────

/** One agent's level on every connection, from the connections and each connection's grants. */
export function agentConnections(agentId: string, connections: readonly ConnectionView[], grants: Record<string, readonly ConnectionGrant[]>): AgentConnection[] {
  return connections.map((c) => ({
    connectionId: c.id,
    slug: c.slug,
    name: c.name,
    status: c.status,
    level: grants[c.id]?.find((g) => g.agentId === agentId)?.level ?? "none",
  }));
}

/** The PUT /api/connections/:id/grants body that sets one agent's level and keeps everyone else's. */
export function grantsWith(grants: readonly ConnectionGrant[], agentId: string, level: AgentLevel): { grants: { agentId: string; level: AccessLevel }[] } {
  const others = grants.filter((g) => g.agentId !== agentId).map((g) => ({ agentId: g.agentId, level: g.level }));
  return { grants: level === "none" ? others : [...others, { agentId, level }] };
}

// ───────────── Upstream sign-in ─────────────

/**
 * The connection callback page's message (server/api/oauth.ts CONNECTION_CALLBACK_SCRIPT), for the connection being
 * signed in only. It says which connection; whether it worked is read back from the connection (refetch).
 */
export function oauthMessageFor(data: unknown, connectionId: string | null): { ok: boolean; error: string | null } | null {
  if (!data || typeof data !== "object") return null;
  const m = data as { type?: unknown; ok?: unknown; connectionId?: unknown; error?: unknown };
  if (m.type !== "agentinbox:connection-oauth") return null;
  if (!connectionId || m.connectionId !== connectionId) return null;
  return { ok: m.ok !== false, error: typeof m.error === "string" ? m.error : null };
}

/** Checks a pasted landing address (paste mode) before POST /api/connections/finish; a problem in plain words, or null. */
export function pastedProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "That isn't a full address. Copy everything in the address bar, starting with http.";
  }
  const err = url.searchParams.get("error");
  if (err) return err === "access_denied" ? "This address says the sign-in was cancelled. Start again and approve it." : `The sign-in returned an error: ${err}`;
  if (!url.searchParams.get("code")) return "This address has no authorization code. Copy it after approving the sign-in.";
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

/** A slug from the name the user typed: "Notes server" → "notes-server". */
export function slugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 24)
    .replace(/-+$/, "");
}

/** The draft change for a typed name: a custom connection's slug follows it until the slug is edited by hand. */
export function nameChange(d: Pick<ConnectionDraft, "preset" | "slugEdited" | "slug">, name: string): Partial<ConnectionDraft> {
  if (d.preset || d.slugEdited) return { name };
  return { name, slug: slugFromName(name) || d.slug };
}

/** Why a slug can't be used, or null. Native-name collisions are checked by the server. */
export function slugProblem(slug: string, taken: readonly string[]): string | null {
  if (!slug) return "Give it a short name.";
  if (!SLUG_RE.test(slug)) return "Use up to 24 lowercase letters, digits and dashes.";
  if (taken.includes(slug)) return `You already have a connection named ${slug}.`;
  return null;
}

/** Setup inputs still missing or not matching their pattern, by key. */
export function inputProblems(steps: readonly SetupStepView[], values: Record<string, string>): Record<string, string> {
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

/** How the connection signs in, as the dialog's control once the source is known. */
export type AuthControl = { kind: "oauth"; issuer: string | null; manual: boolean } | { kind: "header" } | { kind: "none" } | { kind: "private" } | { kind: "unknown" };

export function authControl(source: { preset: PresetView } | { probe: ConnectionProbe }): AuthControl {
  if ("preset" in source) {
    const t = source.preset.authType;
    // A preset's own setup steps (WHOOP's app id and secret) are inputs; the OAuth sign-in follows them.
    return t === "oauth" ? { kind: "oauth", issuer: null, manual: false } : t === "header" ? { kind: "header" } : { kind: "none" };
  }
  const p = source.probe;
  if (p.blocked === "private_target") return { kind: "private" };
  if (p.auth === "oauth") return { kind: "oauth", issuer: p.issuer ?? null, manual: p.registration === "manual" };
  if (p.auth === "header") return { kind: "header" };
  if (p.auth === "none") return { kind: "none" };
  return { kind: "unknown" };
}

/** `scheme://host:port` the private-target allow covers (default ports spelled out, as the server pins it). */
export function exactOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return null;
  }
}

/** `host:port` of a URL. */
export function hostPort(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return url;
  }
}

/** The private-network explanation shown with "Allow host:port". */
export function privateExplanation(url: string): string {
  return (
    `Allowing ${hostPort(url)} lets xaq connect to a server on this computer or your private network (like Tailscale). ` +
    "Only this connection gets it, only at this exact address, and only you can turn it on. " +
    "A server there can reach other services on that machine or network, so allow only servers you run or trust."
  );
}

/** One or two sentences about what the probe found (the server's words, with ours for the common cases). */
export function probeSummary(p: ConnectionProbe): string {
  if (p.blocked === "private_target") return "This server is on this computer or your private network. xaq blocks those addresses unless you allow one.";
  if (p.blocked === "ssrf") return p.message || "xaq can't connect to this address.";
  if (!p.reachable) return p.message || "xaq couldn't reach this server.";
  if (p.auth === "oauth") {
    const host = p.issuer ? hostPort(p.issuer).replace(/:443$/, "") : "its own sign-in";
    return p.registration === "manual"
      ? `Signs in with ${host}, which doesn't register apps automatically. ${p.message}`.trim()
      : `Signs in with ${host}. xaq registers itself automatically, so there's nothing to set up there.`;
  }
  if (p.auth === "header") return "Needs an API key or token. xaq keeps it encrypted and sends it with every request; agents never see it.";
  if (p.auth === "none") return "An MCP server that needs no sign-in.";
  return p.message;
}

export interface ConnectionDraft {
  preset: PresetView | null;
  url: string;
  probe: ConnectionProbe | null;
  /** Created early when the private-target allow is needed (the allow belongs to a connection). */
  createdId: string | null;
  privateAllowed: boolean;
  /** The user typed a slug: the name no longer drives it. */
  slugEdited: boolean;
  slug: string;
  name: string;
  level: AccessLevel;
  /** "all" by default. */
  agents: "all" | string[];
  headerName: string;
  headerValue: string;
  inputs: Record<string, string>;
}

export const emptyDraft = (preset: PresetView | null = null): ConnectionDraft => ({
  preset,
  url: preset?.url ?? "",
  probe: null,
  createdId: null,
  privateAllowed: false,
  slugEdited: false,
  slug: preset?.slug ?? "",
  name: preset?.displayName ?? "",
  level: DEFAULT_LEVEL,
  agents: "all",
  headerName: "Authorization",
  headerValue: "",
  inputs: {},
});

export const draftControl = (d: ConnectionDraft): AuthControl | null => (d.preset ? authControl({ preset: d.preset }) : d.probe ? authControl({ probe: d.probe }) : null);

/** What still blocks "Connect", in the order the dialog shows the fields; empty when ready. */
export function draftProblems(d: ConnectionDraft, taken: readonly string[]): string[] {
  const out: string[] = [];
  if (!d.preset && !d.probe) out.push("Check the address first.");
  const control = draftControl(d);
  if (control?.kind === "private") out.push("Allow the private-network address, or use another one.");
  if (!d.preset && d.probe && !d.probe.reachable && !d.probe.blocked) out.push("xaq couldn't reach this server.");
  if (d.probe?.blocked === "ssrf") out.push("xaq can't connect to this address.");
  // Created early for the allow: its own slug isn't a clash.
  const slug = slugProblem(d.slug, d.createdId ? taken.filter((s) => s !== d.slug) : taken);
  if (slug) out.push(slug);
  if (control?.kind === "header" && (!d.headerValue.trim() || !/^[A-Za-z0-9-]{1,100}$/.test(d.headerName.trim()))) out.push("Paste the API key or token.");
  if (d.preset) out.push(...Object.values(inputProblems(d.preset.setupSteps, d.inputs)));
  if (Array.isArray(d.agents) && d.agents.length === 0) out.push("Pick at least one agent, or all of them.");
  return out;
}

/** POST /api/connections for the draft. "All agents" omits agentIds (the server grants every agent). */
export function createInput(d: ConnectionDraft): CreateConnectionInput {
  const body: CreateConnectionInput = { slug: d.slug, levelDefault: d.level };
  if (d.preset) body.preset = d.preset.id;
  else body.url = d.url.trim();
  if (d.name.trim() && d.name.trim() !== d.preset?.displayName) body.name = d.name.trim();
  if (Array.isArray(d.agents)) body.agentIds = d.agents;
  return body;
}

/** POST /api/connections/:id/connect for the draft: the header (bearer prefixed when it's Authorization) and setup inputs. */
export function connectInput(d: ConnectionDraft): StartConnectInput {
  const body: StartConnectInput = {};
  if (draftControl(d)?.kind === "header") {
    const name = d.headerName.trim() || "Authorization";
    const v = d.headerValue.trim();
    body.header = { name, value: name.toLowerCase() === "authorization" && !/^\w+\s/.test(v) ? `Bearer ${v}` : v };
  }
  if (d.preset && Object.keys(d.inputs).length) body.inputs = Object.fromEntries(Object.entries(d.inputs).map(([k, v]) => [k, v.trim()]));
  return body;
}

/**
 * The connection created early (for the private-target allow) gets the rest of the draft before connecting:
 * the PATCH (name, slug, level) and the grants PUT, or null when nothing changed.
 */
export function finishEarlyCreate(
  d: ConnectionDraft,
  created: Pick<ConnectionView, "name" | "slug" | "levelDefault">,
  allAgents: readonly string[],
): { patch: { name?: string; slug?: string; levelDefault?: AccessLevel } | null; grants: { grants: { agentId: string; level: AccessLevel }[] } } {
  const patch: { name?: string; slug?: string; levelDefault?: AccessLevel } = {};
  if (d.name.trim() && d.name.trim() !== created.name) patch.name = d.name.trim();
  if (d.slug !== created.slug) patch.slug = d.slug;
  if (d.level !== created.levelDefault) patch.levelDefault = d.level;
  const ids = d.agents === "all" ? allAgents : d.agents;
  return { patch: Object.keys(patch).length ? patch : null, grants: { grants: ids.map((agentId) => ({ agentId, level: d.level })) } };
}
