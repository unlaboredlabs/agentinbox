import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexBlock, removeTomlServer, setupMcp, upsertYamlServer } from "../server/listen/mcpsetup.ts";
import { FAKE_KEY, isolateXdg } from "./listen-client-fake.ts";

let env: ReturnType<typeof isolateXdg>;
let home: string;
const saved = { HOME: process.env.HOME, PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, HERMES_HOME: process.env.HERMES_HOME };
const target = { name: "agentinbox", url: "https://mail.example.com/mcp", key: FAKE_KEY };

beforeEach(() => {
  env = isolateXdg();
  home = join(env.root, "home");
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.HERMES_HOME;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  env.restore();
});

const backups = (dir: string) => readdirSync(dir).filter((f) => f.includes(".agentinbox-backup-"));

describe("setup-mcp", () => {
  it("Claude Code: runs `claude mcp add` with an argv array and never relays the key", () => {
    const bin = join(env.root, "bin");
    mkdirSync(bin);
    const log = join(env.root, "claude-args.txt");
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> ${log}; done; printf -- '--\\n' >> ${log}\n` +
        `if [ "$1 $2" = "mcp add" ] && [ -n "$FAIL" ]; then echo "error: header $8 $9 \${10} \${11}"; exit 1; fi\nexit 0\n`,
    );
    chmodSync(join(bin, "claude"), 0o755);
    process.env.PATH = `${bin}:${saved.PATH}`;
    writeFileSync(join(home, ".claude.json"), "{}");

    const r = setupMcp("claude-code", target, "/p.json");
    expect(r.ok).toBe(true);
    expect(r.message).not.toContain(FAKE_KEY);
    const calls = readFileSync(log, "utf8").split("--\n").filter(Boolean).map((c) => c.trim().split("\n"));
    expect(calls[1]).toEqual(["mcp", "remove", "agentinbox", "--scope", "user"]);
    expect(calls[2]).toEqual(["mcp", "add", "--transport", "http", "--scope", "user", "agentinbox", "https://mail.example.com/mcp", "--header", `Authorization: Bearer ${FAKE_KEY}`]);
    expect(backups(home)).toHaveLength(1);

    process.env.FAIL = "1";
    try {
      const failed = setupMcp("claude-code", target, "/p.json");
      expect(failed.ok).toBe(false);
      expect(failed.message).toContain("aib_…(redacted)");
      expect(JSON.stringify(failed)).not.toContain(FAKE_KEY);
    } finally {
      delete process.env.FAIL;
    }
  });

  it("Claude Code: explains the manual command when the CLI is missing", () => {
    process.env.PATH = "/nonexistent";
    const r = setupMcp("claude-code", target, "/p.json");
    expect(r.ok).toBe(false);
    expect(r.manual?.join("\n")).toContain("claude mcp add --transport http --scope user agentinbox");
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
  });

  it("Codex: replaces our table in config.toml, keeps the rest, backs up, 0600", () => {
    const dir = join(home, ".codex");
    mkdirSync(dir);
    const file = join(dir, "config.toml");
    writeFileSync(
      file,
      `model = "o5"\n\n[mcp_servers.agentinbox]\nurl = "https://old/mcp"\n\n[mcp_servers.agentinbox.env]\nX = "1"\n\n[mcp_servers.other]\ncommand = "x"\n`,
    );
    const r = setupMcp("codex", target, "/p.json");
    expect(r.ok).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text).toContain('model = "o5"');
    expect(text).toContain("[mcp_servers.other]");
    expect(text).not.toContain("https://old/mcp");
    expect(text).not.toContain("[mcp_servers.agentinbox.env]");
    expect(text.match(/\[mcp_servers\.agentinbox\]/g)).toHaveLength(1);
    expect(text).toContain(`http_headers = { Authorization = "Bearer ${FAKE_KEY}" }`);
    expect(text).toContain('default_tools_approval_mode = "approve"');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(backups(dir)).toHaveLength(1);
    expect(r.message).not.toContain(FAKE_KEY);
  });

  it("Codex: refuses inline mcp_servers definitions", () => {
    expect(removeTomlServer(`mcp_servers = { agentinbox = { url = "x" } }\n`, "agentinbox")).toBeNull();
    expect(removeTomlServer(`[x]\nmcp_servers.agentinbox.url = "x"\n`, "agentinbox")).toBeNull();
    expect(removeTomlServer(`[mcp_servers."agentinbox"]\nurl = "x"\n[y]\nz = 1\n`, "agentinbox")).toBe(`[y]\nz = 1\n`);
    expect(codexBlock(target)).toContain("[mcp_servers.agentinbox]");
  });

  it("Cursor: merges mcp.json", () => {
    const dir = join(home, ".cursor");
    mkdirSync(dir);
    const file = join(dir, "mcp.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "x" } }, extra: true }));
    expect(setupMcp("cursor", target, "/p.json").ok).toBe(true);
    const doc = JSON.parse(readFileSync(file, "utf8"));
    expect(doc).toEqual({
      mcpServers: { other: { command: "x" }, agentinbox: { url: target.url, headers: { Authorization: `Bearer ${FAKE_KEY}` } } },
      extra: true,
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, "{ // comment\n}");
    const r = setupMcp("cursor", target, "/p.json");
    expect(r.ok).toBe(false);
    expect(r.manual?.length).toBeGreaterThan(0);
  });

  it("Hermes: adds mcp_servers to config.yaml and the key to .env", () => {
    const dir = join(home, ".hermes");
    mkdirSync(dir);
    writeFileSync(join(dir, "config.yaml"), `model: hermes-4\nmcp_servers:\n    github:\n        command: gh-mcp\n    agentinbox:\n        url: "https://old"\ntoolsets: [web]\n`);
    writeFileSync(join(dir, ".env"), "OPENROUTER_API_KEY=x\nAGENTINBOX_API_KEY=old\n");
    const r = setupMcp("hermes", target, "/p.json");
    expect(r.ok).toBe(true);
    const yaml = readFileSync(join(dir, "config.yaml"), "utf8");
    expect(yaml).toBe(
      `model: hermes-4\nmcp_servers:\n    agentinbox:\n        url: "https://mail.example.com/mcp"\n        headers:\n          Authorization: "Bearer \${AGENTINBOX_API_KEY}"\n    github:\n        command: gh-mcp\ntoolsets: [web]\n`,
    );
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(`OPENROUTER_API_KEY=x\nAGENTINBOX_API_KEY=${FAKE_KEY}\n`);
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(yaml).not.toContain(FAKE_KEY);
  });

  it("Hermes: YAML edge cases", () => {
    const entry = ['url: "u"'];
    expect(upsertYamlServer("", "agentinbox", entry)).toBe('mcp_servers:\n  agentinbox:\n    url: "u"\n');
    expect(upsertYamlServer("a: 1\nmcp_servers: {}\n", "agentinbox", entry)).toBe('a: 1\nmcp_servers:\n  agentinbox:\n    url: "u"\n');
    expect(upsertYamlServer("mcp_servers: { x: 1 }\n", "agentinbox", entry)).toBeNull();
    expect(existsSync(join(home, ".hermes"))).toBe(false);
  });
});
