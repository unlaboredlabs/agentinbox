import { isIPv4, isIPv6 } from "node:net";

/** An address as a family and a big integer, with IPv4-mapped IPv6 (::ffff:a.b.c.d) treated as IPv4. */
interface Addr {
  v6: boolean;
  n: bigint;
}

function parseV4(ip: string): bigint {
  return ip.split(".").reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
}

export function parseAddress(raw: string): Addr | null {
  const ip = raw.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  if (isIPv4(ip)) return { v6: false, n: parseV4(ip) };
  if (!isIPv6(ip)) return null;
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped && isIPv4(mapped[1]!)) return { v6: false, n: parseV4(mapped[1]!) };
  // Expand an embedded IPv4 tail into two hextets, then "::".
  let text = ip;
  const v4Tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4Tail) {
    const n = parseV4(v4Tail[1]!);
    text = text.slice(0, -v4Tail[1]!.length) + `${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  if (groups.length !== 8) return null;
  return { v6: true, n: groups.reduce((acc, g) => (acc << 16n) | BigInt(Number.parseInt(g || "0", 16)), 0n) };
}

interface Range {
  v6: boolean;
  base: bigint;
  bits: number;
}

/**
 * Parses "10.0.0.5", "10.0.0.0/8", "fd00::/8", "::ffff:10.0.0.0/104"; null when invalid. A /0
 * (trust everyone) is refused: it would let any client pick its own address.
 */
export function parseRange(entry: string): Range | null {
  const parts = entry.trim().split("/");
  if (parts.length > 2) return null;
  const [ip = "", prefix] = parts;
  const addr = parseAddress(ip);
  if (!addr) return null;
  let bits = addr.v6 ? 128 : 32;
  if (prefix !== undefined) {
    if (!/^\d{1,3}$/.test(prefix)) return null;
    bits = Number(prefix);
    // A mapped IPv4 range written in IPv6 form: drop the 96-bit ::ffff: prefix.
    if (!addr.v6 && ip.includes(":")) bits -= 96;
    if (bits <= 0 || bits > (addr.v6 ? 128 : 32)) return null;
  }
  const width = BigInt(addr.v6 ? 128 : 32);
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << (width - BigInt(bits));
  return { v6: addr.v6, base: addr.n & mask, bits };
}

function inRange(addr: Addr, r: Range): boolean {
  if (addr.v6 !== r.v6) return false;
  const width = BigInt(r.v6 ? 128 : 32);
  const mask = r.bits === 0 ? 0n : ((1n << BigInt(r.bits)) - 1n) << (width - BigInt(r.bits));
  return (addr.n & mask) === r.base;
}

const LOOPBACK = [parseRange("127.0.0.0/8")!, parseRange("::1/128")!];

let cache: { raw: string; ranges: Range[] } | undefined;

/** TRUST_PROXY_FROM as ranges. Invalid entries are reported once and ignored. */
function trustedRanges(raw: string): Range[] {
  if (cache?.raw === raw) return cache.ranges;
  const ranges: Range[] = [];
  const invalid: string[] = [];
  for (const entry of raw.split(/[,\s]+/).filter(Boolean)) {
    const r = parseRange(entry);
    if (r) ranges.push(r);
    else invalid.push(entry);
  }
  if (invalid.length) process.stderr.write(`agentinbox: ignoring invalid TRUST_PROXY_FROM entries: ${invalid.join(", ")}\n`);
  cache = { raw, ranges };
  return ranges;
}

/**
 * Whether forwarding headers from this socket peer may be believed: loopback always (a proxy on
 * the same host), anything else only when listed in TRUST_PROXY_FROM (IPs or CIDRs, comma-separated).
 * The daemon usually binds 0.0.0.0, so trusting whole private ranges would let any LAN or tailnet
 * peer forge its address.
 */
export function isTrustedProxy(peer: string, trustFrom = process.env.TRUST_PROXY_FROM ?? ""): boolean {
  const addr = parseAddress(peer);
  if (!addr) return false;
  return [...LOOPBACK, ...trustedRanges(trustFrom)].some((r) => inRange(addr, r));
}
