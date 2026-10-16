// Audit helpers for broker calls: argument fingerprints, and full arguments (risky calls only) with
// secret-like keys and this connection's secrets redacted.

import { sha256 } from "../../crypto.ts";
import { REDACTED, type Scrubber } from "./output.ts";

/** Keys whose values are never kept in the audit log. */
const SECRET_KEY = /pass(word|phrase)?|secret|token|api[-_]?key|authori[sz]ation|auth(?!or)|bearer|credential|private[-_]?key|cookie|session|signature|otp|pin\b|cvv|card[-_]?number/i;
/** Full arguments kept per audit entry, as JSON. */
const MAX_AUDIT_ARGS_CHARS = 8000;

export function fingerprint(bytes: string): { argsSha256: string; argsBytes: number } {
  return { argsSha256: sha256(bytes), argsBytes: Buffer.byteLength(bytes) };
}

export function redactArgs(args: unknown, scrubber: Scrubber): { args: unknown; argsTruncated?: true } {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrubber.scrub(v).text;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? REDACTED : walk(x)]));
    return v;
  };
  const out = walk(args);
  const s = JSON.stringify(out);
  if (s.length <= MAX_AUDIT_ARGS_CHARS) return { args: out };
  return { args: s.slice(0, MAX_AUDIT_ARGS_CHARS), argsTruncated: true };
}
