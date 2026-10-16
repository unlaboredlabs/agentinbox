// Canonical argument bytes (RFC 8785 JCS) and argument-path helpers for mcp.call approvals and allow rules.

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

/**
 * The value at a dot-separated argument path (ToolClass.targetPath, approval_rules.target_path), e.g.
 * `parent.page_id` or `page_ids`; numeric segments index arrays. undefined when the path doesn't exist.
 */
export function atPath(doc: unknown, path: string): unknown {
  if (!path) return undefined;
  let cur: unknown = doc;
  for (const seg of path.split(".")) {
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

/** Dot paths of every scalar leaf and array in the arguments, for "always allow for this argument". Capped. */
export function argumentPaths(args: unknown, max = 100): string[] {
  const out: string[] = [];
  const walk = (v: unknown, p: string) => {
    if (out.length >= max) return;
    if (Array.isArray(v)) {
      if (p) out.push(p);
      return;
    }
    if (v && typeof v === "object") {
      for (const k of Object.keys(v).sort()) if (k && !k.includes(".")) walk((v as Record<string, unknown>)[k], p ? `${p}.${k}` : k);
      return;
    }
    if (p) out.push(p);
  };
  walk(args, "");
  return out;
}
