// Arguments are validated against the pinned inputSchema (and structuredContent against the pinned
// outputSchema) with ajv before anything is forwarded. Validators are cached per pin; nothing mutates the data.
//
// The schemas come from the upstream, and for outputs so does the data, so nothing here may be super-linear:
// - `pattern` / `patternProperties` / `propertyNames.pattern` run on RE2 (re2js, pure JS, linear time) instead
//   of backtracking RegExp. A pattern RE2 can't express (lookarounds, backreferences) isn't checked: the
//   upstream validates its own input anyway.
// - `uniqueItems` is dropped (ajv's check is quadratic on non-scalar items), for the same reason.
// - Callers cap the data's size (MAX_ARGS_BYTES here, MAX_STRUCTURED_CHARS in output.ts) before validating.

import { Ajv, type Options, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { RE2JS } from "re2js";

type RegExpEngine = NonNullable<NonNullable<Options["code"]>["regExp"]>;

/** Arguments larger than this (canonical JSON bytes) are refused before validation. */
export const MAX_ARGS_BYTES = 1024 * 1024;

const re2: RegExpEngine = Object.assign(
  (pattern: string) => {
    // ajv keys compiled patterns by toString(): it must be unique per pattern, or every pattern shares one.
    const toString = () => `re2:${pattern}`;
    try {
      const re = RE2JS.compile(pattern);
      return { test: (s: string) => re.matcher(s).find(), toString };
    } catch {
      return { test: () => true, toString };
    }
  },
  { code: "re2js" },
);

const options = {
  strict: false,
  allErrors: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  validateFormats: false,
  code: { regExp: re2 },
} as const;
const draft07 = new Ajv(options);
const draft2020 = new Ajv2020(options);

/** Bounded cache: pinned schemas rarely change, but a long-lived process sees many. */
const MAX_CACHED = 2000;
const cache = new Map<string, ValidateFunction | Error>();

/** A copy without `uniqueItems` (as a keyword: a boolean value) and without `$id` (ids may collide across connections). */
function sanitize(v: unknown, depth = 0): unknown {
  if (depth > 64) throw new Error("schema too deep");
  if (Array.isArray(v)) return v.map((x) => sanitize(x, depth + 1));
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "uniqueItems" && typeof x === "boolean") continue;
    if (k === "$id" && depth === 0) continue;
    out[k] = sanitize(x, depth + 1);
  }
  return out;
}

function compile(key: string, schema: Record<string, unknown>): ValidateFunction | Error {
  const hit = cache.get(key);
  if (hit) return hit;
  let out: ValidateFunction | Error;
  try {
    const $schema = typeof schema.$schema === "string" ? schema.$schema : "";
    const ajv = $schema.includes("2020-12") || $schema.includes("2019-09") ? draft2020 : draft07;
    out = ajv.compile(sanitize(schema) as Record<string, unknown>);
  } catch (err) {
    out = err instanceof Error ? err : new Error(String(err));
  }
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(key, out);
  return out;
}

export type ValidationResult = { ok: true } | { ok: false; message: string };

/** Problems as `path: message` (paths and schema keywords only; never the values). */
function describe(v: ValidateFunction): string {
  const errs = (v.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || "(arguments)"} ${e.message ?? "is invalid"}`);
  return errs.join("; ") || "the arguments don't match the tool's schema";
}

export function validateArgs(pinHash: string, schema: Record<string, unknown>, args: unknown): ValidationResult {
  const v = compile(`in:${pinHash}`, schema);
  if (v instanceof Error) return { ok: false, message: "The tool's input schema can't be checked, so agentinbox won't forward calls to it. Ask the owner to look at the connection." };
  return v(args) ? { ok: true } : { ok: false, message: describe(v) };
}

/** True when there's no outputSchema, or the value matches it. A schema that can't compile fails closed. */
export function validateOutput(pinHash: string, schema: Record<string, unknown> | undefined, value: unknown): boolean {
  if (!schema) return true;
  const v = compile(`out:${pinHash}`, schema);
  return !(v instanceof Error) && v(value) === true;
}
