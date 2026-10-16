// Test fakes for extensions: a tar writer (including entries a real tool wouldn't write) and a fake GitHub
// (raw index.json, the commits API and codeload tarballs) on a local HTTP server. No real network.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { ExtensionUrls } from "../server/extensions/registry.ts";

export interface TarEntry {
  name: string;
  /** "0" file (default), "5" dir, "2" symlink, "1" hard link, "3" char device, "x" pax. */
  type?: string;
  data?: Buffer | string;
  mode?: number;
  linkname?: string;
}

function header(e: TarEntry, size: number): Buffer {
  const h = Buffer.alloc(512);
  const put = (s: string, off: number, len: number) => h.write(s, off, Math.min(len, Buffer.byteLength(s)), "utf8");
  const oct = (n: number, off: number, len: number) => put(n.toString(8).padStart(len - 1, "0") + "\0", off, len);
  put(e.name, 0, 100);
  oct(e.mode ?? (e.type === "5" ? 0o755 : 0o644), 100, 8);
  oct(0, 108, 8);
  oct(0, 116, 8);
  oct(size, 124, 12);
  oct(0, 136, 12);
  h.fill(0x20, 148, 156);
  put(e.type ?? "0", 156, 1);
  put(e.linkname ?? "", 157, 100);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

/** One pax record: `<len> <key>=<value>\n`. */
export function paxRecord(k: string, v: string): string {
  const body = ` ${k}=${v}\n`;
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len = String(len).length + body.length;
  return `${len}${body}`;
}

export function makeTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (let e of entries) {
    let data = e.data === undefined ? Buffer.alloc(0) : Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    if (e.name.length > 100 && e.type !== "x") {
      // A pax header carries the long path.
      const pax = Buffer.from(paxRecord("path", e.name));
      parts.push(header({ name: "PaxHeader", type: "x" }, pax.length), pax, Buffer.alloc((512 - (pax.length % 512)) % 512));
      e = { ...e, name: e.name.slice(-100) };
    }
    if (e.type && !["0", "x", "g"].includes(e.type)) data = Buffer.alloc(0);
    parts.push(header(e, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** Tar entries for every file under `dir`, at `prefix/…` (modes kept). */
export function entriesFromDir(dir: string, prefix: string): TarEntry[] {
  const out: TarEntry[] = [];
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs).sort()) {
      const p = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = statSync(p);
      if (st.isDirectory()) {
        out.push({ name: `${prefix}/${r}/`, type: "5" });
        walk(p, r);
      } else out.push({ name: `${prefix}/${r}`, data: readFileSync(p), mode: st.mode & 0o777 });
    }
  };
  walk(dir, "");
  return out;
}

/** Writes `files` (path → content; a leading "!" in the path marks it executable) under `dir`. */
export function writeTree(dir: string, files: Record<string, string>): string {
  for (const [raw, content] of Object.entries(files)) {
    const exec = raw.startsWith("!");
    const path = join(dir, exec ? raw.slice(1) : raw);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, { mode: exec ? 0o755 : 0o644 });
  }
  return dir;
}

export const manifest = (name: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema: 1,
    name,
    displayName: name[0]!.toUpperCase() + name.slice(1),
    version: "1.0.0",
    description: `The ${name} extension.`,
    kind: "remote",
    slug: name.slice(0, 24),
    remote: { url: `https://mcp.${name}.example/mcp`, auth: { type: "mcp_oauth" } },
    ...extra,
  });

export const fakeSha = (seed: string) => createHash("sha1").update(seed).digest("hex");

interface FakeRepo {
  refs: Record<string, string>;
  tarballs: Record<string, Buffer>;
}

export interface FakeGithub {
  urls: ExtensionUrls;
  /** Every request path, in order. */
  requests: string[];
  index: { schema: 1; extensions: unknown[] };
  /** Adds a commit to owner/repo: `ref` points at it; the tarball holds `entries` under `<repo>-<sha>/`. */
  commit(owner: string, repo: string, ref: string, sha: string, entries: TarEntry[]): void;
  /** The next API calls answer 403 with x-ratelimit-remaining: 0. */
  rateLimited: boolean;
  close(): Promise<void>;
}

export async function startFakeGithub(): Promise<FakeGithub> {
  const repos = new Map<string, FakeRepo>();
  const state: FakeGithub = {
    urls: { registry: "", githubApi: "", codeload: "" },
    requests: [],
    index: { schema: 1, extensions: [] },
    rateLimited: false,
    commit(owner, repo, ref, sha, entries) {
      const key = `${owner}/${repo}`;
      const r = repos.get(key) ?? { refs: {}, tarballs: {} };
      r.refs[ref] = sha;
      r.tarballs[sha] = gzipSync(makeTar([{ name: "pax_global_header", type: "g", data: paxRecord("comment", sha) }, { name: `${repo}-${sha}/`, type: "5" }, ...entries.map((e) => ({ ...e, name: `${repo}-${sha}/${e.name}` }))]));
      repos.set(key, r);
    },
    close: () => new Promise((ok) => server.close(() => ok())),
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    state.requests.push(url.pathname);
    if (url.pathname === "/raw/index.json") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state.index));
      return;
    }
    const api = /^\/api\/repos\/([^/]+)\/([^/]+)\/commits\/(.+)$/.exec(url.pathname);
    if (api) {
      if (state.rateLimited) {
        res.writeHead(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.UTC(2026, 9, 16, 13, 45) / 1000)) }).end('{"message":"API rate limit exceeded"}');
        return;
      }
      const repo = repos.get(`${api[1]}/${api[2]}`);
      const ref = decodeURIComponent(api[3]!);
      const sha = repo?.refs[ref];
      if (!sha) {
        res.writeHead(repo ? 422 : 404).end('{"message":"No commit found"}');
        return;
      }
      res.writeHead(200, { "content-type": "application/vnd.github.sha" }).end(sha);
      return;
    }
    const tar = /^\/codeload\/([^/]+)\/([^/]+)\/tar\.gz\/([0-9a-f]{40})$/.exec(url.pathname);
    if (tar) {
      const body = repos.get(`${tar[1]}/${tar[2]}`)?.tarballs[tar[3]!];
      if (!body) {
        res.writeHead(404).end("Not Found");
        return;
      }
      res.writeHead(200, { "content-type": "application/x-gzip" }).end(body);
      return;
    }
    res.writeHead(404).end("Not Found");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.urls = { registry: `${base}/raw/index.json`, githubApi: `${base}/api`, codeload: `${base}/codeload` };
  return state;
}
