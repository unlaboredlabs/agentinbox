// Arguments are validated against the pinned inputSchema (and structuredContent against the pinned
// outputSchema) with ajv before anything is forwarded. Validators are cached per pin; nothing mutates the data.

import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";

const options = { strict: false, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false, validateFormats: false } as const;
const draft07 = new Ajv(options);
const draft2020 = new Ajv2020(options);

/** Bounded cache: pinned schemas rarely change, but a long-lived process sees many. */
const MAX_CACHED = 2000;
const cache = new Map<string, ValidateFunction | Error>();

function compile(key: string, schema: Record<string, unknown>): ValidateFunction | Error {
  const hit = cache.get(key);
  if (hit) return hit;
  let out: ValidateFunction | Error;
  try {
    const $schema = typeof schema.$schema === "string" ? schema.$schema : "";
    const ajv = $schema.includes("2020-12") || $schema.includes("2019-09") ? draft2020 : draft07;
    // Upstream schemas may carry $id values that collide across connections: compile without them.
    const { $id: _id, ...rest } = schema;
    out = ajv.compile(rest);
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
