import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../server/db/index.ts";
import { computeIntegrity, integrityDirName } from "../server/extensions/integrity.ts";
import { parseSource } from "../server/extensions/sources.ts";
import { ExtensionError, SqliteExtensionStore } from "../server/extensions/store.ts";
import { entriesFromDir, type FakeGithub, fakeSha, manifest, startFakeGithub, type TarEntry, writeTree } from "./extension-fakes.ts";

let gh: FakeGithub;
let dataDir: string;
let work: string;
let db: Db;
const stores: SqliteExtensionStore[] = [];

beforeEach(async () => {
  gh = await startFakeGithub();
  dataDir = mkdtempSync(join(tmpdir(), "xaq-ext-data-"));
  work = mkdtempSync(join(tmpdir(), "xaq-ext-src-"));
  db = new Db(":memory:");
});

/** Makes everything writable again so the temp dirs can be removed. */
const unlock = (dir: string) => {
  if (!existsSync(dir)) return;
  chmodSync(dir, 0o755);
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) unlock(p);
  }
};

afterEach(async () => {
  stores.length = 0;
  db.close();
  await gh.close();
  unlock(dataDir);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

const newStore = (limits = {}) => {
  const s = new SqliteExtensionStore({ db, dataDir, urls: gh.urls, limits });
  stores.push(s);
  return s;
};

/** An extension directory in `work`, and its integrity. */
function extDir(name: string, files: Record<string, string> = {}, sub = name): { dir: string; integrity: string } {
  const dir = writeTree(join(work, sub), { "xaq-extension.json": manifest(name), ...files });
  return { dir, integrity: computeIntegrity(dir) };
}

/** Publishes `name` in the fake official repo at a new commit and lists it in index.json. */
function publishOfficial(name: string, files: Record<string, string> = {}, opts: { version?: string; seed?: string; integrity?: string } = {}) {
  const content = { ...files, "xaq-extension.json": manifest(name, opts.version ? { version: opts.version } : {}) };
  const { dir, integrity } = extDir(name, content, `official-${name}-${opts.seed ?? "1"}`);
  const sha = fakeSha(`${name}-${opts.seed ?? "1"}`);
  gh.commit("wynn-dev", "xaq-extensions", "main", sha, entriesFromDir(dir, `extensions/${name}`));
  const entry = { name, displayName: name, description: "", kind: "remote", version: opts.version ?? "1.0.0", path: `extensions/${name}`, commit: sha, integrity: opts.integrity ?? integrity };
  gh.index.extensions = [...gh.index.extensions.filter((e) => (e as { name: string }).name !== name), entry];
  return { sha, integrity, entry };
}

const code = (err: unknown) => (err as ExtensionError).code;
const tree = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? [`${n}/`, ...tree(p).map((c) => `${n}/${c}`)] : [n];
  });

describe("sources", () => {
  it("parses registry names, GitHub URLs, git URLs and paths", () => {
    expect(parseSource("notion")).toEqual({ type: "registry", name: "notion" });
    expect(parseSource("https://github.com/a/b")).toEqual({ type: "github", owner: "a", repo: "b", tree: [] });
    expect(parseSource("https://github.com/a/b.git")).toEqual({ type: "github", owner: "a", repo: "b", tree: [] });
    expect(parseSource("https://github.com/a/b/tree/feat/x/extensions/y")).toEqual({ type: "github", owner: "a", repo: "b", tree: ["feat", "x", "extensions", "y"] });
    expect(parseSource("https://git.example.com/a/b.git#v1:ext/y")).toEqual({ type: "git", url: "https://git.example.com/a/b.git", ref: "v1", path: "ext/y" });
    expect(parseSource("git@example.com:a/b.git")).toEqual({ type: "git", url: "git@example.com:a/b.git", ref: null, path: "" });
    expect(parseSource("./thing", "/base")).toEqual({ type: "local", path: "/base/thing" });
    expect(parseSource("/abs/thing")).toEqual({ type: "local", path: "/abs/thing" });
    expect(() => parseSource("Not A Name")).toThrow(/write a directory as/);
    expect(() => parseSource("https://github.com/a/b/tree/main/../../x")).toThrow(/bad path/);
    expect(() => parseSource("ext::sh -c evil")).toThrow();
    expect(() => parseSource("https://git.example.com/a.git#--upload-pack=x")).toThrow(/ref/);
  });
});

describe("the extension store", () => {
  it("installs an official extension from the registry: pinned, atomic, read-only, under <dataDir>/extensions only", async () => {
    const { sha, integrity } = publishOfficial("demo", { "README.md": "hi" });
    writeFileSync(join(dataDir, "someone-elses-file"), "keep");
    const store = newStore();
    const before = readdirSync(dataDir).sort();
    const ext = await store.install("demo", { confirmThirdParty: false });
    expect(ext).toMatchObject({ name: "demo", kind: "remote", version: "1.0.0", source: "demo", commit: sha, integrity, official: true });
    expect(ext.installDir).toBe(join(dataDir, "extensions", "demo", integrityDirName(integrity)));
    expect(readdirSync(dataDir).sort()).toEqual([...before, "extensions"].sort());
    expect(tree(join(dataDir, "extensions"))).toEqual([".tmp/", "demo/", `demo/${integrityDirName(integrity)}/`, `demo/${integrityDirName(integrity)}/README.md`, `demo/${integrityDirName(integrity)}/xaq-extension.json`]);
    // chmod -R a-w
    for (const p of [ext.installDir, join(ext.installDir, "README.md")]) expect(statSync(p).mode & 0o222).toBe(0);
    expect(store.list()).toEqual([ext]);
    expect(store.get("demo")).toEqual(ext);
    expect(store.verify("demo")).toBe(true);
    // The same content again is a no-op.
    expect(await store.install("demo", { confirmThirdParty: false })).toEqual(ext);
  });

  it("refuses a registry entry whose files don't match its integrity", async () => {
    publishOfficial("demo", {}, { integrity: `sha256-${Buffer.alloc(32, 7).toString("base64")}` });
    const err = await newStore().install("demo", { confirmThirdParty: false }).catch((e: unknown) => e);
    expect(code(err)).toBe("integrity_mismatch");
    expect(readdirSync(join(dataDir, "extensions", ".tmp"))).toEqual([]);
    expect(existsSync(join(dataDir, "extensions", "demo"))).toBe(false);
  });

  it("a pinned install refuses a mismatched integrity and installs a matching one", async () => {
    const { sha, integrity } = publishOfficial("pinned");
    const store = newStore();
    const wrong = `sha256-${Buffer.alloc(32, 1).toString("base64")}`;
    const err = await store.installPinned({ name: "pinned", commit: sha, integrity: wrong }).catch((e: unknown) => e);
    expect(code(err)).toBe("integrity_mismatch");
    expect((err as Error).message).toMatch(/Refusing to install/);
    expect(store.get("pinned")).toBeNull();
    const ext = await store.installPinned({ name: "pinned", commit: sha, integrity });
    expect(ext).toMatchObject({ official: true, commit: sha, integrity, source: "pinned" });
    // The pin's commit is fetched directly: no API call to resolve a ref.
    expect(gh.requests.filter((p) => p.startsWith("/api/"))).toEqual([]);
  });

  it("verify detects tampering: a changed, added or removed file", async () => {
    publishOfficial("demo", { "a.txt": "a" });
    const store = newStore();
    const ext = await store.install("demo", { confirmThirdParty: false });
    expect(store.verify("demo")).toBe(true);
    chmodSync(ext.installDir, 0o755);
    chmodSync(join(ext.installDir, "a.txt"), 0o644);
    writeFileSync(join(ext.installDir, "a.txt"), "tampered");
    expect(store.verify("demo")).toBe(false);
    writeFileSync(join(ext.installDir, "a.txt"), "a");
    chmodSync(join(ext.installDir, "a.txt"), 0o444);
    expect(store.verify("demo")).toBe(true);
    writeFileSync(join(ext.installDir, "extra.mjs"), "evil()", { mode: 0o444 });
    expect(store.verify("demo")).toBe(false);
    rmSync(join(ext.installDir, "extra.mjs"));
    rmSync(join(ext.installDir, "a.txt"));
    expect(store.verify("demo")).toBe(false);
    expect(store.verify("not-installed")).toBe(false);
  });

  it("third-party: a GitHub URL needs confirmation and gets the warning (kind, network hosts, runs on your machine)", async () => {
    const files = { "xaq-extension.json": manifest("whoopish", { kind: "code", remote: undefined, code: { entry: "dist/server.mjs", network: ["api.example.com", "auth.example.com"] } }), "!dist/server.mjs": "export {}" };
    const dir = writeTree(join(work, "whoopish"), files);
    const sha = fakeSha("tp");
    gh.commit("someone", "exts", "feat/x", sha, entriesFromDir(dir, "pkg/whoopish"));
    const store = newStore();
    const url = "https://github.com/someone/exts/tree/feat/x/pkg/whoopish";
    const { candidate, warnings } = await store.resolve(url);
    expect(candidate).toMatchObject({ name: "whoopish", kind: "code", official: false, commit: sha, source: url });
    expect(warnings.join("\n")).toMatch(/third-party/);
    expect(warnings.join("\n")).toMatch(/This code runs on your machine with network access/);
    expect(warnings.join("\n")).toMatch(/api\.example\.com, auth\.example\.com/);
    expect(store.list()).toEqual([]);

    const err = await store.install(url, { confirmThirdParty: false }).catch((e: unknown) => e);
    expect(code(err)).toBe("third_party_unconfirmed");
    expect((err as ExtensionError).detail?.warnings).toEqual(warnings);
    expect(store.list()).toEqual([]);

    const changed = await store.install(url, { confirmThirdParty: true, expectIntegrity: `sha256-${Buffer.alloc(32).toString("base64")}` }).catch((e: unknown) => e);
    expect(code(changed)).toBe("changed");

    const ext = await store.install(url, { confirmThirdParty: true, expectIntegrity: candidate.integrity });
    expect(ext).toMatchObject({ name: "whoopish", official: false, commit: sha });
    expect(statSync(join(ext.installDir, "dist", "server.mjs")).mode & 0o777).toBe(0o555);
    // "feat" alone isn't a ref; "feat/x" is: the path is what follows.
    expect(gh.requests.filter((p) => p.startsWith("/api/"))).toContain("/api/repos/someone/exts/commits/feat");
  });

  it("the official repository at the indexed commit is official, even by URL", async () => {
    const { sha } = publishOfficial("demo");
    const { candidate, warnings } = await newStore().resolve(`https://github.com/wynn-dev/xaq-extensions/tree/${sha}/extensions/demo`);
    expect(candidate).toMatchObject({ official: true, source: "demo" });
    expect(warnings).toEqual([]);
  });

  it("says plainly when GitHub's rate limit is used up", async () => {
    gh.rateLimited = true;
    const err = await newStore().resolve("https://github.com/someone/exts").catch((e: unknown) => e);
    expect(code(err)).toBe("rate_limited");
    expect((err as Error).message).toMatch(/rate limit .* Try again after 13:45 UTC/);
  });

  it("installs from a local directory (no commit) and from a git URL (git CLI, ref and path)", async () => {
    const { dir, integrity } = extDir("localext", { "x.txt": "x" });
    writeTree(join(dir, ".git"), { HEAD: "ref: refs/heads/main" });
    const store = newStore();
    const local = await store.install(dir, { confirmThirdParty: true });
    expect(local).toMatchObject({ name: "localext", commit: null, source: dir, official: false, integrity });

    const repo = join(work, "gitrepo");
    writeTree(join(repo, "exts", "gitext"), { "xaq-extension.json": manifest("gitext"), "!run.sh": "echo hi" });
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { stdio: "pipe" }).toString().trim();
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "one");
    git("tag", "v1");
    const sha = git("rev-parse", "HEAD");
    const ext = await store.install(`file://${repo}#v1:exts/gitext`, { confirmThirdParty: true });
    expect(ext).toMatchObject({ name: "gitext", commit: sha, official: false, source: `file://${repo}#v1:exts/gitext` });
    expect(statSync(join(ext.installDir, "run.sh")).mode & 0o111).not.toBe(0);
    expect(readdirSync(join(dataDir, "extensions", ".tmp"))).toEqual([]);
  });

  it("refuses an unsafe tarball (symlink, `..`, oversize) and leaves nothing behind", async () => {
    const store = newStore({ maxBytes: 4096 });
    const base: TarEntry[] = [{ name: "e/xaq-extension.json", data: manifest("bad") }];
    const cases: [string, TarEntry[], RegExp][] = [
      ["symlink", [...base, { name: "e/link", type: "2", linkname: "/etc/passwd" }], /symlink/],
      ["dotdot", [...base, { name: "e/../../../outside", data: "x" }], /\.\./],
      ["oversize", [...base, { name: "e/big", data: Buffer.alloc(8192) }], /larger than/],
    ];
    for (const [i, [label, entries, msg]] of cases.entries()) {
      gh.commit("someone", "bad", label, fakeSha(`bad${i}`), entries);
      const err = await store.resolve(`https://github.com/someone/bad/tree/${label}/e`).catch((e: unknown) => e);
      expect(code(err), label).toBe("unsafe");
      expect((err as Error).message, label).toMatch(msg);
    }
    expect(readdirSync(join(dataDir, "extensions", ".tmp"))).toEqual([]);
    expect(existsSync(join(dataDir, "outside"))).toBe(false);
  });

  it("needs a manifest whose name is the registry's", async () => {
    const { dir } = extDir("other", {}, "mismatch");
    gh.commit("wynn-dev", "xaq-extensions", "main", fakeSha("mm"), entriesFromDir(dir, "extensions/claimed"));
    gh.index.extensions = [{ name: "claimed", displayName: "", description: "", kind: "remote", version: "1.0.0", path: "extensions/claimed", commit: fakeSha("mm"), integrity: computeIntegrity(dir) }];
    const err = await newStore().install("claimed", { confirmThirdParty: false }).catch((e: unknown) => e);
    expect(code(err)).toBe("invalid");
  });

  it("updates only on confirmation: shows old and new, nothing changes on its own", async () => {
    const v1 = publishOfficial("demo", { "a.txt": "1" });
    const store = newStore();
    const installed = await store.install("demo", { confirmThirdParty: false });
    expect(await store.update("demo", { confirm: false })).toBeNull();

    const v2 = publishOfficial("demo", { "a.txt": "2" }, { version: "1.1.0", seed: "2" });
    // The registry moved; the install didn't.
    expect(store.get("demo")).toMatchObject({ commit: v1.sha, integrity: v1.integrity, version: "1.0.0" });
    expect(store.verify("demo")).toBe(true);

    const preview = await store.update("demo", { confirm: false });
    expect(preview?.from).toMatchObject({ version: "1.0.0", commit: v1.sha, integrity: v1.integrity });
    expect(preview?.to).toMatchObject({ version: "1.1.0", commit: v2.sha, integrity: v2.integrity });
    expect(store.get("demo")).toEqual(installed);

    const stale = await store.update("demo", { confirm: true, expectIntegrity: v1.integrity }).catch((e: unknown) => e);
    expect(code(stale)).toBe("changed");
    expect(store.get("demo")).toEqual(installed);

    const changes: string[] = [];
    store.setHooks({ onChange: ({ from, to }) => changes.push(`${from?.version}->${to?.version}`) });
    const done = await store.update("demo", { confirm: true, expectIntegrity: v2.integrity });
    expect(done?.to).toMatchObject({ version: "1.1.0", commit: v2.sha });
    expect(store.get("demo")).toMatchObject({ version: "1.1.0", commit: v2.sha, integrity: v2.integrity });
    expect(changes).toEqual(["1.0.0->1.1.0"]);
    // The old files are gone; only the new version's directory is left.
    expect(readdirSync(join(dataDir, "extensions", "demo"))).toEqual([integrityDirName(v2.integrity)]);
    // A third-party install by directory updates from the directory.
    const { dir } = extDir("devext");
    await store.install(dir, { confirmThirdParty: true });
    expect(await store.update("devext", { confirm: false })).toBeNull();
    writeFileSync(join(dir, "new.txt"), "n");
    expect((await store.update("devext", { confirm: false }))?.to.integrity).toBe(computeIntegrity(dir));
    await expect(store.update("missing", { confirm: false })).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses an install over a different installed version (that's an update)", async () => {
    publishOfficial("demo");
    const store = newStore();
    await store.install("demo", { confirmThirdParty: false });
    const { dir } = extDir("demo", { "x.txt": "other" }, "other-demo");
    const err = await store.install(dir, { confirmThirdParty: true }).catch((e: unknown) => e);
    expect(code(err)).toBe("already_installed");
  });

  it("remove is refused while connections use it, unless forced (which tells B2 to disable them)", async () => {
    publishOfficial("demo");
    const store = newStore();
    await store.install("demo", { confirmThirdParty: false });
    const removed: { force: boolean; usedBy: string[] }[] = [];
    store.setHooks({ usedBy: (n) => (n === "demo" ? ["notion-work", "notion-personal"] : []), onRemove: (_e, o) => removed.push(o) });
    const err = (() => {
      try {
        store.remove("demo", { force: false });
      } catch (e) {
        return e;
      }
    })();
    expect(code(err)).toBe("in_use");
    expect((err as ExtensionError).detail?.usedBy).toEqual(["notion-work", "notion-personal"]);
    expect(store.get("demo")).not.toBeNull();
    expect(removed).toEqual([]);

    store.remove("demo", { force: true });
    expect(removed).toEqual([{ force: true, usedBy: ["notion-work", "notion-personal"] }]);
    expect(store.get("demo")).toBeNull();
    expect(existsSync(join(dataDir, "extensions", "demo"))).toBe(false);
    expect(() => store.remove("demo", { force: false })).toThrow(/isn't installed/);
  });

  it("clears temp directories left by a crash, and nothing else", () => {
    writeTree(join(dataDir, "extensions", ".tmp", "deadbeef", "x"), { "a.txt": "partial" });
    writeTree(join(dataDir, "extensions", "kept"), { "a.txt": "kept" });
    newStore();
    expect(readdirSync(join(dataDir, "extensions")).sort()).toEqual(["kept"]);
  });
});
