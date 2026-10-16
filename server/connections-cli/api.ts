import type {
  Agent,
  ConnectionProbe,
  ConnectionView,
  CreateConnectionInput,
  PresetView,
  StartConnectInput,
  StartConnectResult,
} from "../../shared/types.ts";
import { AdminApiError, type AdminChannel } from "./admin.ts";

/**
 * The admin connections API (server/api/connections.ts, DTOs in shared/types.ts) as the CLI uses it. While the
 * `brokerUpstreams` setting is off every /api/connections route answers 404; the CLI says so in plain words.
 */

export type { ConnectionProbe, ConnectionView, PresetView, StartConnectResult };

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

/** What finishing a sign-in from a pasted address gave: the callback page's own result. */
export interface CallbackOutcome {
  ok: boolean;
  error: string | null;
  hint: string | null;
}

const enc = encodeURIComponent;

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

  list(): Promise<ConnectionView[]> {
    return this.call("GET", "/api/connections");
  }
  presets(): Promise<PresetView[]> {
    return this.call("GET", "/api/connections/presets");
  }
  /** With `connectionId`, the probe uses that connection's private-target allow (when it covers the URL). */
  probe(url: string, connectionId?: string): Promise<ConnectionProbe> {
    return this.call("POST", "/api/connections/probe", connectionId ? { url, connectionId } : { url });
  }
  create(input: CreateConnectionInput): Promise<ConnectionView> {
    return this.call("POST", "/api/connections", input);
  }
  get(id: string): Promise<ConnectionView> {
    return this.call("GET", `/api/connections/${enc(id)}`);
  }
  /** Stores a static header (and connects), or starts OAuth and returns the authorize URL. */
  connect(id: string, input: StartConnectInput = {}): Promise<StartConnectResult> {
    return this.call("POST", `/api/connections/${enc(id)}/connect`, input);
  }
  /** The admin-only private-target allow, pinned server-side to the URL's exact scheme://host:port. */
  allowPrivateTarget(id: string, allow: boolean): Promise<ConnectionView> {
    return this.call("PUT", `/api/connections/${enc(id)}/private-target`, { allow });
  }
  /** The kill switch: disabled at once, pending calls cancelled, credentials deleted. */
  kill(id: string): Promise<void> {
    return this.call("POST", `/api/connections/${enc(id)}/kill`, {});
  }
  remove(id: string): Promise<void> {
    return this.call("DELETE", `/api/connections/${enc(id)}`);
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

  /**
   * Paste mode: finishes a sign-in from the address the browser landed on, by handing its query (code, state,
   * iss) to the daemon's own /oauth/connections/callback, exactly as the redirect would have. The daemon checks
   * the state (single use, bound to the connection) and the issuer.
   */
  async finishFromPastedUrl(pasted: string): Promise<CallbackOutcome> {
    let query: URLSearchParams;
    try {
      query = new URL(pasted.trim()).searchParams;
    } catch {
      return { ok: false, error: "That isn't a full address.", hint: "Copy the whole address from the browser's address bar." };
    }
    const keep = new URLSearchParams();
    for (const k of ["code", "state", "iss", "error", "error_description"]) {
      const v = query.get(k);
      if (v !== null) keep.set(k, v);
    }
    const { status, text } = await this.channel.raw("GET", `/oauth/connections/callback?${keep.toString()}`);
    if (status === 404) throw new BrokerOffError();
    const m = /<script type="application\/json" id="oauth-result">([\s\S]*?)<\/script>/.exec(text);
    try {
      const r = m ? (JSON.parse(m[1]!) as { ok?: boolean; error?: string | null; hint?: string | null }) : null;
      if (r) return { ok: r.ok === true, error: r.error ?? null, hint: r.hint ?? null };
    } catch {
      // Reported below.
    }
    return { ok: status === 200, error: status === 200 ? null : `The sign-in failed (HTTP ${status}).`, hint: null };
  }
}
