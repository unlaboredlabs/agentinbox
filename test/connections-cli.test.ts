import { describe, expect, it } from "vitest";
import { SessionStore } from "../server/auth/sessions.ts";
import { sha256 } from "../server/crypto.ts";
import { AdminApiError, CLI_SESSION_TTL_MS, createCliSession, daemonOrigin, openAdminChannel } from "../server/connections-cli/admin.ts";
import { ConnectionsApi } from "../server/connections-cli/api.ts";
import { addConnection, listConnections, reconnectConnection, removeConnection, slugFromUrl } from "../server/connections-cli/manage.ts";
import { checkTarget } from "../server/connections-cli/private.ts";
import { ScriptedPrompter } from "../server/connections-cli/prompt.ts";
import { readTomlMcpServers, UNREADABLE as TOML_UNREADABLE } from "../server/connections-cli/toml.ts";
import { readMcpServers, removeYamlServers, UNREADABLE } from "../server/connections-cli/yaml.ts";
import { FakeConnectionsDaemon, publicLookup } from "./connections-cli-fake.ts";
import { harness } from "./platform-helpers.ts";

describe("the local admin channel", () => {
  it("a one-time session works against the real admin API, can't slide past 15 minutes, and is deleted on close", async () => {
    const h = harness();
    try {
      await h.claim();
      let now = Date.now();
      const s = createCliSession(h.ctx.config.dbPath, () => now);
      const cookie = `aib_session=${s.token}`;
      expect((await h.request("/api/agents", { cookie })).status).toBe(200);
      // Only the hash is stored, with a hard limit at the expiry: a check never extends it.
      const row = h.ctx.db.get<{ created_at: string; expires_at: string; user_agent: string }>("SELECT * FROM admin_sessions WHERE token_hash = ?", sha256(s.token))!;
      expect(Date.parse(row.expires_at) - now).toBe(CLI_SESSION_TTL_MS);
      expect(row.user_agent).toContain("CLI");
      const store = new SessionStore(h.ctx.db, () => now + 60_000);
      expect(store.check(s.token)).toEqual({ valid: true, refreshed: false });
      now += CLI_SESSION_TTL_MS + 1000;
      expect(new SessionStore(h.ctx.db, () => now).check(s.token).valid).toBe(false);

      const s2 = createCliSession(h.ctx.config.dbPath);
      expect((await h.request("/api/agents", { cookie: `aib_session=${s2.token}` })).status).toBe(200);
      s2.remove();
      expect((await h.request("/api/agents", { cookie: `aib_session=${s2.token}` })).status).toBe(401);
    } finally {
      await h.dispose();
    }
  });

  it("sends the cookie and CSRF header, and turns API errors into AdminApiError", async () => {
    const h = harness();
    try {
      await h.claim();
      const ch = openAdminChannel({
        dataDir: h.ctx.config.dataDir,
        instance: { pid: 1, host: "0.0.0.0", port: 8425, startedAt: "" },
        fetch: ((url: string, init: RequestInit) => h.request(new URL(url).pathname, init)) as typeof fetch,
      });
      expect(ch.baseUrl).toBe("http://127.0.0.1:8425");
      expect(Array.isArray(await ch.request("GET", "/api/agents"))).toBe(true);
      const err = await ch.request("POST", "/api/connections", {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AdminApiError);
      expect((err as AdminApiError).status).toBe(404);
      // Routes not mounted (brokerUpstreams off): said in plain words.
      await expect(new ConnectionsApi(ch).list()).rejects.toThrow(/brokerUpstreams/);
      ch.close();
      expect(h.ctx.db.get("SELECT 1 AS x FROM admin_sessions WHERE ip = 'local-cli'")).toBeUndefined();
    } finally {
      await h.dispose();
    }
  });

  it("refuses without a data directory or a running daemon", () => {
    expect(() => openAdminChannel({ dataDir: "/nonexistent/agentinbox" })).toThrow(/No agentinbox data/);
    expect(daemonOrigin({ host: "::", port: 9 })).toBe("http://127.0.0.1:9");
    expect(daemonOrigin({ host: "100.64.1.2", port: 9 })).toBe("http://100.64.1.2:9");
  });
});

describe("connections add", () => {
  const deps = (daemon: FakeConnectionsDaemon, p: ScriptedPrompter, env: NodeJS.ProcessEnv = {}) => ({ api: new ConnectionsApi(daemon), prompter: p, env, pollMs: 1, timeoutMs: 200 });

  it("a URL on this machine: the private allow prompt for the exact origin, a header, the access choice and the agents", async () => {
    const daemon = new FakeConnectionsDaemon();
    const url = "http://127.0.0.1:8787/mcp";
    daemon.probeAnswers.set(url, (input) =>
      input.privateTarget ? { ok: true, auth: { type: "header" } } : { ok: false, code: "private_target", origin: "http://127.0.0.1:8787", address: "127.0.0.1", message: "blocked" },
    );
    // allow? · header name · value · slug · access (1 = full) · all agents? no · Hermes? yes · Claude Code? no · add?
    const p = new ScriptedPrompter(["y", "", "bs-token", "brightspace", "1", "n", "y", "n", "y"]);
    expect(await addConnection(url, {}, deps(daemon, p))).toBe(0);
    expect(daemon.probes).toEqual([{ url }, { url, privateTarget: "http://127.0.0.1:8787" }]);
    expect(daemon.created).toEqual([
      { slug: "brightspace", url, auth: { type: "header", name: "Authorization", value: "Bearer bs-token" }, privateTarget: "http://127.0.0.1:8787", level: "full", agents: ["agt_hermes"] },
    ]);
    expect(p.text).toContain("An allow covers exactly http://127.0.0.1:8787");
    expect(p.text).not.toContain("bs-token");
    expect(p.text).toContain('✔ Connected "brightspace": 3 tools, seen by agents as brightspace__<tool>');
  });

  it("declining the allow adds nothing", async () => {
    const daemon = new FakeConnectionsDaemon();
    daemon.probeAnswers.set("http://10.0.0.5/mcp", { ok: false, code: "private_target", origin: "http://10.0.0.5:80", message: "blocked" });
    expect(await addConnection("http://10.0.0.5/mcp", {}, deps(daemon, new ScriptedPrompter(["n"])))).toBe(0);
    expect(daemon.created).toEqual([]);
  });

  it("OAuth over SSH: paste mode, then the default access (ask) for all agents", async () => {
    const daemon = new FakeConnectionsDaemon();
    daemon.authorizeMode = "direct";
    const url = "https://mcp.example.com/mcp";
    daemon.probeAnswers.set(url, { ok: true, auth: { type: "oauth", issuer: "https://auth.example.com", registration: "dcr" } });
    const opened: string[] = [];
    const p = new ScriptedPrompter(["", "", "y", "y", "not a url", "http://localhost:8425/oauth/connections/callback?code=c&state=st_con_1"]);
    const d = { ...deps(daemon, p, { SSH_CONNECTION: "1 2 3 4" }), openBrowser: async (u: string) => opened.push(u) };
    expect(await addConnection(url, { agent: undefined }, d)).toBe(0);
    expect(daemon.created[0]).toMatchObject({ slug: "example", auth: { type: "oauth" }, level: "ask", agents: "all", privateTarget: null });
    expect(p.text).toContain("registers itself automatically (dynamic client registration)");
    expect(p.text).toContain("https://auth.example.com/authorize?state=st_con_1");
    expect(p.text).toContain("That isn't the address after signing in");
    expect(opened).toEqual([]);
    expect(daemon.connections[0]!.status).toBe("active");
  });

  it("OAuth on the desktop: opens the browser and waits for the connection to turn active", async () => {
    const daemon = new FakeConnectionsDaemon();
    daemon.authorizeMode = "direct";
    daemon.probeAnswers.set("https://mcp.linear.app/mcp", { ok: true, auth: { type: "oauth", issuer: "https://mcp.linear.app", registration: "dcr" } });
    const opened: string[] = [];
    const d = {
      ...deps(daemon, new ScriptedPrompter([], true)),
      openBrowser: async (u: string) => {
        opened.push(u);
        setTimeout(() => (daemon.connections[0]!.status = "active"), 5);
      },
    };
    expect(await addConnection("https://mcp.linear.app/mcp", { yes: true }, d)).toBe(0);
    expect(opened).toEqual(["https://auth.example.com/authorize?state=st_con_1"]);
    expect(daemon.created[0]!.slug).toBe("linear");
  });

  it("a preset renders its setup steps and collects their inputs", async () => {
    const daemon = new FakeConnectionsDaemon();
    daemon.presetList = [
      {
        id: "whoop",
        displayName: "WHOOP",
        slug: "whoop",
        authType: "user_app",
        steps: [
          { id: "dash", title: "Open the WHOOP developer dashboard", body: "Sign in and create a team.", link: { label: "Open", url: "https://developer-dashboard.whoop.com" } },
          { id: "redirect", title: "Create an app", body: "Tick the `read:recovery` scope.", copy: { label: "Redirect URI", value: "http://localhost:8425/oauth/connections/callback" } },
          { id: "id", title: "Paste the client ID", body: "From the app page.", input: { key: "clientId", label: "Client ID", pattern: "^[0-9a-f-]{8,}$", placeholder: "a UUID" } },
          { id: "secret", title: "Paste the client secret", body: "Also from the app page.", input: { key: "clientSecret", label: "Client secret", secret: true } },
        ],
      },
    ];
    const p = new ScriptedPrompter(["nope", "0f8e2c1a-1111", "whsecret", "", "", "", "y", "http://localhost:8425/oauth/connections/callback?code=x&state=st_con_1"]);
    expect(await addConnection("whoop", {}, deps(daemon, p))).toBe(0);
    expect(p.text).toContain("1. Open the WHOOP developer dashboard");
    expect(p.text).toContain("   Open: https://developer-dashboard.whoop.com");
    expect(p.text).toContain("   Redirect URI: http://localhost:8425/oauth/connections/callback");
    expect(p.text).toContain("That doesn't look right (it looks like a UUID)");
    expect(daemon.created[0]).toMatchObject({ preset: "whoop", slug: "whoop", auth: { type: "oauth" }, inputs: { clientId: "0f8e2c1a-1111", clientSecret: "whsecret" } });
    expect(p.text).not.toContain("whsecret");
  });

  it("an unknown integration names the presets", async () => {
    const daemon = new FakeConnectionsDaemon();
    daemon.presetList = [{ id: "notion", displayName: "Notion", slug: "notion", authType: "mcp_oauth", steps: [] }];
    await expect(addConnection("notoin", {}, deps(daemon, new ScriptedPrompter([])))).rejects.toThrow(/Use notion, <an MCP server URL>/);
  });

  it("list, reconnect (header) and remove", async () => {
    const daemon = new FakeConnectionsDaemon();
    daemon.connections = [
      { id: "c1", slug: "notion", displayName: "Notion", kind: "notion", url: "https://mcp.notion.com/mcp", status: "active", authType: "oauth", privateTarget: null, level: "ask", expiresAt: new Date(Date.now() + 3 * 86_400_000 + 1000).toISOString() },
      { id: "c2", slug: "hearloom", displayName: "hearloom", kind: "remote_http", url: "http://127.0.0.1:3000/mcp", status: "needs_reauth", authType: "header", headerName: "Authorization", privateTarget: "http://127.0.0.1:3000", level: "read" },
    ];
    const p = new ScriptedPrompter(["new-token", "y"]);
    await listConnections(deps(daemon, p));
    expect(p.text).toMatch(/notion\s+active\s+Ask before risky actions\s+https:\/\/mcp\.notion\.com\/mcp {2}\(expires in 3 days\)/);
    expect(p.text).toMatch(/hearloom\s+needs_reauth\s+Read only.*\(private network, Reconnect\)/);
    expect(await reconnectConnection("hearloom", {}, deps(daemon, p))).toBe(0);
    expect(daemon.calls).toContain("PUT /api/connections/c2/header");
    expect(await removeConnection("hearloom", deps(daemon, p))).toBe(0);
    expect(daemon.connections.map((c) => c.slug)).toEqual(["notion"]);
    await expect(reconnectConnection("nope", {}, deps(daemon, p))).rejects.toThrow(/No connection "nope". There are: notion/);
  });

  it("slugs and private targets", async () => {
    expect(slugFromUrl(new URL("https://mcp.notion.com/mcp"))).toBe("notion");
    expect(slugFromUrl(new URL("http://127.0.0.1:8787/mcp"))).toBe("127-0-0-1-8787");
    expect(await checkTarget(new URL("http://localhost:3000/mcp"))).toEqual({ kind: "private", origin: "http://localhost:3000", addresses: ["127.0.0.1"] });
    expect(await checkTarget(new URL("https://[fd7a:115c:a1e0::1]/mcp"))).toMatchObject({ kind: "private", origin: "https://[fd7a:115c:a1e0::1]:443" });
    expect(await checkTarget(new URL("http://169.254.169.254/latest"))).toEqual({ kind: "never", address: "169.254.169.254" });
    expect(await checkTarget(new URL("https://example.com/mcp"), publicLookup)).toEqual({ kind: "public" });
    expect(await checkTarget(new URL("https://nas.lan/mcp"), async () => [{ address: "192.168.1.9", family: 4 }])).toMatchObject({ kind: "private", origin: "https://nas.lan:443" });
  });
});

describe("config readers", () => {
  it("YAML: flow style, anchors and block scalars are unreadable instead of guessed; removal keeps the rest byte for byte", () => {
    const yaml = [
      "a: 1",
      "mcp_servers:",
      "  ok:",
      "    url: 'https://x.example/mcp'  # comment",
      "    args:",
      "      - one",
      '      - "two"',
      "  flow: { url: https://y }",
      "  anchored: &a",
      "    url: https://z",
      "  block:",
      "    url: |",
      "      https://w",
      "  'quoted name':",
      "    url: \"https://q.example/mcp#frag\"",
      "b: 2",
      "",
    ].join("\n");
    const s = readMcpServers(yaml)!;
    expect(s.ok).toEqual({ url: "https://x.example/mcp", args: ["one", "two"] });
    expect(s.flow).toBe(UNREADABLE);
    expect(s.anchored).toBe(UNREADABLE);
    expect((s.block as Record<string, unknown>).url).toBe(UNREADABLE);
    expect(s["quoted name"]).toEqual({ url: "https://q.example/mcp#frag" });
    expect(removeYamlServers(yaml, ["ok", "quoted name"])).toBe(
      ["a: 1", "mcp_servers:", "  flow: { url: https://y }", "  anchored: &a", "    url: https://z", "  block:", "    url: |", "      https://w", "b: 2", ""].join("\n"),
    );
    expect(removeYamlServers(yaml, ["flow"])).toBeNull();
    expect(removeYamlServers("mcp_servers:\n  only:\n    url: x\nz: 1\n", ["only"])).toBe("mcp_servers: {}\nz: 1\n");
    expect(readMcpServers("mcp_servers: {}\n")).toEqual({});
    expect(readMcpServers("other: 1\n")).toEqual({});
  });

  it("TOML: dotted keys, quoted names and inline tables; a server with a value it can't read is UNREADABLE", () => {
    const toml = [
      'mcp_servers.dotted.url = "https://d.example/mcp"',
      '[mcp_servers."my server"]',
      "url = 'https://m.example/mcp'",
      'http_headers = { "X-Key" = "k\\u0041" }',
      "[mcp_servers.multi]",
      'description = """',
      "long",
      '"""',
      "[other]",
      "x = [[1, 2], [3]]",
    ].join("\n");
    const s = readTomlMcpServers(toml);
    expect(s.dotted).toEqual({ url: "https://d.example/mcp" });
    expect(s["my server"]).toEqual({ url: "https://m.example/mcp", http_headers: { "X-Key": "kA" } });
    expect(s.multi).toBe(TOML_UNREADABLE);
  });
});
