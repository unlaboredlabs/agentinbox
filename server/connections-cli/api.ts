import type { AccessLevel, SetupStep } from "../broker/types.ts";
import type { Agent } from "../../shared/types.ts";
import { AdminApiError, type AdminChannel } from "./admin.ts";

/**
 * The admin connections API as the CLI uses it. PROVISIONAL: written against docs/MCP-BROKER.md before
 * feat/broker-endpoint (the routes) and feat/broker-schema (the shared DTOs) landed. Every path and shape the CLI
 * relies on is in this file, so adapting to the real API is a change here only.
 *
 *   GET    /api/connections                         → ConnectionView[] (or { connections })
 *   GET    /api/connections/presets                 → PresetView[]
 *   POST   /api/connections/probe   ProbeInput      → ProbeResult
 *   POST   /api/connections         CreateInput     → ConnectionView
 *   POST   /api/connections/:id/authorize           → AuthorizeStart          (OAuth: start / Reconnect)
 *   POST   /api/connections/:id/authorize/complete { url } → ConnectionView  (paste mode)
 *   PUT    /api/connections/:id/header { name, value }     → ConnectionView  (replace a static header)
 *   POST   /api/connections/:id/disable             → ConnectionView          (the kill switch)
 *   DELETE /api/connections/:id                     → 204
 *   GET    /api/agents                              → Agent[] (exists today)
 *
 * While the `brokerUpstreams` setting is off the routes answer 404 (not mounted); the CLI says so.
 */

export type ConnectionStatus = "active" | "needs_reauth" | "error" | "disabled";
export type ConnectionAuthType = "none" | "header" | "oauth";

export interface ConnectionView {
  id: string;
  slug: string;
  displayName: string;
  kind: string;
  url: string | null;
  status: ConnectionStatus;
  statusReason?: string | null;
  authType: ConnectionAuthType;
  /** Static-header connections: the header's name (never its value). */
  headerName?: string | null;
  /** The private-target allow, `scheme://host:port`, or null. */
  privateTarget: string | null;
  level: AccessLevel;
  toolCount?: number;
  /** When the credential stops working without a Reconnect (no refresh token, or a lifetime cap). */
  expiresAt?: string | null;
  /** Console page that reconnects it, if the API offers one. */
  reconnectUrl?: string | null;
}

export interface PresetView {
  id: string;
  displayName: string;
  slug: string;
  url?: string | null;
  authType: "none" | "header" | "mcp_oauth" | "user_app";
  /** Header presets: the header to ask for. */
  headerName?: string;
  headerPrefix?: string;
  /** setupSteps(ctx), rendered by the daemon for this install. */
  steps: SetupStep[];
}

export interface ProbeInput {
  url: string;
  /** The private-target allow to probe with (admin-only; the same exact origin the connection would carry). */
  privateTarget?: string | null;
}

export type ProbeResult =
  | {
      ok: true;
      auth: { type: "none" } | { type: "header" } | { type: "oauth"; issuer: string; registration: "preregistered" | "metadata_document" | "dcr" | "manual" };
      /** What the probe saw, in plain words (e.g. "401 without OAuth metadata: needs an API key"). */
      message?: string;
    }
  | {
      ok: false;
      /** `private_target`: the SSRF guard blocked a loopback/private/CGNAT host; `origin` is what an allow would cover. */
      code: "private_target" | (string & {});
      message: string;
      hint?: string;
      /** private_target: the exact `scheme://host:port` an allow would pin, and the address it resolved to. */
      origin?: string;
      address?: string;
    };

export interface CreateInput {
  slug: string;
  displayName?: string;
  /** A preset id (`notion`, `whoop`) instead of a URL. */
  preset?: string;
  url?: string;
  auth: { type: "none" } | { type: "header"; name: string; value: string } | { type: "oauth"; clientId?: string };
  /** Preset setup inputs (`SetupStep.input.key` → value); secrets are stored encrypted. */
  inputs?: Record<string, string>;
  privateTarget?: string | null;
  level: AccessLevel;
  /** Agent ids that get the connection at `level`, or "all". */
  agents: string[] | "all";
  /** Where it came from (audit), e.g. "import:hermes". */
  source?: string;
}

export interface AuthorizeStart {
  authorizeUrl: string;
  /** "direct": the provider redirects to this install; "paste": the user pastes the address they land on. */
  callbackMode: "direct" | "paste";
  redirectUri: string;
}

/** The routes aren't there: an older daemon, or brokerUpstreams is off. */
export class BrokerOffError extends Error {
  constructor() {
    super(
      "This agentinbox doesn't have connections turned on yet (the brokerUpstreams setting), or is older than this CLI. " +
        "Update it, turn connections on in the console's Settings, then run this again.",
    );
    this.name = "BrokerOffError";
  }
}

export class ConnectionsApi {
  constructor(readonly channel: AdminChannel) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await this.channel.request<T>(method, path, body);
    } catch (err) {
      if (err instanceof AdminApiError && err.status === 404 && err.code === "not_found" && path.startsWith("/api/connections")) throw new BrokerOffError();
      throw err;
    }
  }

  async list(): Promise<ConnectionView[]> {
    const r = await this.call<ConnectionView[] | { connections: ConnectionView[] }>("GET", "/api/connections");
    return Array.isArray(r) ? r : r.connections;
  }
  async presets(): Promise<PresetView[]> {
    const r = await this.call<PresetView[] | { presets: PresetView[] }>("GET", "/api/connections/presets");
    return Array.isArray(r) ? r : r.presets;
  }
  probe(input: ProbeInput): Promise<ProbeResult> {
    return this.call("POST", "/api/connections/probe", input);
  }
  create(input: CreateInput): Promise<ConnectionView> {
    return this.call("POST", "/api/connections", input);
  }
  authorize(id: string): Promise<AuthorizeStart> {
    return this.call("POST", `/api/connections/${encodeURIComponent(id)}/authorize`, {});
  }
  completeAuthorize(id: string, url: string): Promise<ConnectionView> {
    return this.call("POST", `/api/connections/${encodeURIComponent(id)}/authorize/complete`, { url });
  }
  setHeader(id: string, name: string, value: string): Promise<ConnectionView> {
    return this.call("PUT", `/api/connections/${encodeURIComponent(id)}/header`, { name, value });
  }
  disable(id: string): Promise<ConnectionView> {
    return this.call("POST", `/api/connections/${encodeURIComponent(id)}/disable`, {});
  }
  remove(id: string): Promise<void> {
    return this.call("DELETE", `/api/connections/${encodeURIComponent(id)}`);
  }
  async get(id: string): Promise<ConnectionView | null> {
    return (await this.list()).find((c) => c.id === id) ?? null;
  }
  async bySlug(slug: string): Promise<ConnectionView> {
    const all = await this.list();
    const found = all.find((c) => c.slug === slug);
    if (!found) throw new Error(`No connection "${slug}". ${all.length ? `There are: ${all.map((c) => c.slug).join(", ")}.` : "There are none yet."}`);
    return found;
  }
  agents(): Promise<Agent[]> {
    return this.channel.request("GET", "/api/agents");
  }
}
