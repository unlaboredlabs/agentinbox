import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalListing, computeIntegrity, integrityDirName, integrityHex, IntegrityError, listExtensionFiles } from "../server/extensions/integrity.ts";
import { bufferChunks, readTar, UnsafeArchiveError, writeFiles } from "../server/extensions/tar.ts";
import { makeTar, type TarEntry } from "./extension-fakes.ts";

const VECTORS = join(import.meta.dirname, "fixtures", "extension-integrity");
const vectors = JSON.parse(readFileSync(join(VECTORS, "vectors.json"), "utf8")) as { vectors: { dir: string; integrity: string; listing: [string, string, string][] }[] };

const temps: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "xaq-ext-int-"));
  temps.push(d);
  return d;
};
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe("extension integrity", () => {
  it.each(vectors.vectors.map((v) => [v.dir, v] as const))("matches the shared test vector %s", (_name, v) => {
    const dir = join(VECTORS, v.dir);
    const listing = listExtensionFiles(dir);
    expect(listing.map((e) => [e.path, e.mode, e.sha256])).toEqual(v.listing);
    expect(computeIntegrity(dir)).toBe(v.integrity);
    expect(canonicalListing(listing)).toBe(v.listing.map(([p, m, h]) => `${p}\0${m}\0${h}\n`).join(""));
  });

  it("sorts by the UTF-8 bytes of the POSIX path (B < a-b < a.txt < a/b < z/a < é)", () => {
    expect(listExtensionFiles(join(VECTORS, "ordering")).map((e) => e.path)).toEqual(["B.txt", "a-b.txt", "a.txt", "a/b.txt", "z/a.txt", "é.txt"]);
  });

  it("changes when a file's content, mode or name changes", () => {
    const d = temp();
    writeFileSync(join(d, "a"), "1", { mode: 0o644 });
    const base = computeIntegrity(d);
    writeFileSync(join(d, "a"), "2");
    const content = computeIntegrity(d);
    expect(content).not.toBe(base);
    writeFileSync(join(d, "a"), "1", { mode: 0o755 });
    rmSync(join(d, "a"));
    writeFileSync(join(d, "a"), "1", { mode: 0o755 });
    expect(computeIntegrity(d)).not.toBe(base);
  });

  it("refuses symlinks, even to files inside the root", () => {
    const d = temp();
    writeFileSync(join(d, "a"), "1");
    symlinkSync("a", join(d, "link"));
    expect(() => computeIntegrity(d)).toThrow(IntegrityError);
    expect(() => computeIntegrity(d)).toThrow(/symlink/);
  });

  it("names the install directory by the digest's hex prefix", () => {
    const v = vectors.vectors[0]!;
    expect(integrityHex(v.integrity)).toMatch(/^[0-9a-f]{64}$/);
    expect(integrityDirName(v.integrity)).toBe(integrityHex(v.integrity).slice(0, 16));
    expect(() => integrityHex("sha256-nope")).toThrow(IntegrityError);
  });
});

describe("tarball safety", () => {
  const read = (entries: TarEntry[], subpath = "ext", limits = {}) => readTar(bufferChunks(makeTar(entries)), { strip: 1, subpath, limits });
  const ok: TarEntry[] = [
    { name: "repo-sha/", type: "5" },
    { name: "repo-sha/README.md", data: "top" },
    { name: "repo-sha/ext/", type: "5" },
    { name: "repo-sha/ext/xaq-extension.json", data: "{}" },
    { name: "repo-sha/ext/dist/server.mjs", data: "x", mode: 0o755 },
  ];

  it("writes only the extension's subpath, with its modes", async () => {
    const files = await read(ok);
    expect(files.map((f) => [f.path, f.exec])).toEqual([
      ["xaq-extension.json", false],
      ["dist/server.mjs", true],
    ]);
    const d = temp();
    writeFiles(d, files);
    expect(readdirSync(d).sort()).toEqual(["dist", "xaq-extension.json"]);
    expect(listExtensionFiles(d).map((e) => [e.path, e.mode])).toEqual([
      ["dist/server.mjs", "755"],
      ["xaq-extension.json", "644"],
    ]);
  });

  it("reads long paths from pax headers", async () => {
    const long = `repo-sha/ext/${"d/".repeat(60)}file.txt`;
    const files = await read([...ok, { name: long, data: "deep" }]);
    expect(files.find((f) => f.path.endsWith("file.txt"))?.path).toBe(`${"d/".repeat(60)}file.txt`);
  });

  it("refuses a symlink or a hard link in the extension", async () => {
    await expect(read([...ok, { name: "repo-sha/ext/link", type: "2", linkname: "/etc/passwd" }])).rejects.toThrow(/symlink/);
    await expect(read([...ok, { name: "repo-sha/ext/hard", type: "1", linkname: "repo-sha/README.md" }])).rejects.toThrow(/hard link/);
    await expect(read([...ok, { name: "repo-sha/ext/dev", type: "3" }])).rejects.toThrow(UnsafeArchiveError);
  });

  it("ignores a symlink elsewhere in the repository", async () => {
    expect((await read([...ok, { name: "repo-sha/other/link", type: "2", linkname: "../../etc" }])).length).toBe(2);
  });

  it("refuses `..` and absolute paths anywhere in the archive", async () => {
    await expect(read([...ok, { name: "repo-sha/ext/../../evil", data: "x" }])).rejects.toThrow(/\.\./);
    await expect(read([...ok, { name: "repo-sha/other/../../../evil", data: "x" }])).rejects.toThrow(/\.\./);
    await expect(read([...ok, { name: "/etc/evil", data: "x" }])).rejects.toThrow(/absolute/);
    await expect(readTar(bufferChunks(makeTar(ok)), { strip: 1, subpath: "../ext" })).rejects.toThrow(/\.\./);
  });

  it("refuses oversize extensions, too many files, oversize archives and duplicates", async () => {
    await expect(read([...ok, { name: "repo-sha/ext/big", data: Buffer.alloc(2048) }], "ext", { maxBytes: 1024 })).rejects.toThrow(/larger than/);
    await expect(read(ok, "ext", { maxFiles: 1 })).rejects.toThrow(/more than 1 files/);
    await expect(read([...ok, { name: "repo-sha/other/huge", data: Buffer.alloc(64 * 1024) }], "ext", { maxArchiveBytes: 32 * 1024 })).rejects.toThrow(/archive is larger/);
    await expect(read([...ok, { name: "repo-sha/ext/xaq-extension.json", data: "again" }])).rejects.toThrow(/twice/);
  });

  it("refuses a corrupt header, a truncated archive and a missing subpath", async () => {
    const tar = makeTar(ok);
    const bad = Buffer.from(tar);
    bad[0] = bad[0]! ^ 0xff;
    await expect(readTar(bufferChunks(bad), { strip: 1, subpath: "ext" })).rejects.toThrow(/checksum/);
    await expect(readTar(bufferChunks(tar.subarray(0, 512 * 4 + 100)), { strip: 1, subpath: "ext" })).rejects.toThrow(/truncated/);
    await expect(read(ok, "nope")).rejects.toThrow(/no extension at nope/);
  });

  it("handles an archive split into odd-sized chunks", async () => {
    const tar = makeTar(ok);
    async function* chunks() {
      for (let i = 0; i < tar.length; i += 7) yield tar.subarray(i, i + 7);
    }
    expect((await readTar(chunks(), { strip: 1, subpath: "ext" })).map((f) => f.path)).toEqual(["xaq-extension.json", "dist/server.mjs"]);
  });

  it("writeFiles never overwrites (a fresh directory only)", () => {
    const d = temp();
    mkdirSync(join(d, "dist"));
    writeFileSync(join(d, "dist", "server.mjs"), "old");
    expect(() => writeFiles(d, [{ path: "dist/server.mjs", exec: false, data: Buffer.from("new") }])).toThrow();
  });
});
