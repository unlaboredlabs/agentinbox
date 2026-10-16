// Canonical argument bytes (RFC 8785 JCS) and JSON Pointer (RFC 6901) helpers for mcp.call approvals and allow
// rules. Target paths are always JSON Pointers: dot paths can't tell `{"a.b": x}` from `{a: {b: y}}`.

/**
 * RFC 8785 canonical JSON: object keys sorted by UTF-16 code units, no whitespace, ES number and string
 * serialisation (what JSON.stringify does for primitives). Throws on values JSON can't carry.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("Arguments must not contain NaN or Infinity");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`Arguments must be JSON (got ${typeof value})`);
  }
}

/** A JSON Pointer naming a value inside the arguments: "/" followed by segments. The root ("") isn't a target. */
export const isPointer = (p: unknown): p is string => typeof p === "string" && p.startsWith("/") && p.length <= 512 && !/~[^01]|~$/.test(p);

const escapeSegment = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");

/** The value at a JSON Pointer (RFC 6901), or undefined when the path doesn't exist. Own properties only. */
export function atPointer(doc: unknown, pointer: string): unknown {
  if (!isPointer(pointer)) return undefined;
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const seg = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(seg)) return undefined;
      cur = cur[Number(seg)];
    } else if (cur && typeof cur === "object" && Object.hasOwn(cur, seg)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Pointers to every scalar leaf and array in the arguments, for "always allow for this argument". Capped. */
export function argumentPaths(args: unknown, max = 100): string[] {
  const out: string[] = [];
  const walk = (v: unknown, p: string) => {
    if (out.length >= max) return;
    if (Array.isArray(v)) {
      if (p) out.push(p);
      return;
    }
    if (v && typeof v === "object") {
      for (const k of Object.keys(v).sort()) walk((v as Record<string, unknown>)[k], `${p}/${escapeSegment(k)}`);
      return;
    }
    if (p) out.push(p);
  };
  walk(args, "");
  return out;
}
