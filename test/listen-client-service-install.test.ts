// `listen service install|uninstall` driven through the daemon's ServiceOps with fakes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dataDir, listenAppDir } from "../server/listen/paths.ts";
import { loadProfile, saveProfile } from "../server/listen/profile.ts";
import { installListenService, uninstallListenService } from "../server/listen/service.ts";
import type { ServiceOps } from "../server/service.ts";
import { FAKE_KEY, isolateXdg } from "./listen-client-fake.ts";

let env: ReturnType<typeof isolateXdg>;
beforeEach(() => {
  env = isolateXdg();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const p of ["default", "work"]) saveProfile(p, { url: "https://mail.example.com", apiKey: FAKE_KEY, agentId: "a", agentName: "n", consumer: p, exec: "cat > /dev/null" });
});
afterEach(() => {
  vi.restoreAllMocks();
  env.restore();
});

function fakeOps(failOn?: (cmd: string, args: string[]) => boolean): ServiceOps & { calls: string[] } {
  const calls: string[] = [];
  return {
    capture: () => "",
    calls,
    platform: "linux",
    root: false,
    uid: 1000,
    user: "me",
    exec(cmd, args) {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (failOn?.(cmd, args)) throw new Error(`Command failed: ${cmd} ${args.join(" ")}`);
    },
    stage: () => {
      throw new Error("the listener must not use the daemon's stage");
    },
    unitDir: () => join(env.root, "units"),
    waitReady: async () => true,
  };
}

let version = 0;
/** Fake npm install: writes a dist/cli.js tagged with an increasing version. */
const stage = (staging: string) => {
  mkdirSync(join(staging, "node_modules/agentinbox-cli/dist"), { recursive: true });
  writeFileSync(join(staging, "node_modules/agentinbox-cli/dist/cli.js"), `// v${++version}\n`);
  return staging;
};
const failingStage = () => {
  throw new Error("Installing agentinbox failed, so the existing service was left as it was. npm ERR!");
};
const installed = () => readFileSync(join(listenAppDir(), "node_modules/agentinbox-cli/dist/cli.js"), "utf8");
const unit = (p: string) => join(env.root, "units", `agentinbox-listen-${p}.service`);
const ok = async () => true;
const never = async () => false;

describe("listen service install", () => {
  it("first install that never starts rolls back to no service, no install, original settings", async () => {
    const ops = fakeOps();
    await expect(installListenService({ exec: "new-cmd" }, { ops, stage, waitStarted: never })).rejects.toThrow(/Rolled back to no service/);
    expect(existsSync(unit("default"))).toBe(false);
    expect(existsSync(listenAppDir())).toBe(false);
    expect(loadProfile().exec).toBe("cat > /dev/null");
    expect(ops.calls).toContain("systemctl --user disable --now agentinbox-listen-default");
  });

  it("a failed re-install (readiness timeout) restores the previous unit, install and settings, and restarts it", async () => {
    const ops = fakeOps();
    await installListenService({}, { ops, stage, waitStarted: ok });
    const before = { unit: readFileSync(unit("default"), "utf8"), app: installed() };
    ops.calls.length = 0;
    await expect(installListenService({ exec: "new-cmd", concurrency: 7 }, { ops, stage, waitStarted: never })).rejects.toThrow(/Rolled back to the previous install/);
    expect(readFileSync(unit("default"), "utf8")).toBe(before.unit);
    expect(installed()).toBe(before.app);
    expect(loadProfile()).toMatchObject({ exec: "cat > /dev/null" });
    expect(loadProfile().concurrency).toBeUndefined();
    expect(ops.calls.filter((c) => c === "systemctl --user restart agentinbox-listen-default")).toHaveLength(2); // new attempt, then the restored one
  });

  it("a failed npm install changes nothing (settings included)", async () => {
    const ops = fakeOps();
    await installListenService({}, { ops, stage, waitStarted: ok });
    const before = readFileSync(unit("default"), "utf8");
    await expect(installListenService({ exec: "new-cmd" }, { ops, stage: failingStage, waitStarted: ok })).rejects.toThrow(/left as it was/);
    expect(loadProfile().exec).toBe("cat > /dev/null");
    expect(readFileSync(unit("default"), "utf8")).toBe(before);
  });

  it("restarts the other profiles onto the new install, and keeps the shared install until the last one is removed", async () => {
    const ops = fakeOps();
    await installListenService({ profile: "work" }, { ops, stage, waitStarted: ok });
    ops.calls.length = 0;
    await installListenService({}, { ops, stage, waitStarted: ok });
    expect(ops.calls).toContain("systemctl --user try-restart agentinbox-listen-work");
    expect(ops.calls).not.toContain("systemctl --user try-restart agentinbox-listen-default");
    expect(installed()).toBe(`// v${version}\n`);

    uninstallListenService("default", true, { ops });
    expect(existsSync(unit("default"))).toBe(false);
    expect(existsSync(listenAppDir())).toBe(true); // "work" still runs from it
    uninstallListenService("work", true, { ops });
    expect(existsSync(listenAppDir())).toBe(false);
  });

  it("refuses a concurrent install and a directory that holds a daemon's database", async () => {
    const ops = fakeOps();
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(join(dataDir(), "install.lock"), JSON.stringify({ pid: process.ppid, startedAt: "earlier" }));
    await expect(installListenService({}, { ops, stage, waitStarted: ok })).rejects.toThrow(/Another listener service install is running/);
    writeFileSync(join(dataDir(), "install.lock"), JSON.stringify({ pid: 2 ** 22 + 4242, startedAt: "crashed" }));
    await installListenService({}, { ops, stage, waitStarted: ok }); // stale lock taken over
    expect(existsSync(join(dataDir(), "install.lock"))).toBe(false);

    writeFileSync(join(dataDir(), "agentinbox.db"), "");
    await expect(installListenService({}, { ops, stage, waitStarted: ok })).rejects.toThrow(/holds an agentinbox daemon's data/);
  });
});
