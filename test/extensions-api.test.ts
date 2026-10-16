import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAdminChannel } from "../server/connections-cli/admin.ts";
import { ScriptedPrompter } from "../server/connections-cli/prompt.ts";
import { addExtension, ExtensionsApi, listExtensions, registerExtensionCommands, removeExtension, updateExtension } from "../server/extensions/cli.ts";
import { computeIntegrity } from "../server/extensions/integrity.ts";
import { extensionStore } from "../server/extensions/store.ts";
import { entriesFromDir, type FakeGithub, fakeSha, manifest, startFakeGithub, writeTree } from "./extension-fakes.ts";
import { CSRF, type Harness, harness, json } from "./platform-helpers.ts";

let gh: FakeGithub;
let h: Harness;
let work: string;
let usedBy: Record<string, string[]>;
let cookie: string;

const unlock = (dir: string) => {
  if (!existsSync(dir)) return;
  chmodSync(dir, 0o755);
  for (const n of readdirSync(dir)) if (statSync(join(dir, n)).isDirectory()) unlock(join(dir, n));
};

beforeEach(async () => {
  gh = await startFakeGithub();
  h = harness();
  work = mkdtempSync(join(tmpdir(), "xaq-ext-api-"));
  usedBy = {};
  cookie = await h.claim();
  extensionStore(h.ctx, { urls: gh.urls }).setHooks({ usedBy: (n) => usedBy[n] ?? [] });
});

afterEach(async () => {
  await gh.close();
  unlock(join(h.ctx.config.dataDir, "extensions"));
  await h.dispose();
  rmSync(work, { recursive: true, force: true });
});

function publish(name: string, seed = "1", version = "1.0.0") {
  const dir = writeTree(join(work, `${name}-${seed}`), { "xaq-extension.json": manifest(name, { version }), "notes.txt": seed });
  const sha = fakeSha(`${name}-${seed}`);
  gh.commit("wynn-dev", "xaq-extensions", "main", sha, entriesFromDir(dir, `extensions/${name}`));
  const integrity = computeIntegrity(dir);
  gh.index.extensions = [...gh.index.extensions.filter((e) => (e as { name: string }).name !== name), { name, displayName: name, description: "d", kind: "remote", version, path: `extensions/${name}`, commit: sha, integrity }];
  return { sha, integrity };
}

function thirdParty(name: string) {
  const dir = writeTree(join(work, `tp-${name}`), { "xaq-extension.json": manifest(name, { kind: "code", remote: undefined, code: { entry: "s.mjs", network: ["api.tp.example"] } }), "s.mjs": "" });
  gh.commit("someone", "tp", "main", fakeSha(`tp-${name}`), entriesFromDir(dir, name));
  return `https://github.com/someone/tp/tree/main/${name}`;
}

const req = (path: string, init: RequestInit & { json?: unknown } = {}) => h.request(path, { ...init, cookie, headers: CSRF });

describe("/api/extensions", () => {
  it("is admin-only: no session is 401, no CSRF header is 403", async () => {
    expect((await h.request("/api/extensions")).status).toBe(401);
    expect((await h.request("/api/extensions/registry")).status).toBe(401);
    expect((await h.request("/api/extensions", { method: "POST", headers: CSRF, json: { source: "demo" } })).status).toBe(401);
    expect((await h.request("/api/extensions/demo", { method: "DELETE", headers: CSRF })).status).toBe(401);
    expect((await h.request("/api/extensions", { method: "POST", cookie, json: { source: "demo" } })).status).toBe(403);
    expect((await h.request("/api/extensions", { cookie })).status).toBe(200);
  });

  it("lists, browses the registry, installs, updates with the diff, verifies and removes", async () => {
    const v1 = publish("demo");
    expect(await json(await req("/api/extensions"))).toEqual([]);
    const registry = await json(await req("/api/extensions/registry"));
    expect(registry).toEqual([expect.objectContaining({ name: "demo", version: "1.0.0", commit: v1.sha, installed: null })]);

    const resolved = await json(await req("/api/extensions/resolve", { method: "POST", json: { source: "demo" } }));
    expect(resolved).toMatchObject({ candidate: { name: "demo", official: true, commit: v1.sha }, warnings: [], installed: null });

    const installed = await req("/api/extensions", { method: "POST", json: { source: "demo" } });
    expect(installed.status).toBe(200);
    expect(await json(installed)).toMatchObject({ name: "demo", version: "1.0.0", official: true, usedBy: [], integrity: v1.integrity });

    const v2 = publish("demo", "2", "2.0.0");
    const preview = await json(await req("/api/extensions/demo/update", { method: "POST", json: {} }));
    expect(preview).toMatchObject({ installed: false, update: { from: { version: "1.0.0", commit: v1.sha }, to: { version: "2.0.0", commit: v2.sha }, warnings: [] } });
    expect((await json(await req("/api/extensions/demo"))).version).toBe("1.0.0");
    const applied = await json(await req("/api/extensions/demo/update", { method: "POST", json: { confirm: true, expectIntegrity: v2.integrity } }));
    expect(applied).toMatchObject({ installed: true, update: { to: { version: "2.0.0" } } });
    expect(await json(await req("/api/extensions/demo/verify", { method: "POST" }))).toEqual({ ok: true });

    // B2's usedBy returns connection ids; people see slugs.
    const t = new Date().toISOString();
    h.ctx.db.run("INSERT INTO connections (id, kind, preset, slug, name, url, created_at, updated_at) VALUES ('con_nw', 'remote_http', 'demo', 'notion-work', 'Work', 'https://x.example/mcp', ?, ?)", t, t);
    usedBy.demo = ["con_nw"];
    const refused = await req("/api/extensions/demo", { method: "DELETE" });
    expect(refused.status).toBe(409);
    const refusedBody = await json(refused);
    expect(refusedBody).toMatchObject({ error: { code: "in_use" }, usedBy: ["notion-work"] });
    expect(refusedBody.error.message).toMatch(/used by notion-work\./);
    expect((await json(await req("/api/extensions")))[0].usedBy).toEqual(["notion-work"]);
    expect((await req("/api/extensions/demo?force=true", { method: "DELETE" })).status).toBe(204);
    expect(await json(await req("/api/extensions"))).toEqual([]);
    expect((await req("/api/extensions/demo")).status).toBe(404);

    const actions = h.ctx.audit.list().items.map((e) => e.action).filter((a) => a.startsWith("extension."));
    expect(actions).toEqual(["extension.remove", "extension.update", "extension.install"]);
  });

  it("third-party: 409 with the warning until confirmed", async () => {
    const url = thirdParty("tpx");
    const refused = await req("/api/extensions", { method: "POST", json: { source: url } });
    expect(refused.status).toBe(409);
    const body = await json(refused);
    expect(body.error.code).toBe("third_party_unconfirmed");
    expect(body.warnings.join(" ")).toMatch(/runs on your machine with network access.*api\.tp\.example/s);
    const ok = await req("/api/extensions", { method: "POST", json: { source: url, confirmThirdParty: true, expectIntegrity: body.candidate.integrity } });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toMatchObject({ name: "tpx", official: false, network: ["api.tp.example"] });
    expect((await req("/api/extensions", { method: "POST", json: { source: "Bad Source" } })).status).toBe(400);
  });

  it("refuses relative and ~ paths: the daemon's cwd isn't the user's", async () => {
    for (const source of ["./ext", "../ext", "~/ext"]) {
      for (const path of ["/api/extensions/resolve", "/api/extensions"]) {
        const res = await req(path, { method: "POST", json: { source } });
        expect(res.status, `${path} ${source}`).toBe(400);
        expect((await json(res)).error.message).toBe("Use an absolute path to a directory on xaq's machine.");
      }
    }
  });

  it("a third-party extension can't take an official name", async () => {
    const dir = writeTree(join(work, "fake-notion"), { "xaq-extension.json": manifest("notion") });
    const res = await req("/api/extensions/resolve", { method: "POST", json: { source: dir } });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("official_name");
  });
});

describe("xaq ext (CLI)", () => {
  const channels: { close(): void }[] = [];
  afterEach(() => {
    while (channels.length) channels.pop()!.close();
  });

  function cli(answers: string[] = [], yes = false) {
    const channel = openAdminChannel({
      dataDir: h.ctx.config.dataDir,
      instance: { pid: 1, host: "127.0.0.1", port: 8425, startedAt: "" },
      fetch: ((url: string, init: RequestInit) => {
        const u = new URL(url);
        return h.request(u.pathname + u.search, init);
      }) as typeof fetch,
    });
    channels.push(channel);
    const prompter = new ScriptedPrompter(answers, yes);
    return { deps: { api: new ExtensionsApi(channel), prompter }, prompter };
  }

  it("add (official), list, update (shows old and new, needs confirmation), remove", async () => {
    const v1 = publish("demo");
    const { deps, prompter } = cli(["n", "y", "y"]);
    expect(await addExtension("demo", deps)).toBe(0);
    expect(prompter.text).toMatch(/Installed demo 1\.0\.0/);
    expect(prompter.asked).toEqual([]); // official: no question

    expect(await listExtensions(deps)).toBe(0);
    expect(prompter.text).toMatch(new RegExp(`demo\\s+1\\.0\\.0\\s+${v1.sha.slice(0, 12)}\\s+official\\s+-\\s+demo`));

    const v2 = publish("demo", "2", "1.2.0");
    // Declined: nothing changes.
    expect(await updateExtension("demo", deps)).toBe(0);
    expect(prompter.text).toMatch(/version\s+1\.0\.0\s+→\s+1\.2\.0/);
    expect(prompter.text).toContain(`${v1.sha.slice(0, 12)}  →  ${v2.sha.slice(0, 12)}`);
    expect(prompter.text).toContain(`${v1.integrity}  →  ${v2.integrity}`);
    expect(prompter.text).toMatch(/Nothing was changed/);
    expect(extensionStore(h.ctx).get("demo")?.version).toBe("1.0.0");
    // Confirmed.
    expect(await updateExtension("demo", deps)).toBe(0);
    expect(extensionStore(h.ctx).get("demo")?.version).toBe("1.2.0");

    usedBy.demo = ["notion-work"];
    expect(await removeExtension("demo", {}, deps)).toBe(1);
    expect(prompter.text).toMatch(/used by notion-work/);
    expect(extensionStore(h.ctx).get("demo")).not.toBeNull();
    expect(await removeExtension("demo", { force: true }, deps)).toBe(0);
    expect(prompter.asked.at(-1)).toMatch(/Remove the extension demo and disable notion-work\?/);
    expect(extensionStore(h.ctx).get("demo")).toBeNull();
  });

  it("add (third-party) prints the warning and needs a yes; --yes installs", async () => {
    const url = thirdParty("tpcli");
    const declined = cli(["n"]);
    expect(await addExtension(url, declined.deps)).toBe(0);
    expect(declined.prompter.text).toMatch(/third-party/);
    expect(declined.prompter.text).toMatch(/This code runs on your machine with network access/);
    expect(declined.prompter.text).toMatch(/Declared network hosts: api\.tp\.example/);
    expect(declined.prompter.asked.join("\n")).toMatch(/Install the third-party extension tpcli\?/);
    expect(declined.prompter.text).toMatch(/Nothing was installed/);
    expect(extensionStore(h.ctx).get("tpcli")).toBeNull();

    const yes = cli([], true);
    expect(await addExtension(url, yes.deps)).toBe(0);
    expect(yes.prompter.text).toMatch(/This code runs on your machine/);
    expect(extensionStore(h.ctx).get("tpcli")).toMatchObject({ official: false });
  });

  it("registers xaq ext add | list | update | remove, with --yes and --force", async () => {
    const { Command } = await import("commander");
    const program = new Command("xaq");
    registerExtensionCommands(program);
    const ext = program.commands.find((c) => c.name() === "ext")!;
    const sub = Object.fromEntries(ext.commands.map((c) => [c.name(), c.options.map((o) => o.long)]));
    expect(Object.keys(sub)).toEqual(["add", "list", "update", "remove"]);
    expect(sub.add).toContain("--yes");
    expect(sub.update).toContain("--yes");
    expect(sub.remove).toEqual(expect.arrayContaining(["--force", "--yes", "--data"]));
  });

  it("add ./dir resolves the path in the CLI's cwd, not the daemon's", async () => {
    const cliCwd = join(work, "elsewhere");
    writeTree(join(cliCwd, "mine"), { "xaq-extension.json": manifest("mine") });
    expect(process.cwd()).not.toBe(cliCwd); // the "daemon" (this process) runs somewhere else
    const { deps, prompter } = cli([], true);
    expect(await addExtension("./mine", { ...deps, cwd: cliCwd })).toBe(0);
    expect(prompter.text).toContain(`Fetching ${join(cliCwd, "mine")}`);
    expect(extensionStore(h.ctx).get("mine")).toMatchObject({ source: join(cliCwd, "mine"), official: false });
  });

  it("update says when it's up to date; list says when there's nothing", async () => {
    publish("demo");
    const { deps, prompter } = cli();
    expect(await listExtensions(deps)).toBe(0);
    expect(prompter.text).toMatch(/No extensions installed/);
    await addExtension("demo", deps);
    expect(await updateExtension("demo", deps)).toBe(0);
    expect(prompter.text).toMatch(/demo is up to date/);
    await expect(updateExtension("nope", deps)).rejects.toThrow(/isn't installed/);
    await expect(removeExtension("nope", {}, deps)).rejects.toThrow(/isn't installed/);
  });
});
