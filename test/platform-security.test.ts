import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { adminAuth, checkSecret } from "../server/auth/index.ts";
import { BAN_MS, clientKey, GLOBAL_MAX_FAILURES, LoginLimiter, MAX_ATTEMPTS, MAX_ENTRIES } from "../server/auth/lockout.ts";
import { SESSION_MAX_AGE_MS, SESSION_TTL_MS, SessionStore } from "../server/auth/sessions.ts";
import { acquireInstanceLock, assertMasterKeyUsable, bootId, lockPath, processStartTime, runningInstance } from "../server/instance.ts";
import { startServer } from "../server/server.ts";
import { testConfig } from "./helpers.ts";
import { CSRF, fakeGoogle, fakeIngest, type Harness, harness, json, PASSWORD } from "./platform-helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

const login = (password: string, headers: Record<string, string> = {}) =>
  h!.request("/api/auth/login", { method: "POST", headers: { ...CSRF, ...headers }, json: { password } });

describe("M1: lockout and hashing", () => {
  it("bans a client repeating the same wrong password after 30 attempts", async () => {
    h = harness();
    await h.claim();
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) expect((await login("same-wrong")).status).toBe(401);
    expect((await login("same-wrong")).status).toBe(401);
    expect((await login(PASSWORD)).status).toBe(429);
  });

  it("doesn't hash a secret the client already failed with", async () => {
    h = harness();
    let verifications = 0;
    const verify = () => (verifications++, false);
    await checkSecret(h.ctx, "1.1.1.1", "guess", verify);
    await checkSecret(h.ctx, "1.1.1.1", "guess", verify);
    await checkSecret(h.ctx, "1.1.1.1", "guess", verify);
    expect(verifications).toBe(1);
    // Another client still gets a real check.
    await checkSecret(h.ctx, "2.2.2.2", "guess", verify);
    expect(verifications).toBe(2);
  });

  it("clears failures when the password changes", async () => {
    h = harness();
    const cookie = await h.claim();
    for (let i = 0; i < 4; i++) await login(`wrong-${i}`);
    // "wrong-0" was rejected before; once it becomes the password it must work at once.
    const res = await h.request("/api/auth/password", { method: "POST", headers: CSRF, cookie, json: { current: PASSWORD, next: "wrong-0-but-now-right" } });
    expect(res.status).toBe(204);
    expect(adminAuth(h.ctx).limiter.size).toBe(0);
    expect((await login("wrong-0-but-now-right")).status).toBe(204);
  });

  it("keeps /health responsive while passwords are checked", async () => {
    h = harness();
    await h.claim();
    const attempts = Array.from({ length: 8 }, (_, i) => login(`parallel-${i}`, { "x-forwarded-for": `10.0.0.${i}` }));
    const started = performance.now();
    expect((await h.request("/health")).status).toBe(200);
    expect(performance.now() - started).toBeLessThan(100);
    await Promise.all(attempts);
  });
});

describe("M2: client identity", () => {
  it("uses the rightmost X-Forwarded-For entry behind a trusted proxy", async () => {
    h = harness();
    await h.claim();
    h.ctx.config.trustProxy = true;
    // The attacker rotates the spoofable left part; the proxy-appended address stays the same.
    for (let i = 0; i < 5; i++) await login(`wrong-${i}`, { "x-forwarded-for": `6.6.6.${i}, 203.0.113.7` });
    expect((await login(PASSWORD, { "x-forwarded-for": "9.9.9.9, 203.0.113.7" })).status).toBe(429);
    // Other clients are unaffected.
    expect((await login(PASSWORD, { "x-forwarded-for": "198.51.100.1" })).status).toBe(204);
  });

  it("honors TRUST_PROXY_HOPS", async () => {
    h = harness();
    await h.claim();
    h.ctx.config.trustProxy = true;
    process.env.TRUST_PROXY_HOPS = "2";
    try {
      for (let i = 0; i < 5; i++) await login(`wrong-${i}`, { "x-forwarded-for": `spoof-${i}, 203.0.113.7, 10.0.0.1` });
      expect((await login(PASSWORD, { "x-forwarded-for": "203.0.113.7, 10.0.0.1" })).status).toBe(429);
    } finally {
      delete process.env.TRUST_PROXY_HOPS;
    }
  });

  it("keys IPv6 clients by /64", () => {
    expect(clientKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8:1:2:bbbb:cccc:dddd:eeee")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientKey("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(clientKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(clientKey("192.0.2.1")).toBe("192.0.2.1");
    const limiter = new LoginLimiter();
    for (let i = 0; i < 5; i++) limiter.fail(`2001:db8:1:2::${i + 1}`, `p${i}`);
    expect(limiter.bannedMinutes("2001:db8:1:2:ffff::9")).toBe(15);
  });

  it("slows everyone down past the global budget, but never refuses", async () => {
    let t = 0;
    const limiter = new LoginLimiter(() => t);
    for (let i = 0; i < GLOBAL_MAX_FAILURES - 1; i++) limiter.fail(`10.${i >> 8}.${i & 255}.1`, `p${i}`);
    expect(limiter.overGlobalBudget()).toBe(false);
    // Claim failures don't count.
    limiter.fail("10.9.9.9", "claim:x", { global: false });
    expect(limiter.overGlobalBudget()).toBe(false);
    limiter.fail("10.9.9.10", "last");
    expect(limiter.overGlobalBudget()).toBe(true);
    expect(limiter.bannedMinutes("192.0.2.200")).toBe(0);
    t += BAN_MS + 1;
    expect(limiter.overGlobalBudget()).toBe(false);

    h = harness();
    const { limiter: real } = adminAuth(h.ctx);
    for (let i = 0; i < GLOBAL_MAX_FAILURES; i++) real.fail(`10.${i >> 8}.${i & 255}.1`, `p${i}`);
    let started = performance.now();
    const ok = await checkSecret(h.ctx, "192.0.2.200", "right", () => true, { slowdownMs: 150 });
    expect(ok.ok).toBe(true);
    expect(performance.now() - started).toBeGreaterThanOrEqual(140);
    started = performance.now();
    await checkSecret(h.ctx, "192.0.2.201", "token", () => false, { global: false, slowdownMs: 150 });
    expect(performance.now() - started).toBeLessThan(140);
  });

  it("bounds its memory", () => {
    const limiter = new LoginLimiter();
    for (let i = 0; i < MAX_ENTRIES + 50; i++) limiter.fail(`ip-${i}`, "x");
    expect(limiter.size).toBe(MAX_ENTRIES);
  });
});

describe("M3: body limits", () => {
  it("rejects oversized bodies before parsing", async () => {
    h = harness();
    const cookie = await h.claim();
    let res = await login("x".repeat(20_000));
    expect(res.status).toBe(413);
    expect((await json(res)).error.code).toBe("payload_too_large");
    res = await h.request("/api/settings", { method: "PATCH", headers: CSRF, cookie, json: { publicUrl: "x".repeat(2 * 1024 * 1024) } });
    expect(res.status).toBe(413);
    res = await login("x".repeat(2000));
    expect(res.status).toBe(400);
    expect((await json(res)).error.message).toMatch(/at most 1024/);
  });
});

describe("m5: master key guard", () => {
  it("refuses a missing or wrong key once secrets are stored", async () => {
    h = harness();
    const { config } = h.ctx;
    h.ctx.db.run(
      "INSERT INTO accounts (id, email, refresh_token_enc, created_at) VALUES ('acc_1', 'a@example.com', ?, ?)",
      h.ctx.crypto.encrypt("refresh-token"),
      new Date().toISOString(),
    );
    expect(() => assertMasterKeyUsable(config, "")).not.toThrow();
    const key = Buffer.from(readFileSync(config.masterKeyPath, "utf8").trim(), "base64");
    expect(key.length).toBe(32);
    expect(() => assertMasterKeyUsable(config, Buffer.alloc(32, 7).toString("base64"))).toThrow(/can't decrypt/);
    expect(() => assertMasterKeyUsable(config, key.toString("base64"))).not.toThrow();
    rmSync(config.masterKeyPath);
    expect(() => assertMasterKeyUsable(config, "")).toThrow(/no master key/);
    await expect(startServer({ config: { ...config, port: 0 } })).rejects.toThrow(/no master key/);
    expect(existsSync(config.masterKeyPath)).toBe(false);
  });

  it("allows a fresh data directory", () => {
    const config = testConfig();
    try {
      expect(() => assertMasterKeyUsable(config, "")).not.toThrow();
    } finally {
      rmSync(config.dataDir, { recursive: true, force: true });
    }
  });
});

describe("files", () => {
  it("creates the database owner-only", () => {
    h = harness();
    expect(statSync(h.ctx.config.dbPath).mode & 0o777).toBe(0o600);
    expect(statSync(h.ctx.config.dataDir).mode & 0o777).toBe(0o700);
  });
});

describe("instance lock", () => {
  it("refuses a second instance on the same data directory and replaces stale locks", async () => {
    const config = testConfig();
    const overrides = { google: fakeGoogle(), ingest: fakeIngest() };
    try {
      writeFileSync(lockPath(config.dataDir), JSON.stringify({ pid: 2 ** 22 + 12345, host: "0.0.0.0", port: 1, startedAt: "" }));
      const running = await startServer({ config, overrides });
      await expect(startServer({ config: { ...config, port: 0 }, overrides })).rejects.toThrow(/already running .*pid \d+, port \d+/);
      await running.close();
      expect(existsSync(lockPath(config.dataDir))).toBe(false);
      const lock = acquireInstanceLock(config);
      lock.release();
    } finally {
      rmSync(config.dataDir, { recursive: true, force: true });
    }
  });
});

describe("instance lock: pid reuse", () => {
  const lockWith = (dataDir: string, info: Record<string, unknown>) =>
    writeFileSync(lockPath(dataDir), JSON.stringify({ host: "0.0.0.0", port: 1, startedAt: "", ...info }));

  it("treats a lock naming our own pid as stale unless we hold it (containers are always pid 1)", () => {
    const config = testConfig();
    try {
      lockWith(config.dataDir, { pid: process.pid });
      expect(runningInstance(config.dataDir)).toBeNull();
      const lock = acquireInstanceLock(config);
      expect(runningInstance(config.dataDir)?.pid).toBe(process.pid);
      expect(() => acquireInstanceLock(config)).toThrow(/already running/);
      lock.release();
    } finally {
      rmSync(config.dataDir, { recursive: true, force: true });
    }
  });

  it("treats a live foreign pid from another boot or with another start time as stale", () => {
    const config = testConfig();
    const pid = process.ppid;
    try {
      lockWith(config.dataDir, { pid, bootId: "00000000-0000-0000-0000-000000000000" });
      if (bootId()) expect(runningInstance(config.dataDir)).toBeNull();
      lockWith(config.dataDir, { pid, bootId: bootId(), processStart: "1" });
      if (processStartTime(pid)) expect(runningInstance(config.dataDir)).toBeNull();
      // The same process, same boot, same start time: really running.
      lockWith(config.dataDir, { pid, bootId: bootId(), processStart: processStartTime(pid) });
      expect(runningInstance(config.dataDir)?.pid).toBe(pid);
      expect(() => acquireInstanceLock(config)).toThrow(/already running/);
      lockWith(config.dataDir, { pid, bootId: "00000000-0000-0000-0000-000000000000" });
      if (bootId()) acquireInstanceLock(config).release();
    } finally {
      rmSync(config.dataDir, { recursive: true, force: true });
    }
  });
});

describe("sessions", () => {
  it("ends at the absolute lifetime even when used daily", () => {
    h = harness();
    let t = Date.parse("2026-01-01T00:00:00Z");
    const store = new SessionStore(h.ctx.db, () => t);
    const token = store.create();
    while (t < Date.parse("2026-01-01T00:00:00Z") + SESSION_MAX_AGE_MS - 2 * 86_400_000) {
      t += 86_400_000;
      expect(store.check(token).valid).toBe(true);
    }
    t += 3 * 86_400_000;
    expect(store.check(token).valid).toBe(false);
    expect(SESSION_TTL_MS).toBeLessThan(SESSION_MAX_AGE_MS);
  });
});
