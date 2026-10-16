// A small, strict tar reader for extension sources: GitHub's codeload tarballs (gzip) and `git archive` (plain tar).
// Only regular files under the extension's subpath are written, and only after the whole archive has been read and
// checked: no symlinks, hard links or devices in the subpath, no absolute paths or `..` anywhere, size caps on the
// archive, the files and their count. Nothing here follows a link or writes outside `dest`.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";

export interface ExtractLimits {
  /** Total bytes of the extension's files. */
  maxBytes: number;
  /** Number of the extension's files. */
  maxFiles: number;
  /** The whole (decompressed) archive, which may hold a repository much larger than the extension. */
  maxArchiveBytes: number;
}

export const DEFAULT_LIMITS: ExtractLimits = { maxBytes: 20 * 1024 * 1024, maxFiles: 5_000, maxArchiveBytes: 256 * 1024 * 1024 };

export class UnsafeArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeArchiveError";
  }
}

export interface ExtractOptions {
  /** Leading path components to drop (codeload: 1, `<repo>-<sha>/`). */
  strip: number;
  /** The extension's directory inside the archive (after `strip`), "" for the root. */
  subpath: string;
  limits?: Partial<ExtractLimits>;
}

interface PendingFile {
  path: string;
  exec: boolean;
  data: Buffer;
}

const BLOCK = 512;

/** Splits and checks a path from the archive. Throws on an absolute path or a `..` segment. */
function segments(raw: string, what: string): string[] {
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new UnsafeArchiveError(`The archive has an absolute path (${what}).`);
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) throw new UnsafeArchiveError(`The archive has a path with "..": ${JSON.stringify(raw)}.`);
  return parts;
}

const cstr = (buf: Buffer, start: number, len: number) => {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString("utf8");
};

function octal(buf: Buffer, start: number, len: number): number {
  const field = buf.subarray(start, start + len);
  if (field[0]! & 0x80) {
    // Base-256 (GNU): big-endian, the top bit of the first byte is the marker.
    let n = field[0]! & 0x7f;
    for (let i = 1; i < field.length; i++) {
      n = n * 256 + field[i]!;
      if (n > Number.MAX_SAFE_INTEGER) throw new UnsafeArchiveError("The archive has an entry size that's too large.");
    }
    return n;
  }
  const s = cstr(buf, start, len).trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw new UnsafeArchiveError("The archive is malformed (a bad number in a header).");
  return parseInt(s, 8);
}

function checksumOk(header: Buffer): boolean {
  const stored = octal(header, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!;
  return sum === stored;
}

/** pax records: `<len> <key>=<value>\n`. */
function paxRecords(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const len = Number(data.subarray(i, sp).toString("ascii"));
    if (!Number.isInteger(len) || len <= 0 || i + len > data.length) throw new UnsafeArchiveError("The archive is malformed (a bad pax header).");
    const rec = data.subarray(sp + 1, i + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * Reads a tar stream and returns the extension's files (in memory, capped), without writing anything. Throws
 * UnsafeArchiveError on anything unsafe.
 */
export async function readTar(chunks: AsyncIterable<Buffer>, opts: ExtractOptions): Promise<PendingFile[]> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const sub = segments(opts.subpath, "the extension path");
  const files: PendingFile[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  let archiveBytes = 0;

  let buf: Buffer = Buffer.alloc(0);
  let ended = false;
  let paxNext: Record<string, string> = {};
  let longName: string | null = null;
  let zeroBlocks = 0;
  // The entry being read: its data blocks follow the header.
  type Entry = { remaining: number; padded: number; parts: Buffer[]; kind: "file" | "pax" | "longname" | "skip"; path: string; exec: boolean };
  let entry = null as Entry | null;

  const inSubpath = (parts: string[]): string[] | null => {
    if (parts.length < sub.length) return null;
    for (let i = 0; i < sub.length; i++) if (parts[i] !== sub[i]) return null;
    return parts.slice(sub.length);
  };

  const onHeader = (h: Buffer) => {
    if (h.every((b) => b === 0)) {
      zeroBlocks++;
      if (zeroBlocks >= 2) ended = true;
      return;
    }
    zeroBlocks = 0;
    if (!checksumOk(h)) throw new UnsafeArchiveError("The archive is malformed (a header checksum doesn't match).");
    const type = String.fromCharCode(h[156]!);
    const size = octal(h, 124, 12);
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    const start = (kind: "file" | "pax" | "longname" | "skip", path = "", exec = false) => {
      entry = { remaining: size, padded: padded - size, parts: [], kind, path, exec };
    };
    if (type === "x" || type === "g") {
      // pax extended header for the next entry ("x"), or a global one ("g", GitHub's commit comment): read "x", skip "g".
      if (size > 1024 * 1024) throw new UnsafeArchiveError("The archive has an oversized pax header.");
      return start(type === "x" ? "pax" : "skip");
    }
    if (type === "L") {
      if (size > 64 * 1024) throw new UnsafeArchiveError("The archive has an oversized long name.");
      return start("longname");
    }
    const ustar = cstr(h, 257, 6) === "ustar";
    const prefix = ustar ? cstr(h, 345, 155) : "";
    const name = paxNext.path ?? longName ?? (prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100));
    const paxSize = paxNext.size;
    paxNext = {};
    longName = null;
    if (paxSize !== undefined) {
      // A pax size overrides the header's (files over 8 GB); nothing that large is ever accepted.
      throw new UnsafeArchiveError("The archive has an entry too large for an extension.");
    }
    const parts = segments(name, JSON.stringify(name));
    if (parts.length < opts.strip) return start("skip");
    const rel = inSubpath(parts.slice(opts.strip));
    if (rel === null) return start("skip");
    const path = rel.join("/");
    if (type === "5") {
      if (size !== 0) throw new UnsafeArchiveError(`The archive's directory ${path || "(root)"} has data.`);
      return start("skip");
    }
    if (type === "2" || type === "1") throw new UnsafeArchiveError(`${path || opts.subpath} is a ${type === "2" ? "symlink" : "hard link"}; extensions can't contain links.`);
    if (type !== "0" && type !== "\0" && type !== "7") throw new UnsafeArchiveError(`${path || opts.subpath} isn't a regular file (tar type "${type}"); extensions can only contain files.`);
    if (!path) throw new UnsafeArchiveError(`The extension path ${opts.subpath} is a file, not a directory.`);
    if (path.includes("\\")) throw new UnsafeArchiveError(`${JSON.stringify(path)} has a backslash in its name.`);
    if (seen.has(path)) throw new UnsafeArchiveError(`${path} appears twice in the archive.`);
    seen.add(path);
    if (files.length + 1 > limits.maxFiles) throw new UnsafeArchiveError(`The extension has more than ${limits.maxFiles} files.`);
    bytes += size;
    if (bytes > limits.maxBytes) throw new UnsafeArchiveError(`The extension is larger than ${Math.round(limits.maxBytes / 1024 / 1024)} MB.`);
    start("file", path, (octal(h, 100, 8) & 0o111) !== 0);
  };

  const finishEntry = () => {
    const e = entry!;
    const data = Buffer.concat(e.parts);
    if (e.kind === "file") files.push({ path: e.path, exec: e.exec, data });
    else if (e.kind === "pax") paxNext = paxRecords(data);
    else if (e.kind === "longname") longName = cstr(data, 0, data.length);
  };

  for await (const chunk of chunks) {
    archiveBytes += chunk.length;
    if (archiveBytes > limits.maxArchiveBytes) throw new UnsafeArchiveError(`The archive is larger than ${Math.round(limits.maxArchiveBytes / 1024 / 1024)} MB.`);
    if (ended) continue;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let off = 0;
    for (;;) {
      if (ended) break;
      if (entry) {
        const e: Entry = entry;
        if (e.remaining > 0) {
          const take = Math.min(e.remaining, buf.length - off);
          if (take === 0) break;
          if (e.kind !== "skip") e.parts.push(buf.subarray(off, off + take));
          e.remaining -= take;
          off += take;
          if (e.remaining > 0) break;
        }
        if (e.padded > 0) {
          const take = Math.min(e.padded, buf.length - off);
          e.padded -= take;
          off += take;
          if (e.padded > 0) break;
        }
        finishEntry();
        entry = null;
        continue;
      }
      if (buf.length - off < BLOCK) break;
      onHeader(buf.subarray(off, off + BLOCK));
      off += BLOCK;
    }
    // Keep only what hasn't been consumed (copied: file parts may still point into the old buffer).
    buf = off >= buf.length ? Buffer.alloc(0) : Buffer.from(buf.subarray(off));
  }
  if (entry || !ended) throw new UnsafeArchiveError("The archive is truncated (no end-of-archive marker).");
  if (!files.length) throw new UnsafeArchiveError(opts.subpath ? `There's no extension at ${opts.subpath} in the archive.` : "The archive has no files.");
  return files;
}

/** Writes the files read by readTar into `dest` (which must exist and be empty). */
export function writeFiles(dest: string, files: PendingFile[]): void {
  for (const f of files) {
    const abs = join(dest, ...f.path.split("/"));
    mkdirSync(dirname(abs), { recursive: true, mode: 0o755 });
    writeFileSync(abs, f.data, { mode: f.exec ? 0o755 : 0o644, flag: "wx" });
    // Whatever the umask: the mode is part of the integrity.
    chmodSync(abs, f.exec ? 0o755 : 0o644);
  }
}

/** A gzip'd tar (codeload) as a chunk stream. */
export function gunzipChunks(data: Buffer): AsyncIterable<Buffer> {
  return Readable.from([data]).pipe(createGunzip());
}

/** A plain tar (git archive) as a chunk stream. */
export async function* bufferChunks(data: Buffer): AsyncIterable<Buffer> {
  yield data;
}
