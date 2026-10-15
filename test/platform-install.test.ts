import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoogleService } from "../server/google/types.ts";
import { lockPath } from "../server/instance.ts";
import { nodeVersionError } from "../server/node-check.ts";
import { installService, serviceHints, type ServiceOps, serviceStatus, systemOps, uninstallService } from "../server/service.ts";
import { defaultPublicUrl } from "../server/settings.ts";
import { testConfig, testContext } from "./helpers.ts";
import { CSRF, type Harness, harness } from "./platform-helpers.ts";

const ROOT = join(import.meta.dirname, "..");
function cli(args: string[], env: Record<string, string> = {}) {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", join(ROOT, "server/cli.ts"), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", PORT: "", HOST: "", AGENTINBOX_URL: "", ...env },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

let cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
  vi.restoreAllMocks();
});

describe("1: Node version check", () => {
  it("explains a too-old Node", () => {
    expect(nodeVersionError("22.12.0")).toBe(
      "agentinbox needs Node.js 22.13 or newer (you have v22.12.0). Install a current Node.js from https://nodejs.org and try again.",
    );
    expect(nodeVersionError("v20.18.1")).toMatch(/you have v20\.18\.1/);
    expect(nodeVersionError("18.0.0")).not.toBeNull();
    expect(nodeVersionError("22.13.0")).toBeNull();
    expect(nodeVersionError("22.20.1")).toBeNull();
    expect(nodeVersionError("24.0.0")).toBeNull();
  });

  it("runs before anything else in the CLI", () => {
    const src = readFileSync(join(ROOT, "server/cli.ts"), "utf8");
    expect(src.indexOf('import "./node-check.ts";')).toBeLessThan(src.indexOf("import {"));
  });
});

// ───────────── 3: service install rollback ─────────────

function fakeOps(dir: string, failOn?: (cmd: string, args: string[]) => boolean): ServiceOps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    platform: "linux",
    root: false,
    uid: 1000,
    user: "me",
    exec(cmd, args) {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (failOn?.(cmd, args)) throw new Error(`Command failed: ${cmd} ${args.join(" ")}`);
    },
    stage(dataDir) {
      const staging = join(dataDir, "app.new");
      mkdirSync(join(staging, "node_modules/agentinbox-cli/dist"), { recursive: true });
      writeFileSync(join(staging, "node_modules/agentinbox-cli/dist/cli.js"), "// new\n");
      return staging;
    },
    unitDir: () => join(dir, "units"),
    waitReady: async () => {},
  };
}

describe("3: service install", () => {
  const setup = () => {
    const config = testConfig();
    cleanup.push(() => rmSync(config.dataDir, { recursive: true, force: true }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    return config;
  };
  const enableFails = (cmd: string, args: string[]) => cmd === "systemctl" && args.includes("enable");

  it("installs a user unit without network-online and cleans up the staging dirs", async () => {
    const config = setup();
    const ops = fakeOps(config.dataDir);
    await installService(config, ops);
    const unit = readFileSync(join(config.dataDir, "units/agentinbox.service"), "utf8");
    expect(unit).not.toContain("network-online");
    expect(unit).toContain("WantedBy=default.target");
    expect(existsSync(join(config.dataDir, "app/node_modules/agentinbox-cli/dist/cli.js"))).toBe(true);
    expect(existsSync(join(config.dataDir, "app.new"))).toBe(false);
    expect(existsSync(join(config.dataDir, "app.old"))).toBe(false);
    expect(ops.calls).toContain("systemctl --user enable --now agentinbox");
    expect(ops.calls).toContain("loginctl enable-linger me");
  });

  it("rolls a fresh install back completely when the service can't start", async () => {
    const config = setup();
    const ops = fakeOps(config.dataDir, enableFails);
    const err = await installService(config, ops).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/Starting the service failed .*Rolled back to no service/s);
    expect(err?.message).toContain("journalctl --user -u agentinbox -e");
    expect(existsSync(join(config.dataDir, "units/agentinbox.service"))).toBe(false);
    expect(existsSync(join(config.dataDir, "app"))).toBe(false);
    expect(ops.calls.filter((c) => c === "systemctl --user daemon-reload").length).toBeGreaterThanOrEqual(2);
  });

  it("restores the previous install when an update can't start", async () => {
    const config = setup();
    mkdirSync(join(config.dataDir, "units"), { recursive: true });
    writeFileSync(join(config.dataDir, "units/agentinbox.service"), "previous unit\n");
    mkdirSync(join(config.dataDir, "app"), { recursive: true });
    writeFileSync(join(config.dataDir, "app/marker"), "old app");
    writeFileSync(join(config.dataDir, "service.env"), "TRUST_PROXY=1\n");
    let attempts = 0;
    // The new unit fails to start; re-enabling the restored one works.
    const ops = fakeOps(config.dataDir, (cmd, args) => enableFails(cmd, args) && ++attempts === 1);
    await expect(installService(config, ops)).rejects.toThrow(/Rolled back to the previous install/);
    expect(readFileSync(join(config.dataDir, "units/agentinbox.service"), "utf8")).toBe("previous unit\n");
    expect(readFileSync(join(config.dataDir, "app/marker"), "utf8")).toBe("old app");
    expect(readFileSync(join(config.dataDir, "service.env"), "utf8")).toBe("TRUST_PROXY=1\n");
    expect(attempts).toBe(2);
  });

  it("uses $XDG_CONFIG_HOME for the user unit and explains a missing user session", () => {
    const saved = { xdg: process.env.XDG_CONFIG_HOME };
    process.env.XDG_CONFIG_HOME = "/tmp/xdg-test";
    try {
      const ops = systemOps();
      if (process.platform === "linux" && !ops.root) expect(ops.unitDir()).toBe("/tmp/xdg-test/systemd/user");
    } finally {
      if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved.xdg;
    }
    const ops = fakeOps("/tmp/x");
    expect(serviceHints(ops, {}).join("\n")).toMatch(/XDG_RUNTIME_DIR is not set.*enable-linger me.*\/run\/user\/1000/s);
    expect(serviceHints(ops, { XDG_RUNTIME_DIR: "/run/user/1000" })).toHaveLength(2);
    expect(serviceHints({ ...ops, root: true }, {})).toEqual(["systemctl status agentinbox", "journalctl -u agentinbox -e"]);
  });

  it("uninstall removes the service's app; status says when nothing is installed", async () => {
    const config = setup();
    const ops = fakeOps(config.dataDir);
    await installService(config, ops);
    writeFileSync(config.dbPath, "data");
    uninstallService(config, ops);
    expect(existsSync(join(config.dataDir, "units/agentinbox.service"))).toBe(false);
    expect(existsSync(join(config.dataDir, "app"))).toBe(false);
    expect(readFileSync(config.dbPath, "utf8")).toBe("data");
    const log = vi.spyOn(console, "log");
    serviceStatus(ops);
    expect(log.mock.calls.flat().join(" ")).toMatch(/not installed/);
    process.exitCode = 0;
  });
});

describe("4: default public URL", () => {
  it("uses localhost for all-interfaces and loopback binds, else the chosen host", () => {
    expect(defaultPublicUrl("0.0.0.0", 8425)).toBe("http://localhost:8425");
    expect(defaultPublicUrl("::", 8425)).toBe("http://localhost:8425");
    expect(defaultPublicUrl("127.0.0.1", 8425)).toBe("http://localhost:8425");
    expect(defaultPublicUrl("::1", 8425)).toBe("http://localhost:8425");
    expect(defaultPublicUrl("192.168.1.5", 9000)).toBe("http://192.168.1.5:9000");
    expect(defaultPublicUrl("100.64.1.2", 8425)).toBe("http://100.64.1.2:8425");
    expect(defaultPublicUrl("fd00::5", 8425)).toBe("http://[fd00::5]:8425");
    expect(defaultPublicUrl("Mail.LAN", 8425)).toBe("http://mail.lan:8425");
  });

  it("is the settings default", async () => {
    const t = testContext({}, { host: "10.0.0.2", port: 9100 });
    cleanup.push(t.dispose);
    expect(t.ctx.settings.publicUrl()).toBe("http://10.0.0.2:9100");
  });
});

describe("5: CLI commands", () => {
  it("reports unknown commands with a suggestion", () => {
    let r = cli(["skil"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown command 'skil'");
    expect(r.stderr).toContain("Did you mean skill?");
    r = cli(["frobnicate"]);
    expect(r.stderr).toContain("unknown command 'frobnicate'");
    expect(r.stderr).not.toContain("Did you mean");
  });

  it("documents reset-password's --port and --host", () => {
    const r = cli(["reset-password", "--help"]);
    expect(r.stdout).toContain("port of the running instance, used for the printed link");
    expect(r.stdout).toContain("host of the running instance, used for the printed link");
  });
});

describe("7/8: skill commands", () => {
  it("defaults the URL to the running instance, else localhost:8425", () => {
    const data = mkdtempSync(join(tmpdir(), "agentinbox-skill-"));
    cleanup.push(() => rmSync(data, { recursive: true, force: true }));
    expect(cli(["skill", "print"], { AGENTINBOX_DATA: data }).stdout).toContain("http://localhost:8425/mcp");
    writeFileSync(lockPath(data), JSON.stringify({ pid: process.pid, host: "0.0.0.0", port: 9234, startedAt: "" }));
    expect(cli(["skill", "print"], { AGENTINBOX_DATA: data }).stdout).toContain("http://localhost:9234/mcp");
    writeFileSync(lockPath(data), JSON.stringify({ pid: process.pid, host: "192.168.7.7", port: 9235, startedAt: "" }));
    expect(cli(["skill", "print"], { AGENTINBOX_DATA: data }).stdout).toContain("http://192.168.7.7:9235/mcp");
  });

  it("accepts known targets and paths, and refuses typos", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentinbox-skills-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    let r = cli(["skill", "install", "-t", "claud", "--url", "http://x.test"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Unknown skill target "claud". Did you mean claude?');
    r = cli(["skill", "install", "-t", "notes", "--url", "http://x.test"]);
    expect(r.stderr).toContain("directory path such as ./skills");
    r = cli(["skill", "install", "-t", join(dir, "skills"), "--url", "http://x.test"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "skills/agentinbox/SKILL.md"), "utf8")).toContain("http://x.test/mcp");
  });
});

describe("16: account connect options", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.dispose();
    h = undefined;
  });

  it("passes scopes and reauthAccountId through to startConnect", async () => {
    const seen: unknown[] = [];
    const google = () =>
      ({
        clientView: () => ({ clientId: null, hasSecret: false, projectId: null, appType: null, redirectUri: "", callbackMode: "direct" }),
        pubsubState: () => ({ mode: "poll", topic: null, subscription: null, lastError: null, lastMessageAt: null }),
        startConnect: (opts: unknown) => {
          seen.push(opts);
          return { authUrl: "https://accounts.google.com/x", state: "s", callbackMode: "direct" };
        },
      }) as unknown as GoogleService;
    h = harness({ google });
    const cookie = await h.claim();
    const connect = (json: unknown) => h!.request("/api/accounts/connect", { method: "POST", headers: CSRF, cookie, json });
    expect((await connect({ scopes: ["pubsub"], reauthAccountId: "acc_1" })).status).toBe(200);
    expect((await connect({})).status).toBe(200);
    expect(seen).toEqual([{ scopes: ["pubsub"], reauthAccountId: "acc_1" }, { scopes: undefined, reauthAccountId: undefined }]);
    expect((await connect({ scopes: ["gmail"] })).status).toBe(400);
  });
});
