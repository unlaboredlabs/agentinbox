import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionsApi } from "../server/connections-cli/api.ts";
import { readClientConfig } from "../server/connections-cli/clients.ts";
import { planImport, runImport } from "../server/connections-cli/import.ts";
import { ScriptedPrompter } from "../server/connections-cli/prompt.ts";
import { readMcpServers } from "../server/connections-cli/yaml.ts";
import { setupMcp } from "../server/listen/mcpsetup.ts";
import { saveProfile } from "../server/listen/profile.ts";
import { FakeConnectionsDaemon, publicLookup } from "./connections-cli-fake.ts";
import { isolateXdg } from "./listen-client-fake.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "connections-cli");
const SECRETS = ["whoop-secret-111", "brightspace-secret-222", "hearloom-secret-333", "aib_HERMES_FIXTURE_KEY", "tg-not-ours"];
const PROFILE_KEY = "aib_PROFILE_KEY_for_the_broker_entry_42";

let env: ReturnType<typeof isolateXdg>;
let home: string;
let hermes: string;
const saved = { HOME: process.env.HOME, HERMES_HOME: process.env.HERMES_HOME, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, PATH: process.env.PATH };

beforeEach(() => {
  env = isolateXdg();
  home = join(env.root, "home");
  hermes = join(home, ".hermes");
  mkdirSync(hermes, { recursive: true });
  process.env.HOME = home;
  process.env.HERMES_HOME = hermes;
  delete process.env.CODEX_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  copyFileSync(join(FIXTURES, "hermes-config.yaml"), join(hermes, "config.yaml"));
  copyFileSync(join(FIXTURES, "hermes.env"), join(hermes, ".env"));
  chmodSync(join(hermes, "config.yaml"), 0o600);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  env.restore();
});

const backups = (dir: string) => readdirSync(dir).filter((f) => f.includes(".agentinbox-backup-"));
const pairHermes = () =>
  saveProfile("default", { url: "https://macbook.tailb10092.ts.net", apiKey: PROFILE_KEY, agentId: "agt_hermes", agentName: "Hermes", consumer: "mac-default", tool: "hermes" });
const deps = (daemon: FakeConnectionsDaemon, prompter: ScriptedPrompter) => ({
  prompter,
  openApi: () => new ConnectionsApi(daemon),
  lookup: publicLookup,
  env: process.env,
  selfOrigins: ["http://127.0.0.1:8425", "http://localhost:8425"],
});

describe("reading client configs", () => {
  it("Hermes: mcp_servers with ${VAR} headers from ~/.hermes/.env, auth: oauth and stdio", () => {
    const c = readClientConfig("hermes", { env: process.env });
    const by = Object.fromEntries(c.entries.map((e) => [e.name, e]));
    expect(Object.keys(by)).toEqual(["agentinbox", "whoop", "brightspace", "hearloom", "t3code-macbook", "forge", "playwright"]);
    expect(by.whoop).toMatchObject({ url: "https://whoop.weish.me/api/mcp", headers: { Authorization: "Bearer whoop-secret-111" }, headerVars: ["WHOOP_MCP_TOKEN"], oauth: false });
    expect(by.brightspace!.headers).toEqual({ Authorization: "Bearer brightspace-secret-222" });
    expect(by.hearloom!.headers).toEqual({ Authorization: "Bearer hearloom-secret-333" });
    expect(by["t3code-macbook"]).toMatchObject({ url: "http://127.0.0.1:3773", oauth: true, headers: {} });
    expect(by.forge).toMatchObject({ url: "http://100.104.249.49:3773", oauth: true });
    expect(by.playwright).toMatchObject({ transport: "stdio", command: "npx -y @playwright/mcp@0.0.41 --headless" });
  });

  it("Claude Code: user scope, the project's local scope (which wins) and ./.mcp.json", () => {
    const cwd = join(env.root, "proj");
    mkdirSync(cwd);
    writeFileSync(join(home, ".claude.json"), readFileSync(join(FIXTURES, "claude.json"), "utf8").replace("__CWD__", cwd));
    copyFileSync(join(FIXTURES, "mcp.json"), join(cwd, ".mcp.json"));
    const c = readClientConfig("claude-code", { env: { STRIPE_KEY: "sk_live_x" }, cwd });
    const by = Object.fromEntries(c.entries.map((e) => [e.name, e]));
    expect(by.linear).toMatchObject({ scope: "local", projectDir: cwd, headers: { Authorization: "Bearer lin-local-secret" } });
    expect(by.docs).toMatchObject({ scope: "project", headers: { "X-Api-Key": "docs-secret-444" } });
    expect(by.stripe).toMatchObject({ scope: "user", headers: { Authorization: "Bearer sk_live_x" } });
    expect(by.sentry!.problem).toMatch(/SENTRY_TOKEN/);
    expect(by.sentry!.transport).toBe("sse");
    expect(by.agentinbox!.problem).toMatch(/helper/);
    expect(by["local-db"]!.transport).toBe("stdio");
  });

  it("Cursor: ${env:VAR} headers; Codex: bearer_token_env_var, env_http_headers and multi-line arrays", () => {
    mkdirSync(join(home, ".cursor"));
    copyFileSync(join(FIXTURES, "cursor-mcp.json"), join(home, ".cursor", "mcp.json"));
    const cur = Object.fromEntries(readClientConfig("cursor", { env: { GITHUB_PAT: "ghp_x" } }).entries.map((e) => [e.name, e]));
    expect(cur.github!.headers).toEqual({ Authorization: "Bearer ghp_x" });
    expect(cur.figma).toMatchObject({ headers: {}, oauth: false });
    expect(cur.fs!.transport).toBe("stdio");

    mkdirSync(join(home, ".codex"));
    copyFileSync(join(FIXTURES, "codex-config.toml"), join(home, ".codex", "config.toml"));
    const cod = Object.fromEntries(readClientConfig("codex", { env: { EXAMPLE_TOKEN: "ex-tok", REGION_KEY: "rk" } }).entries.map((e) => [e.name, e]));
    expect(cod.agentinbox!.headers).toEqual({ Authorization: "Bearer aib_CODEX_FIXTURE_KEY" });
    expect(cod.notion).toMatchObject({ url: "https://mcp.notion.com/mcp", headers: {} });
    expect(cod.example!.headers).toEqual({ Authorization: "Bearer ex-tok" });
    expect(cod.region!.headers).toEqual({ "X-Region": "us-east-1", "X-Api-Key": "rk" });
    expect(cod.docs).toMatchObject({ transport: "stdio", command: "npx -y @upstash/context7-mcp@1.0.0" });
  });
});

describe("import --from hermes", () => {
  it("plans one connection per remote server, skipping agentinbox itself and leaving stdio for M4", async () => {
    const items = await planImport(readClientConfig("hermes", { env: process.env }), { lookup: publicLookup });
    const summary = items.map((i) => [i.entry.name, i.action, i.action === "create" ? [i.slug, i.auth.type, i.privateTarget] : null]);
    expect(summary).toEqual([
      ["agentinbox", "self", null],
      ["whoop", "create", ["whoop", "header", null]],
      ["brightspace", "create", ["brightspace", "header", "http://127.0.0.1:8787"]],
      ["hearloom", "create", ["hearloom", "header", "http://127.0.0.1:3000"]],
      ["t3code-macbook", "create", ["t3code-macbook", "oauth", "http://127.0.0.1:3773"]],
      ["forge", "create", ["forge", "oauth", "http://100.104.249.49:3773"]],
      ["playwright", "stdio", null],
    ]);
  });

  it("--dry-run prints the exact changes, never a secret, and writes nothing", async () => {
    pairHermes();
    const before = readFileSync(join(hermes, "config.yaml"), "utf8");
    const daemon = new FakeConnectionsDaemon();
    const p = new ScriptedPrompter([]);
    const code = await runImport({ from: "hermes", dryRun: true }, { ...deps(daemon, p), openApi: () => { throw new Error("dry run must not open the admin channel"); } });
    expect(code).toBe(0);
    const out = p.text;
    for (const s of [...SECRETS, PROFILE_KEY]) expect(out).not.toContain(s);
    expect(out).toContain("Dry run: nothing is created or changed.");
    expect(out).toMatch(/agentinbox\s+skip: this is agentinbox itself/);
    expect(out).toMatch(/whoop\s+create connection "whoop" → https:\/\/whoop\.weish\.me\/api\/mcp/);
    expect(out).toContain("its Authorization header moves into agentinbox (encrypted; never shown)");
    expect(out).toContain("private network: needs the allow for exactly http://127.0.0.1:8787");
    expect(out).toContain("private network: needs the allow for exactly http://100.104.249.49:3773");
    expect(out).toContain("OAuth: created needing Connect (Hermes keeps its own tokens)");
    expect(out).toMatch(/playwright\s+not supported yet \(M4\)/);
    expect(out).toContain("Would ask before allowing http://127.0.0.1:8787, http://127.0.0.1:3000, http://127.0.0.1:3773, http://100.104.249.49:3773.");
    // The setup-mcp preview: which entries go, the single agentinbox entry (key shown as a placeholder).
    expect(out).toContain(`remove "mcp_servers.whoop" from ${join(hermes, "config.yaml")}`);
    expect(out).toContain(`remove "mcp_servers.hearloom"`);
    expect(out).not.toContain(`remove "mcp_servers.forge"`);
    expect(out).toContain("<the key from your agentinbox profile>");
    expect(daemon.calls).toEqual([]);
    expect(readFileSync(join(hermes, "config.yaml"), "utf8")).toBe(before);
    expect(backups(hermes)).toEqual([]);
  });

  it("--yes creates the connections, moves the headers, then replaces only the working entries (with a backup)", async () => {
    pairHermes();
    const original = readFileSync(join(hermes, "config.yaml"), "utf8");
    const daemon = new FakeConnectionsDaemon();
    const p = new ScriptedPrompter([], true);
    const code = await runImport({ from: "hermes", yes: true }, deps(daemon, p));
    expect(code).toBe(0);

    expect(daemon.created.map((c) => [c.slug, c.url, c.auth, c.privateTarget, c.level, c.agents, c.source])).toEqual([
      ["whoop", "https://whoop.weish.me/api/mcp", { type: "header", name: "Authorization", value: "Bearer whoop-secret-111" }, null, "ask", "all", "import:hermes"],
      ["brightspace", "http://127.0.0.1:8787/mcp", { type: "header", name: "Authorization", value: "Bearer brightspace-secret-222" }, "http://127.0.0.1:8787", "ask", "all", "import:hermes"],
      ["hearloom", "http://127.0.0.1:3000/mcp", { type: "header", name: "Authorization", value: "Bearer hearloom-secret-333" }, "http://127.0.0.1:3000", "ask", "all", "import:hermes"],
      ["t3code-macbook", "http://127.0.0.1:3773", { type: "oauth" }, "http://127.0.0.1:3773", "ask", "all", "import:hermes"],
      ["forge", "http://100.104.249.49:3773", { type: "oauth" }, "http://100.104.249.49:3773", "ask", "all", "import:hermes"],
    ]);
    const out = p.text;
    for (const s of [...SECRETS, PROFILE_KEY]) expect(out).not.toContain(s);
    expect(out).toContain("These servers are on this machine or your private network:");
    expect(out).toContain("Reconnect: http://localhost:8425/connections/forge  or  npx agentinbox-cli connections reconnect forge");

    // Hermes now has the broker entry (same "agentinbox" name, so mcp-agentinbox routes keep working), the two
    // OAuth servers until they're reconnected, and the stdio one.
    const after = readFileSync(join(hermes, "config.yaml"), "utf8");
    expect(Object.keys(readMcpServers(after)!)).toEqual(["agentinbox", "t3code-macbook", "forge", "playwright"]);
    expect(after).toContain('url: "https://macbook.tailb10092.ts.net/mcp"');
    expect(after).toContain("platform_toolsets:\n  telegram: [web, mcp-agentinbox]");
    expect(after).toContain("model:\n  default: anthropic/claude-sonnet");
    expect(after).not.toContain("whoop");
    expect(readFileSync(join(hermes, ".env"), "utf8")).toContain(`AGENTINBOX_API_KEY=${PROFILE_KEY}`);
    const configBackup = backups(hermes).find((f) => f.startsWith("config.yaml."))!;
    expect(readFileSync(join(hermes, configBackup), "utf8")).toBe(original);
    expect(out).toContain("WHOOP_MCP_TOKEN, BRIGHTSPACE_TOKEN, HEARLOOM_TOKEN are no longer needed");
  });

  it("re-running after Reconnect replaces the OAuth entries too, and creates nothing twice", async () => {
    pairHermes();
    const daemon = new FakeConnectionsDaemon();
    await runImport({ from: "hermes", yes: true }, deps(daemon, new ScriptedPrompter([], true)));
    for (const c of daemon.connections) c.status = "active";
    const created = daemon.created.length;
    const p = new ScriptedPrompter([], true);
    expect(await runImport({ from: "hermes", yes: true }, deps(daemon, p))).toBe(0);
    expect(daemon.created.length).toBe(created);
    expect(p.text).toContain('already a connection: "forge" (active)');
    expect(Object.keys(readMcpServers(readFileSync(join(hermes, "config.yaml"), "utf8"))!)).toEqual(["agentinbox", "playwright"]);
  });

  it("a failed connection stays in Hermes; the rest are replaced", async () => {
    pairHermes();
    const daemon = new FakeConnectionsDaemon();
    daemon.failCreate.add("hearloom");
    const p = new ScriptedPrompter([], true);
    expect(await runImport({ from: "hermes", yes: true }, deps(daemon, p))).toBe(1);
    expect(p.text).toContain("✘ hearloom: Couldn't reach http://127.0.0.1:3000/mcp (it stays in Hermes)");
    expect(Object.keys(readMcpServers(readFileSync(join(hermes, "config.yaml"), "utf8"))!)).toEqual(["agentinbox", "hearloom", "t3code-macbook", "forge", "playwright"]);
  });

  it("declining the private-network allow imports only the public server; declining setup-mcp changes nothing", async () => {
    pairHermes();
    const before = readFileSync(join(hermes, "config.yaml"), "utf8");
    const daemon = new FakeConnectionsDaemon();
    // private allow? no · access: 3 (read) · all agents? yes · create? yes · replace in Hermes? no
    const p = new ScriptedPrompter(["n", "3", "y", "y", "n"]);
    expect(await runImport({ from: "hermes" }, deps(daemon, p))).toBe(0);
    expect(p.asked[0]).toContain("Allow agentinbox to connect to these 4?");
    expect(p.text).toContain("  http://100.104.249.49:3773  (forge)");
    expect(daemon.created.map((c) => [c.slug, c.level])).toEqual([["whoop", "read"]]);
    expect(readFileSync(join(hermes, "config.yaml"), "utf8")).toBe(before);
    expect(backups(hermes)).toEqual([]);
  });

  it("without a paired agentinbox entry it says how to finish, and leaves Hermes alone", async () => {
    const before = readFileSync(join(hermes, "config.yaml"), "utf8");
    const p = new ScriptedPrompter([], true);
    await runImport({ from: "hermes", yes: true }, deps(new FakeConnectionsDaemon(), p));
    expect(p.text).toContain("pair it first (npx agentinbox-cli connect <agentinbox-url> --tool hermes)");
    expect(readFileSync(join(hermes, "config.yaml"), "utf8")).toBe(before);
  });

  it("refuses without a terminal or --yes, before creating anything", async () => {
    const daemon = new FakeConnectionsDaemon();
    const p = new ScriptedPrompter([]);
    Object.defineProperty(p, "interactive", { value: false });
    await expect(runImport({ from: "hermes" }, deps(daemon, p))).rejects.toThrow(/pass --yes/);
    expect(daemon.created).toEqual([]);
  });

  it("says when the daemon has connections turned off", async () => {
    const daemon = new FakeConnectionsDaemon();
    daemon.brokerOff = true;
    await expect(runImport({ from: "hermes", yes: true }, deps(daemon, new ScriptedPrompter([], true)))).rejects.toThrow(/brokerUpstreams/);
  });
});

describe("setup-mcp removing imported entries", () => {
  const target = { name: "agentinbox", url: "https://mail.example.com/mcp", key: PROFILE_KEY };

  it("Hermes: one entry it can't cut out safely leaves config.yaml and .env untouched", () => {
    const yaml = readFileSync(join(hermes, "config.yaml"), "utf8").replace(/  whoop:\n    url: https:\/\/whoop\.weish\.me\/api\/mcp\n/, "  whoop: { url: https://whoop.weish.me/api/mcp }\n  whoop-old:\n");
    writeFileSync(join(hermes, "config.yaml"), yaml);
    const envBefore = readFileSync(join(hermes, ".env"), "utf8");
    const r = setupMcp("hermes", target, "/p.json", { removeServers: [{ name: "whoop" }, { name: "brightspace" }] });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("nothing was changed");
    expect(readFileSync(join(hermes, "config.yaml"), "utf8")).toBe(yaml);
    expect(readFileSync(join(hermes, ".env"), "utf8")).toBe(envBefore);
    expect(backups(hermes)).toEqual([]);
  });

  it("Hermes: an entry that isn't there changes nothing either", () => {
    const before = readFileSync(join(hermes, "config.yaml"), "utf8");
    const r = setupMcp("hermes", target, "/p.json", { removeServers: [{ name: "whoop" }, { name: "nope" }] });
    expect(r.ok).toBe(false);
    expect(readFileSync(join(hermes, "config.yaml"), "utf8")).toBe(before);
  });

  it("Codex and Cursor: the imported entries go in the same write as the agentinbox entry", () => {
    mkdirSync(join(home, ".codex"));
    copyFileSync(join(FIXTURES, "codex-config.toml"), join(home, ".codex", "config.toml"));
    const codex = setupMcp("codex", target, "/p.json", { removeServers: [{ name: "example" }, { name: "region" }] });
    expect(codex.ok).toBe(true);
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(toml).not.toContain("[mcp_servers.example]");
    expect(toml).not.toContain("[mcp_servers.region]");
    expect(toml).toContain("[mcp_servers.notion]");
    expect(toml).toContain("[mcp_servers.docs.env]");
    expect(toml).toContain("[profiles.fast]");
    expect(backups(join(home, ".codex"))).toHaveLength(1);

    mkdirSync(join(home, ".cursor"));
    copyFileSync(join(FIXTURES, "cursor-mcp.json"), join(home, ".cursor", "mcp.json"));
    const bad = setupMcp("cursor", target, "/p.json", { removeServers: [{ name: "github" }, { name: "missing" }] });
    expect(bad.ok).toBe(false);
    expect(backups(join(home, ".cursor"))).toEqual([]);
    const ok = setupMcp("cursor", target, "/p.json", { removeServers: [{ name: "github" }] });
    expect(ok.ok).toBe(true);
    const doc = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(doc.mcpServers).sort()).toEqual(["agentinbox", "figma", "fs"]);
  });

  it("Claude Code: removes each imported entry in its own scope after adding agentinbox", () => {
    const bin = join(env.root, "bin");
    mkdirSync(bin);
    const log = join(env.root, "claude-args.txt");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$PWD :: $*" >> ${log}\nexit 0\n`);
    chmodSync(join(bin, "claude"), 0o755);
    process.env.PATH = `${bin}:${saved.PATH}`;
    writeFileSync(join(home, ".claude.json"), "{}");
    saveProfile("default", { url: "https://mail.example.com", apiKey: PROFILE_KEY, agentId: "a", agentName: "n", consumer: "c" });
    const proj = join(env.root, "proj");
    mkdirSync(proj);
    const r = setupMcp("claude-code", { ...target, profile: "default" }, "/p.json", {
      removeServers: [{ name: "stripe", scope: "user" }, { name: "docs", scope: "project", projectDir: proj }],
    });
    expect(r.ok).toBe(true);
    expect(r.removed).toEqual(["stripe", "docs"]);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.slice(-2)).toEqual([`${process.cwd()} :: mcp remove stripe --scope user`, `${proj} :: mcp remove docs --scope project`]);
    expect(lines.findIndex((l) => l.includes("add-json"))).toBeLessThan(lines.findIndex((l) => l.includes("remove stripe")));
    expect(existsSync(join(home, ".claude.json"))).toBe(true);
  });
});
