import { createHash } from "node:crypto";

/**
 * RFC 8785 JSON Canonicalization Scheme. ECMAScript `JSON.stringify` already serialises primitives exactly as the
 * RFC requires (§3.2.2: number formatting per ES Number::toString, string escaping per ES JSON.stringify); JCS adds
 * object members sorted by their UTF-16 code units (§3.2.3), which is what the default `Array.prototype.sort` does.
 * Undefined members are dropped (JSON semantics). Non-finite numbers, non-JSON values and nesting deeper than
 * MAX_JCS_DEPTH throw.
 */
export const MAX_JCS_DEPTH = 64;

export function canonicalize(value: unknown, depth = 0): string {
  if (depth > MAX_JCS_DEPTH) throw new TypeError("JCS: nested too deeply");
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("JCS: non-finite number");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v === undefined ? null : v, depth + 1)).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k], depth + 1)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`JCS: unsupported ${typeof value}`);
  }
}

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
