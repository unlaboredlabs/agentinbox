import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { EVENT_TYPES, type EventType, type WebhookFilter } from "../../shared/types.ts";
import { normalizeFilter, webhookFilterSchema } from "../webhooks/filter.ts";
import { resolve } from "node:path";
import { newSecret, validateForwardUrl } from "./forward.ts";
import { assertTrustedDir } from "./fsutil.ts";
import { workDir } from "./paths.ts";
import type { Profile } from "./profile.ts";

/** `listen` flags. Each group overrides the profile as a unit: targets (--exec/--forward), --types, and the filter (--from/--to/--label/--subject). */
export interface ListenFlags {
  profile?: string;
  exec?: string;
  forward?: string;
  types?: string;
  from?: string[];
  to?: string[];
  label?: string[];
  subject?: string;
  includeBody?: boolean;
  concurrency?: number;
  timeout?: number;
  maxAttempts?: number;
  consumer?: string;
  insecure?: boolean;
  cwd?: string;
  save?: boolean;
  dryRun?: boolean;
  /** A new consumer starts at the oldest stored event instead of now (never saved). */
  fromStart?: boolean;
  /** One-off: run every stored event up to now through the targets (own throwaway cursor and lock), then exit. */
  backfill?: boolean;
  /** --backfill: replay up to this seq instead of where the listener started. */
  until?: number;
}

export interface EffectiveConfig {
  exec: string | null;
  forward: { url: string; secret: string } | null;
  /** Never empty: DEFAULT_LISTEN_TYPES unless --types or the profile says otherwise. */
  types: EventType[];
  /** Neither --types nor the profile named types: `types` is DEFAULT_LISTEN_TYPES. */
  typesDefaulted: boolean;
  filter: WebhookFilter | undefined;
  includeBody: boolean;
  concurrency: number;
  timeoutSeconds: number;
  maxAttempts: number;
  consumer: string;
  insecure: boolean;
  /** Working directory for commands: validated --cwd, else the profile's private work dir. */
  cwd: string;
  cwdIsDefault: boolean;
}

export const DEFAULTS = { concurrency: 2, timeoutSeconds: 300, maxAttempts: 5 } as const;

/**
 * Event types a listener gets when neither --types nor the profile names any: new mail only. Each
 * event can start a paid agent run, so mail the account sends (message.sent, also the console's
 * test email) and label changes don't wake it unless asked for with --types.
 */
export const DEFAULT_LISTEN_TYPES: readonly EventType[] = ["message.received"];

/** Comma-separated event types; "all" means every type. */
export function parseTypes(value: string): EventType[] {
  const list = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length) throw new Error(`--types needs at least one event type (or "all"). Choose from: ${EVENT_TYPES.join(", ")}.`);
  if (list.includes("all")) {
    if (list.length > 1) throw new Error(`--types all can't be combined with other types.`);
    return [...EVENT_TYPES];
  }
  const bad = list.filter((t) => !(EVENT_TYPES as readonly string[]).includes(t));
  if (bad.length) throw new Error(`Unknown event type${bad.length > 1 ? "s" : ""} ${bad.join(", ")}. Choose from: ${EVENT_TYPES.join(", ")}.`);
  return [...new Set(list)] as EventType[];
}

const CONSUMER_RE = /^[A-Za-z0-9._-]{1,100}$/;
/** Suffixes of the throwaway cursors `--backfill` and `--dry-run` derive from a consumer (the daemon reserves them too). */
export const THROWAWAY_SUFFIXES = { backfill: "-replay", dryRun: "-dry-run" } as const;

export function validConsumer(name: string): string {
  if (!CONSUMER_RE.test(name)) throw new Error(`Invalid consumer name "${name}": use up to 100 letters, digits, ".", "_" or "-".`);
  const reserved = Object.values(THROWAWAY_SUFFIXES).find((s) => name.endsWith(s));
  if (reserved) throw new Error(`Invalid consumer name "${name}": names ending in "${reserved}" are reserved for --backfill and --dry-run cursors.`);
  return name;
}

/**
 * The throwaway cursor for `consumer`: `<consumer><suffix>`, or, when that would pass the 100-character
 * limit, a truncated name plus a hash of the full one, so two long consumers never share a cursor.
 */
export function throwawayConsumer(consumer: string, suffix: (typeof THROWAWAY_SUFFIXES)[keyof typeof THROWAWAY_SUFFIXES]): string {
  if (consumer.length + suffix.length <= 100) return `${consumer}${suffix}`;
  const hash = createHash("sha256").update(consumer).digest("hex").slice(0, 8);
  return `${consumer.slice(0, 100 - suffix.length - hash.length - 1)}-${hash}${suffix}`;
}

/** Default consumer: one server-side cursor per machine and profile. */
export function defaultConsumer(profile: string): string {
  const host = hostname()
    .toLowerCase()
    .replace(/\.local$/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    // Fits the 100-character consumer limit with "-<profile>" (profiles are at most 40).
    .slice(0, 99 - profile.length);
  return `${host || "host"}-${profile}`;
}

/** The forward-mode signing secret: generated once per profile, kept with the saved forward URL when there is one. */
export function forwardSecret(profile: Profile): { secret: string; created: boolean } {
  const existing = profile.forward?.secret ?? profile.forwardSecret;
  if (existing) return { secret: existing, created: false };
  return { secret: newSecret(), created: true };
}

function filterFromFlags(f: ListenFlags): WebhookFilter | undefined {
  const given = f.from?.length || f.to?.length || f.label?.length || f.subject !== undefined;
  if (!given) return undefined;
  const filter = normalizeFilter({ from: f.from, to: f.to, labelIds: f.label, subject: f.subject });
  const parsed = webhookFilterSchema.safeParse(filter);
  if (!parsed.success) throw new Error(`Invalid filter: ${parsed.error.issues[0]?.message}`);
  return filter;
}

const positiveInt = (v: number | undefined, name: string, max: number) => {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || v < 1 || v > max) throw new Error(`${name} must be a whole number from 1 to ${max}.`);
  return v;
};

/**
 * Merges flags over the profile. Returns the effective config and the profile as it would be saved
 * with --save (the forward secret is always persisted, so receivers keep verifying across restarts).
 */
export function resolveListen(profileName: string, profile: Profile, flags: ListenFlags): { config: EffectiveConfig; next: Profile; changed: boolean } {
  const next: Profile = { ...profile };
  let changed = false;

  const targetsGiven = flags.exec !== undefined || flags.forward !== undefined;
  let exec = profile.exec ?? null;
  let forward = profile.forward ?? null;
  if (targetsGiven) {
    exec = flags.exec?.trim() ? flags.exec : null;
    if (flags.exec !== undefined && !flags.exec.trim()) throw new Error("--exec needs a command.");
    forward = null;
    if (flags.forward) {
      const url = validateForwardUrl(flags.forward);
      const { secret, created } = forwardSecret(profile);
      forward = { url, secret };
      if (created || !profile.forward) {
        // Keep the secret even without --save so `listen secret` and the receiver agree from now on.
        next.forwardSecret = secret;
        changed = true;
      }
    }
  }
  if (forward) validateForwardUrl(forward.url);

  // Saved as given (no types saved = the default), so the profile follows the default if it changes.
  const typesDefaulted = flags.types === undefined && !profile.types?.length;
  const types = flags.types !== undefined ? parseTypes(flags.types) : typesDefaulted ? [...DEFAULT_LISTEN_TYPES] : profile.types!;
  const filter = filterFromFlags(flags) ?? profile.filter;
  const includeBody = flags.includeBody ?? profile.includeBody ?? false;
  const concurrency = positiveInt(flags.concurrency, "--concurrency", 32) ?? profile.concurrency ?? DEFAULTS.concurrency;
  const timeoutSeconds = positiveInt(flags.timeout, "--timeout", 86_400) ?? profile.timeoutSeconds ?? DEFAULTS.timeoutSeconds;
  const maxAttempts = positiveInt(flags.maxAttempts, "--max-attempts", 100) ?? profile.maxAttempts ?? DEFAULTS.maxAttempts;
  const consumer = validConsumer(flags.consumer ?? profile.consumer ?? defaultConsumer(profileName));
  const insecure = flags.insecure ?? profile.insecure ?? false;
  const chosenCwd = flags.cwd !== undefined ? resolve(flags.cwd) : profile.cwd;
  if (chosenCwd) assertTrustedDir(chosenCwd);
  const cwd = chosenCwd ?? workDir(profileName);

  if (flags.save) {
    changed = true;
    if (targetsGiven) {
      next.exec = exec ?? undefined;
      next.forward = forward ?? undefined;
      if (forward) delete next.forwardSecret;
    }
    if (flags.types !== undefined) next.types = types;
    if (filterFromFlags(flags)) next.filter = filter;
    if (flags.includeBody !== undefined) next.includeBody = includeBody;
    if (flags.concurrency !== undefined) next.concurrency = concurrency;
    if (flags.timeout !== undefined) next.timeoutSeconds = timeoutSeconds;
    if (flags.maxAttempts !== undefined) next.maxAttempts = maxAttempts;
    if (flags.consumer !== undefined) next.consumer = consumer;
    if (flags.insecure !== undefined) next.insecure = insecure;
    if (flags.cwd !== undefined) next.cwd = chosenCwd;
  }

  return { config: { exec, forward, types, typesDefaulted, filter, includeBody, concurrency, timeoutSeconds, maxAttempts, consumer, insecure, cwd, cwdIsDefault: !chosenCwd }, next, changed };
}

/** Notes about the event types for the listener's log: the default in use, or types that overlap. */
export function typesNotes(c: Pick<EffectiveConfig, "types" | "typesDefaulted">): { info: string[]; warn: string[] } {
  const info: string[] = [];
  const warn: string[] = [];
  if (c.typesDefaulted) info.push(`Using default types: ${DEFAULT_LISTEN_TYPES.join(", ")} (add --types all for every event).`);
  if (c.types.includes("message.received") && c.types.includes("thread.reply_received")) {
    warn.push(
      "thread.reply_received is a subset of message.received: with both, every reply to a thread you sent runs your command twice. Keep one of them (--types thread.reply_received for replies only).",
    );
  }
  return { info, warn };
}

/** One-line description of the filter for the console. */
export function describeFilter(c: Pick<EffectiveConfig, "types" | "filter">): string {
  const parts: string[] = [];
  if (c.types?.length) parts.push(c.types.length === EVENT_TYPES.length ? "all event types" : `types ${c.types.join(", ")}`);
  const f = c.filter ?? {};
  if (f.from?.length) parts.push(`from ${f.from.join(" | ")}`);
  if (f.to?.length) parts.push(`to ${f.to.join(" | ")}`);
  if (f.labelIds?.length) parts.push(`label ${f.labelIds.join(" | ")}`);
  if (f.subject) parts.push(`subject /${f.subject}/i`);
  if (f.hasAttachments !== undefined) parts.push(f.hasAttachments ? "with attachments" : "without attachments");
  return parts.length ? parts.join(" · ") : "all events your grants can see";
}
