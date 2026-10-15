import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startServer } from "../server/server.ts";
import { fakeGoogle, fakeIngest, json } from "./platform-helpers.ts";
import { testConfig } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "..");
const cli = (...args: string[]) =>
  execFileSync(process.execPath, ["--import", "tsx", join(ROOT, "server/cli.ts"), ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });

describe("startServer", () => {
  it("listens on a free port, serves requests and closes cleanly", async () => {
    const config = testConfig();
    const running = await startServer({ config, overrides: { google: fakeGoogle(), ingest: fakeIngest() } });
    try {
      expect(config.port).toBeGreaterThan(0);
      expect(running.url).toBe(`http://127.0.0.1:${config.port}`);
      const res = await fetch(`${running.url}/api/health`);
      expect(res.status).toBe(200);
      expect((await json(res)).version).toBe("0.0.0-test");
      expect(running.ctx.settings.publicUrl()).toBe(`http://localhost:${config.port}`);
    } finally {
      await running.close();
      await running.close();
      rmSync(config.dataDir, { recursive: true, force: true });
    }
  });

  it("reports a busy port in plain words", async () => {
    const first = testConfig();
    const running = await startServer({ config: first, overrides: { google: fakeGoogle(), ingest: fakeIngest() } });
    const second = testConfig({ port: first.port });
    try {
      await expect(startServer({ config: second })).rejects.toThrow(/already in use/);
    } finally {
      await running.close();
      rmSync(first.dataDir, { recursive: true, force: true });
      rmSync(second.dataDir, { recursive: true, force: true });
    }
  });
});

describe("cli", () => {
  it("prints the version and the skill, and installs it into a directory", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
    expect(cli("--version").trim()).toBe(pkg.version);
    expect(cli("skill", "print", "--url", "https://mail.example.com/")).toContain("https://mail.example.com/mcp");

    const dir = mkdtempSync(join(tmpdir(), "agentinbox-skills-"));
    try {
      cli("skill", "install", "--target", dir, "--url", "http://10.0.0.5:8425");
      expect(readFileSync(join(dir, "agentinbox", "SKILL.md"), "utf8")).toContain("http://10.0.0.5:8425/mcp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails without a stack trace on bad input", () => {
    try {
      cli("skill", "print", "--url", "nope");
      expect.unreachable();
    } catch (err) {
      const stderr = String((err as { stderr?: string }).stderr);
      expect(stderr).toContain('Invalid --url "nope"');
      expect(stderr).not.toMatch(/\n\s+at /);
    }
  });
});
