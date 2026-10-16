// The code-extension host (server/extensions/host, docs/EXTENSIONS.md "The code-extension host"), against the echo
// fixture (test/fixtures/extensions/echo): the exact spawn, the environment, the sandbox (every escape attempt fails),
// the extension-to-host protocol, prompts and resources, the lifecycle (integrity, crash restarts, SIGTERM/SIGKILL)
// and the limits. Real child processes, no network.

import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IntegrationEvent } from "../server/broker/types.ts";
import {
  childArgs,
  childEnv,
  type CodeSourceDeps,
  type CodeToolSource,
  codeExtensionSource,
  createCodeSource,
  extensionStateDir,
  type InstalledExtension,
  removeConnectionState,
} from "../server/extensions/host/index.ts";

const FIXTURE = resolve(import.meta.dirname, "fixtures/extensions/echo");
const TOKEN = "tok_live_0123456789abcdefghij";

type Log = { level: "info" | "warn"; msg: string; meta?: Record<string, unknown> };

interface World {
  dataDir: string;
  installDir: string;
  ext: InstalledExtension;
  logs: Log[];
  events: IntegrationEvent[];
  errors: (string | null)[];
  deps(connectionId: string, extra?: Partial<CodeSourceDeps>): CodeSourceDeps;
}

function world(): World {
  const dataDir = mkdtempSync(join(tmpdir(), "xaq-ext-"));
  // An install as the store lays it out: <dataDir>/extensions/<name>/<integrity-hex-prefix>/.
  const installDir = join(dataDir, "extensions", "echo", "0123abcd");
  mkdirSync(installDir, { recursive: true });
  cpSync(FIXTURE, installDir, { recursive: true });
  // What the sandbox must keep out of reach.
  writeFileSync(join(dataDir, "master.key"), "MASTER-KEY-SECRET", { mode: 0o600 });
  writeFileSync(join(dataDir, "xaq.db"), "SQLite format 3\0 the database", { mode: 0o600 });
  const manifest = JSON.parse(readFileSync(join(installDir, "xaq-extension.json"), "utf8")) as unknown;
  const ext: InstalledExtension = {
    name: "echo",
    kind: "code",
    version: "1.0.0",
    source: FIXTURE,
    commit: null,
    integrity: "sha256-test",
    official: false,
    installDir,
    manifest,
    installedAt: new Date().toISOString(),
  };
  const w: World = {
    dataDir,
    installDir,
    ext,
    logs: [],
    events: [],
    errors: [],
    deps: (connectionId, extra = {}) => ({
      connectionId,
      stateDir: extensionStateDir(dataDir, "echo", connectionId),
      accessToken: async () => TOKEN,
      tokenExpiresAt: () => 1_900_000_000_000,
      fetch: globalThis.fetch,
      log: { info: (msg, meta) => void w.logs.push({ level: "info", msg, meta }), warn: (msg, meta) => void w.logs.push({ level: "warn", msg, meta }) },
      emit: (e) => void w.events.push(e),
      verify: () => true,
      setError: (r) => void w.errors.push(r),
      ...extra,
    }),
  };
  return w;
}

const ctl = () => ({ agentId: "agt_1", connectionId: "con_a", signal: AbortSignal.timeout(20_000), auditDetail: {} });
const textOf = (r: { content: { type: string; text?: unknown }[] }) => r.content.map((c) => String(c.text ?? "")).join("");
const jsonOf = <T = Record<string, unknown>>(r: { content: { type: string; text?: unknown }[] }) => JSON.parse(textOf(r)) as T;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(20);
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let w: World;
const sources: CodeToolSource[] = [];
const open = (connectionId = "con_a", extra: Partial<CodeSourceDeps> = {}) => {
  const s = createCodeSource(w.ext, w.deps(connectionId, extra));
  sources.push(s);
  return s;
};

beforeEach(() => {
  w = world();
});
afterEach(async () => {
  await Promise.all(sources.splice(0).map((s) => s.close()));
  rmSync(w.dataDir, { recursive: true, force: true });
});

describe("spawn", () => {
  it("argv: --permission and one flag per allowed path, never the comma form, nothing else", () => {
    const args = childArgs("/data/extensions/echo/ab12", "/data/extension-state/echo/con_a", "/data/extensions/echo/ab12/dist/server.mjs");
    expect(args).toEqual([
      "--permission",
      "--allow-fs-read=/data/extensions/echo/ab12",
      "--allow-fs-read=/data/extension-state/echo/con_a",
      "--allow-fs-write=/data/extension-state/echo/con_a",
      "/data/extensions/echo/ab12/dist/server.mjs",
    ]);
    // Node 22.13 and 24 read `--allow-fs-read=a,b` as one literal path: it must never come back.
    expect(args.filter((a) => a.startsWith("--allow-fs-")).every((a) => !a.includes(","))).toBe(true);
    expect(args.join(" ")).not.toMatch(/--allow-(child-process|worker|addons|wasi)|--experimental/);
  });

  it("the live child got exactly that argv, cwd = its state dir (0700), and only the contract's environment", async () => {
    const saved = { ...process.env };
    // Secrets and noise xaq's own environment might hold; NODE_OPTIONS would break the child if it leaked.
    Object.assign(process.env, {
      XAQ_MASTER_KEY: "c2VjcmV0LW1hc3Rlci1rZXk=",
      AGENTINBOX_MASTER_KEY: "legacy-secret",
      XAQ_SETUP_TOKEN: "setup-secret",
      T3_AUTH_TOKEN: "t3-secret",
      NODE_OPTIONS: "--require /nonexistent/preload.cjs",
      TZ: "Europe/Paris",
      LANG: "fr_FR.UTF-8",
    });
    let s: CodeToolSource;
    try {
      s = open();
      await s.ready();
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    const stateDir = extensionStateDir(w.dataDir, "echo", "con_a");
    const r = jsonOf<{ execArgv: string[]; entry: string; cwd: string; env: Record<string, string> }>(await s!.callTool("argv", {}, ctl()));
    expect(r.execArgv).toEqual(["--permission", `--allow-fs-read=${w.installDir}`, `--allow-fs-read=${stateDir}`, `--allow-fs-write=${stateDir}`]);
    expect(r.entry).toBe(join(w.installDir, "dist/server.mjs"));
    expect(r.cwd).toBe(stateDir);
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(r.env).toEqual({
      XAQ_EXT_NAME: "echo",
      XAQ_EXT_CONNECTION_ID: "con_a",
      XAQ_EXT_STATE_DIR: stateDir,
      XAQ_EXT_PROTOCOL: "1",
      TZ: "Europe/Paris",
      LANG: "fr_FR.UTF-8",
    });
    expect(childEnv({ name: "echo", connectionId: "c", stateDir: "/s" }, {})).toEqual({ XAQ_EXT_NAME: "echo", XAQ_EXT_CONNECTION_ID: "c", XAQ_EXT_STATE_DIR: "/s", XAQ_EXT_PROTOCOL: "1" });
  });

  it("the state dir path refuses names and ids that aren't one path segment; removal deletes only that connection's state", () => {
    expect(() => extensionStateDir(w.dataDir, "../x", "con_a")).toThrow();
    expect(() => extensionStateDir(w.dataDir, "echo", "../../etc")).toThrow();
    const a = extensionStateDir(w.dataDir, "echo", "con_a");
    const b = extensionStateDir(w.dataDir, "echo", "con_b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, "f"), "1");
    removeConnectionState(w.dataDir, "con_a");
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(true);
    removeConnectionState(w.dataDir, "../..");
    expect(existsSync(w.dataDir)).toBe(true);
  });
});

describe("the sandbox (every escape attempt fails)", () => {
  it("can't read master.key or the DB, another connection's state, /proc or /etc; can't write outside its state; can't spawn, fork workers, load addons or open the inspector; sees no secrets; can't get another connection's credentials", async () => {
    const other = extensionStateDir(w.dataDir, "echo", "con_b");
    mkdirSync(other, { recursive: true, mode: 0o700 });
    writeFileSync(join(other, "secret.txt"), "OTHER-CONNECTION-STATE");
    // Files xaq holds open while it spawns (a real SQLite DB, master.key): none may be inherited.
    const db = new DatabaseSync(join(w.dataDir, "real.db"));
    db.exec("CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('secret row')");
    const keyFd = openSync(join(w.dataDir, "master.key"), "r");
    const s = open("con_a");
    await s.ready();
    closeSync(keyFd);
    db.close();
    const r = jsonOf<Record<string, string>>(
      await s.callTool(
        "escape",
        { paths: { masterKey: join(w.dataDir, "master.key"), db: join(w.dataDir, "xaq.db"), dataDir: w.dataDir, otherState: other, otherConnectionId: "con_b" } },
        ctl(),
      ),
    );
    expect(Object.keys(r).sort()).toEqual(
      [
        "addon",
        "envSecrets",
        "hardlinkToMasterKey",
        "inheritedFiles",
        "inspector",
        "listDataDir",
        "otherConnectionCredentials",
        "processBinding",
        "readDb",
        "readEtcPasswd",
        "readMasterKey",
        "readOtherState",
        "readOtherStateViaDotDot",
        "readParentEnviron",
        "spawnShell",
        "spawnSync",
        "symlinkToMasterKey",
        "worker",
        "writeDataDir",
        "writeInstallDir",
      ].sort(),
    );
    for (const [what, outcome] of Object.entries(r)) expect(outcome, what).toMatch(/^denied: /);
    // The permission model's own refusals, not accidents (a missing file would say ENOENT).
    for (const k of ["readMasterKey", "readDb", "readOtherState", "spawnSync", "worker", "writeDataDir", "readParentEnviron"]) expect(r[k], k).toBe("denied: ERR_ACCESS_DENIED");
    expect(r.envSecrets).toBe("denied: NO_SECRETS");
    expect(r.inheritedFiles).toBe("denied: NO_INHERITED_FILES");
    expect(r.otherConnectionCredentials).toMatch(/^denied: rpc -32602/);
    expect(existsSync(join(w.dataDir, "planted.txt"))).toBe(false);
    expect(existsSync(join(w.installDir, "dist", "planted.txt"))).toBe(false);
  });
});

describe("the protocol", () => {
  it("a tool call, the state dir, xaq/credentials/get for this connection only (never the refresh token or client secret)", async () => {
    const s = open();
    expect(textOf(await s.callTool("echo", { text: "hi there" }, ctl()))).toBe("hi there");
    expect(jsonOf(await s.callTool("state", { text: "kept" }, ctl()))).toEqual({ cwd: extensionStateDir(w.dataDir, "echo", "con_a"), read: "kept" });
    const who = jsonOf(await s.callTool("whoami", {}, ctl()));
    expect(who).toEqual({ tokenSha256: createHash("sha256").update(TOKEN).digest("hex"), expiresAt: 1_900_000_000_000, keys: ["accessToken", "expiresAt"] });
    const listed = await s.listTools(AbortSignal.timeout(5000));
    expect(listed.tools.map((t) => t.name)).toContain("echo");
    expect(listed.instructions).toBe("Echo test extension.");
  });

  it("fetch works under the real flags (the network isn't sandboxed): a loopback HTTP request from the child", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "text/plain" }).end("pong");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const { port } = server.address() as AddressInfo;
      const s = open();
      const r = jsonOf(await s.callTool("fetch", { url: `http://127.0.0.1:${port}/ping?x=1` }, ctl()));
      expect(r).toEqual({ status: 200, body: "pong" });
      expect(seen).toEqual(["GET /ping?x=1"]);
      // Under the exact argv the spawn test pins.
      expect(jsonOf<{ execArgv: string[] }>(await s.callTool("argv", {}, ctl())).execArgv[0]).toBe("--permission");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("a refused credential (needs re-auth) is a JSON-RPC error to the extension", async () => {
    const s = open("con_a", {
      accessToken: async () => {
        throw new Error("The owner must reconnect Echo");
      },
    });
    const whoami = await s.callTool("whoami", {}, ctl());
    expect(whoami.isError).toBe(true);
    expect(textOf(whoami)).toMatch(/needs_reauth/);
  });

  it("xaq/events/emit: the manifest's types reach the outbox, anything else is dropped and logged", async () => {
    const s = open();
    await s.callTool("emit", { type: "echo.said", key: "k1" }, ctl());
    await s.callTool("emit", { type: "calendar.event_created", key: "k2" }, ctl());
    await s.callTool("emit", { type: "echo.secret_thing", key: "k3" }, ctl());
    await until(() => w.logs.filter((l) => l.msg === "Dropped an event from a code extension").length === 2);
    expect(w.events).toEqual([{ type: "echo.said", connectionId: "con_a", dedupeKey: "k1", data: { said: "hi" } }]);
  });

  it("xaq/log: redacted and rate-limited", async () => {
    const s = open("con_a", { limits: { logBurst: 3, logPerSecond: 0.001 } });
    await s.callTool("whoami", {}, ctl()); // the host now knows the token it handed out
    await s.callTool("log", { msg: `token is ${TOKEN} and Bearer abcdefghijklmnop`, n: 10 }, ctl());
    await until(() => w.logs.some((l) => l.msg.startsWith("[echo]")));
    await sleep(100);
    const lines = w.logs.filter((l) => l.msg.startsWith("[echo]"));
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const l of lines) {
      expect(l.msg).not.toContain(TOKEN);
      expect(l.msg).not.toContain("abcdefghijklmnop");
      expect(l.msg).toContain("[redacted]");
    }
  });

  it("prompts, resources and resource templates", async () => {
    const s = open();
    const p = s.prompts;
    expect(await p.listPrompts(AbortSignal.timeout(5000))).toEqual([expect.objectContaining({ name: "greet", arguments: [{ name: "who", description: "Whom to greet", required: true }] })]);
    expect(await p.getPrompt("greet", { who: "Wynn" }, AbortSignal.timeout(5000))).toEqual({ description: "A greeting", messages: [{ role: "user", content: { type: "text", text: "Hello, Wynn!" } }] });
    expect(await p.listResources(AbortSignal.timeout(5000))).toEqual([expect.objectContaining({ uri: "echo://notes/today", name: "today" })]);
    expect(await p.listResourceTemplates(AbortSignal.timeout(5000))).toEqual([expect.objectContaining({ uriTemplate: "echo://notes/{day}" })]);
    expect(await p.readResource("echo://notes/today", AbortSignal.timeout(5000))).toEqual({ contents: [{ uri: "echo://notes/today", mimeType: "text/plain", text: "note for echo://notes/today" }] });
  });
});

describe("lifecycle", () => {
  it("re-verifies the integrity before every start: a mismatch never spawns and marks the connection error", async () => {
    let verified = 0;
    const s = open("con_a", { verify: () => (verified++, false) });
    await expect(s.listTools(AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "unavailable", message: expect.stringMatching(/integrity check failed/) });
    expect(s.pid).toBeNull();
    expect(verified).toBe(1);
    expect(w.errors.at(-1)).toMatch(/integrity check failed/);
    expect(existsSync(extensionStateDir(w.dataDir, "echo", "con_a"))).toBe(false);
  });

  it("checks it again on a restart after a crash", async () => {
    let ok = true;
    let verified = 0;
    const s = open("con_a", { verify: () => (verified++, ok), limits: { restartBaseMs: 50 } });
    await s.ready();
    expect(verified).toBe(1);
    ok = false;
    await s.callTool("crash", { code: 3 }, ctl());
    await until(() => s.status.state === "failed");
    expect(verified).toBe(2);
    expect(s.status.failure).toMatch(/integrity check failed/);
  });

  it("a crash restarts with backoff; repeated crashes mark the connection error with the last stderr lines, redacted", async () => {
    const s = open("con_a", { limits: { restartBaseMs: 100, restartMaxMs: 400, maxCrashes: 3 } });
    await s.ready();
    await s.callTool("whoami", {}, ctl());
    const firstPid = s.pid!;
    await s.callTool("crash", { code: 2, stderr: "first boom" }, ctl());
    await until(() => s.status.state === "backoff");
    await expect(s.callTool("echo", { text: "x" }, ctl())).rejects.toMatchObject({ code: "unavailable", message: expect.stringMatching(/restarting after a crash/) });
    await until(() => s.status.state === "running");
    expect(s.pid).not.toBe(firstPid);
    expect(textOf(await s.callTool("echo", { text: "back" }, ctl()))).toBe("back");

    await s.callTool("crash", { code: 2, stderr: "second boom" }, ctl());
    await until(() => s.status.state === "backoff");
    await until(() => s.status.state === "running", 8000);
    await s.callTool("crash", { code: 9, stderr: `last words: ${TOKEN} Bearer abcdefghijklmnop` }, ctl());
    await until(() => s.status.state === "failed", 8000);
    const reason = w.errors.at(-1)!;
    expect(reason).toMatch(/stopped 3 times in a row \(it exited with code 9\)/);
    expect(reason).toContain("last words:");
    expect(reason).not.toContain(TOKEN);
    expect(reason).not.toContain("abcdefghijklmnop");
    await expect(s.callTool("echo", { text: "x" }, ctl())).rejects.toMatchObject({ code: "unavailable" });
    // A successful start had cleared the error (null), in between.
    expect(w.errors).toContain(null);
  });

  it("close: SIGTERM, and SIGKILL after the grace period for a child that ignores it", async () => {
    const s = open("con_a", { limits: { killAfterMs: 300 } });
    await s.ready();
    const pid = s.pid!;
    await s.close();
    expect(alive(pid)).toBe(false);

    const t = open("con_b", { limits: { killAfterMs: 300 } });
    await t.ready();
    const pid2 = t.pid!;
    await t.callTool("stubborn", {}, ctl());
    const started = Date.now();
    await t.close();
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(alive(pid2)).toBe(false);
    await expect(t.callTool("echo", { text: "x" }, ctl())).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("limits", () => {
  it("concurrent calls are capped", async () => {
    const s = open("con_a", { limits: { maxConcurrent: 2 } });
    await s.ready();
    const slow = [s.callTool("slow", { ms: 400 }, ctl()), s.callTool("slow", { ms: 400 }, ctl())];
    await expect(s.callTool("echo", { text: "x" }, ctl())).rejects.toMatchObject({ code: "rate_limited" });
    await Promise.all(slow);
    expect(textOf(await s.callTool("echo", { text: "ok" }, ctl()))).toBe("ok");
  });

  it("a call times out", async () => {
    const s = open("con_a", { limits: { callTimeoutMs: 200 } });
    await s.ready();
    await expect(s.callTool("slow", { ms: 2000 }, ctl())).rejects.toMatchObject({ code: "timeout" });
  });

  it("an oversized message kills the child (treated as a crash)", async () => {
    const s = open("con_a", { limits: { maxMessageBytes: 64 * 1024, restartBaseMs: 60_000 } });
    await s.ready();
    const pid = s.pid!;
    await expect(s.callTool("big", { bytes: 200 * 1024 }, ctl())).rejects.toMatchObject({ code: "unavailable" });
    await until(() => !alive(pid));
    expect(s.status.state).toBe("backoff");
    expect(w.logs.some((l) => l.msg === "Code extension stopped unexpectedly" && String(l.meta?.how).includes("over"))).toBe(true);
  });
});

describe("codeExtensionSource", () => {
  it("builds the deps from the broker's (state dir under dataDir, emit, the store's verify)", async () => {
    const checked: string[] = [];
    const base = w.deps("con_a");
    const s = codeExtensionSource(w.ext, { connectionId: "con_a", accessToken: base.accessToken, fetch: base.fetch, log: base.log, dataDir: w.dataDir, emit: base.emit }, {
      verify: (name) => (checked.push(name), true),
    }) as CodeToolSource;
    sources.push(s);
    expect(textOf(await s.callTool("echo", { text: "via broker deps" }, ctl()))).toBe("via broker deps");
    expect(checked).toEqual(["echo"]);
    expect(existsSync(extensionStateDir(w.dataDir, "echo", "con_a"))).toBe(true);
    // Without a data dir or an outbox it refuses, without spawning.
    const none = codeExtensionSource(w.ext, { connectionId: "con_x", accessToken: base.accessToken, fetch: base.fetch, log: base.log }, { verify: () => true });
    await expect(none.listTools(AbortSignal.timeout(1000))).rejects.toMatchObject({ code: "unavailable" });
  });
});
