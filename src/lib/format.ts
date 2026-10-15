// Relative (not @shared): unit tests type-check this file under the server config.
import type { Address, OverviewStats } from "../../shared/types.ts";
import { formatDistanceStrict } from "date-fns";

const full = new Intl.NumberFormat("en");
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export const fmtNumber = (n: number | null | undefined) => (n == null ? "—" : full.format(n));
export const fmtCompact = (n: number | null | undefined) => (n == null ? "—" : compact.format(n));

export function fmtMs(ms: number | null | undefined) {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return fmtDuration(ms);
}

export function fmtDuration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

function valid(date: string | number | Date | null | undefined): Date | null {
  if (date == null || date === "") return null;
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Under this, a past time reads "just now" rather than "0 seconds ago". */
const JUST_NOW_MS = 10_000;

/** "just now", "3 minutes ago", "in 2 hours". A couple of seconds ahead (clock skew) still counts as just now. */
export function fmtAgo(date: string | number | Date | null | undefined, now = Date.now()) {
  const d = valid(date);
  if (!d) return "—";
  const age = now - d.getTime();
  if (age > -2000 && age < JUST_NOW_MS) return "just now";
  return formatDistanceStrict(d, now, { addSuffix: true });
}

/** Full local timestamp for tooltips, e.g. "Oct 15, 2026, 14:03:22 (UTC+2)". */
export function fmtExact(date: string | number | Date | null | undefined) {
  const d = valid(date);
  if (!d) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

export function fmtDateTime(date: string | number | Date | null | undefined) {
  const d = valid(date);
  if (!d) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function fmtAddress(a: Address | null | undefined) {
  if (!a) return "—";
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

export function fmtAddressShort(a: Address | null | undefined) {
  if (!a) return "—";
  return a.name || a.email;
}

export const plural = (n: number, one: string, many = one + "s") => `${fmtNumber(n)} ${n === 1 ? one : many}`;

/**
 * "<agent> on <host>", unless the name already says where it runs: `connect` names agents
 * "Claude Code on anvil" (its host without .local/.lan/.home), so "on anvil" isn't added twice. A name
 * that is just the host is kept as is too. .local/.lan/.home are ignored on both sides.
 */
export function agentOnHost(name: string, host: string | null | undefined): string {
  if (!host) return name;
  const bare = (s: string) => s.trim().toLowerCase().replace(/\.(local|lan|home)$/, "");
  const n = bare(name);
  const short = bare(host);
  return n === short || n.endsWith(` on ${short}`) ? name : `${name} on ${host}`;
}

/**
 * The Overview's Accounts tile: "2" / "2 of 3", and its hint. With no account there is nothing to be
 * "all active" about: the hint is a link to connect one (`connect`). Paused accounts are said as such.
 */
export function accountsStat(a: OverviewStats["accounts"]): { value: string; hint: string; tone?: "critical"; connect?: boolean } {
  const value = a.active === a.total ? fmtNumber(a.total) : `${fmtNumber(a.active)} of ${fmtNumber(a.total)}`;
  if (!a.total) return { value, hint: "Connect Gmail", connect: true };
  if (a.needsAttention) return { value, hint: a.needsAttention === 1 ? "1 needs attention" : `${a.needsAttention} need attention`, tone: "critical" };
  const paused = a.total - a.active;
  return { value, hint: paused ? `${paused} paused` : a.total === 1 ? "active" : "all active" };
}

const DAY_MS = 86_400_000;
/** Intl puts thin and narrow no-break spaces around range dashes and before AM/PM; plain spaces read (and test) the same. */
const plainSpaces = (s: string) => s.replace(/[\u2009\u202f]/g, " ");

/**
 * When a calendar event happens, in the console's time zone (or `timeZone`): "Tue, Oct 20, 2:00 – 3:00 PM",
 * "Tue, Oct 20, 10:00 PM – Wed, Oct 21, 1:00 AM", "Tue, Oct 20 (all day)", "Oct 20 – 22 (all day)". The year
 * shows when it isn't the current one. All-day dates are calendar dates (end exclusive, as Google gives
 * them), so they never shift with the time zone.
 */
export function fmtEventWhen(
  e: { start: string; end: string; allDay: boolean },
  opts: { timeZone?: string; locale?: string; now?: number } = {},
): string {
  const start = valid(e.start);
  if (!start) return e.start || "—";
  const end = valid(e.end) ?? start;
  const thisYear = new Date(opts.now ?? Date.now()).getUTCFullYear();
  if (e.allDay) {
    // The last day the event covers (Google's end date is the day after).
    const last = new Date(Math.max(start.getTime(), end.getTime() - DAY_MS));
    const year = start.getUTCFullYear() !== thisYear || last.getUTCFullYear() !== thisYear ? ("numeric" as const) : undefined;
    const sameDay = last.getTime() === start.getTime();
    const f = new Intl.DateTimeFormat(opts.locale, { timeZone: "UTC", month: "short", day: "numeric", year, weekday: sameDay ? "short" : undefined });
    return plainSpaces(`${sameDay ? f.format(start) : f.formatRange(start, last)} (all day)`);
  }
  const year = start.getFullYear() !== thisYear ? ("numeric" as const) : undefined;
  const f = new Intl.DateTimeFormat(opts.locale, {
    timeZone: opts.timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year,
    hour: "numeric",
    minute: "2-digit",
  });
  return plainSpaces(end.getTime() > start.getTime() ? f.formatRange(start, end) : f.format(start));
}
