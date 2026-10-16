import { AdminApiError, type AdminChannel } from "../server/connections-cli/admin.ts";
import type { AuthorizeStart, ConnectionView, CreateInput, PresetView, ProbeInput, ProbeResult } from "../server/connections-cli/api.ts";

/** An in-memory /api/connections behind a fake admin channel, following server/connections-cli/api.ts. */
export class FakeConnectionsDaemon implements AdminChannel {
  readonly baseUrl = "http://127.0.0.1:8425";
  connections: ConnectionView[] = [];
  created: CreateInput[] = [];
  probes: ProbeInput[] = [];
  calls: string[] = [];
  closed = false;
  /** Probe answers by URL (default: no auth needed). */
  probeAnswers = new Map<string, ProbeResult | ((input: ProbeInput) => ProbeResult)>();
  /** Slugs whose create fails with a 500. */
  failCreate = new Set<string>();
  /** Status a header/none connection gets on create. */
  createdStatus: ConnectionView["status"] = "active";
  presetList: PresetView[] = [];
  agentList = [
    { id: "agt_hermes", name: "Hermes", disabled: false },
    { id: "agt_cc", name: "Claude Code on mac", disabled: false },
  ];
  authorizeMode: AuthorizeStart["callbackMode"] = "paste";
  /** Off: every /api/connections route is a 404, like a daemon with brokerUpstreams off. */
  brokerOff = false;
  private n = 0;

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.calls.push(`${method} ${path}`);
    if (this.brokerOff && path.startsWith("/api/connections")) throw new AdminApiError(404, "not_found", "No such API route");
    const json = <R>(v: R) => structuredClone(v) as unknown as T;
    if (method === "GET" && path === "/api/agents") return json(this.agentList);
    if (method === "GET" && path === "/api/connections") return json(this.connections);
    if (method === "GET" && path === "/api/connections/presets") return json(this.presetList);
    if (method === "POST" && path === "/api/connections/probe") {
      const input = body as ProbeInput;
      this.probes.push(input);
      const a = this.probeAnswers.get(input.url);
      return json(typeof a === "function" ? a(input) : (a ?? { ok: true, auth: { type: "none" } }));
    }
    if (method === "POST" && path === "/api/connections") {
      const input = body as CreateInput;
      if (this.failCreate.has(input.slug)) throw new AdminApiError(500, "upstream_error", `Couldn't reach ${input.url}`);
      this.created.push(input);
      const c: ConnectionView = {
        id: `con_${++this.n}`,
        slug: input.slug,
        displayName: input.displayName ?? input.slug,
        kind: input.preset ?? "remote_http",
        url: input.url ?? null,
        status: input.auth.type === "oauth" ? "needs_reauth" : this.createdStatus,
        authType: input.auth.type,
        headerName: input.auth.type === "header" ? input.auth.name : null,
        privateTarget: input.privateTarget ?? null,
        level: input.level,
        toolCount: 3,
        reconnectUrl: `http://localhost:8425/connections/${input.slug}`,
      };
      this.connections.push(c);
      return json(c);
    }
    const m = /^\/api\/connections\/([^/]+)(\/.*)?$/.exec(path);
    const conn = m ? this.connections.find((c) => c.id === decodeURIComponent(m[1]!)) : undefined;
    if (!conn) throw new AdminApiError(404, "connection_not_found", "No such connection");
    const rest = m![2] ?? "";
    if (method === "POST" && rest === "/authorize") {
      return json({ authorizeUrl: `https://auth.example.com/authorize?state=st_${conn.id}`, callbackMode: this.authorizeMode, redirectUri: "http://localhost:8425/oauth/connections/callback" });
    }
    if (method === "POST" && rest === "/authorize/complete") {
      const url = (body as { url: string }).url;
      if (!url.includes(`state=st_${conn.id}`)) throw new AdminApiError(400, "oauth_state", "That sign-in doesn't match this connection.");
      conn.status = "active";
      return json(conn);
    }
    if (method === "PUT" && rest === "/header") {
      conn.status = "active";
      return json(conn);
    }
    if (method === "POST" && rest === "/disable") {
      conn.status = "disabled";
      return json(conn);
    }
    if (method === "DELETE" && rest === "") {
      this.connections = this.connections.filter((c) => c !== conn);
      return undefined as T;
    }
    throw new AdminApiError(404, "not_found", "No such API route");
  }

  close(): void {
    this.closed = true;
  }
}

/** Every hostname resolves to a public address (TEST-NET-3), so tests never touch DNS. */
export const publicLookup = async () => [{ address: "203.0.113.10", family: 4 }];
