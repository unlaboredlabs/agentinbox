// brokerUpstreams turns on once for existing installs when the console ships (SettingsStore.brokerOnOnce), and a
// later deliberate "off" sticks.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { Db } from "../server/db/index.ts";
import { SettingsStore } from "../server/settings.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function install() {
  const dir = mkdtempSync(join(tmpdir(), "agentinbox-settings-"));
  dirs.push(dir);
  const path = join(dir, "db.sqlite");
  const config = loadConfig({ dataDir: dir, host: "127.0.0.1", port: 0 }, "0.0.0-test");
  // A fresh store per "process start" on the same database.
  const open = () => {
    const db = new Db(path);
    return { db, settings: new SettingsStore(db, createBus(), config) };
  };
  return { open };
}

describe("brokerUpstreams on by default", () => {
  it("is on for a fresh install", () => {
    const { open } = install();
    expect(open().settings.get().brokerUpstreams).toBe(true);
  });

  it("turns a stored false (saved before the console shipped) into true, exactly once", () => {
    const { open } = install();
    const before = open();
    before.db.run("INSERT INTO settings (key, value) VALUES ('settings', ?)", JSON.stringify({ retentionDays: 9, brokerUpstreams: false }));
    before.db.close();

    const upgraded = open();
    expect(upgraded.settings.get()).toMatchObject({ brokerUpstreams: true, retentionDays: 9 });
    expect(upgraded.settings.getState("broker.defaultOnApplied")).toEqual(expect.any(String));
    upgraded.db.close();
  });

  it("keeps a deliberate off after the upgrade, across restarts", () => {
    const { open } = install();
    const first = open();
    expect(first.settings.get().brokerUpstreams).toBe(true);
    first.settings.update({ brokerUpstreams: false });
    first.db.close();

    const restarted = open();
    expect(restarted.settings.get().brokerUpstreams).toBe(false);
    restarted.settings.update({ brokerUpstreams: true });
    expect(restarted.settings.get().brokerUpstreams).toBe(true);
    restarted.db.close();
  });
});
