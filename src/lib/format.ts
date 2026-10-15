import type { Address } from "@shared/types";
import { formatDistanceToNowStrict } from "date-fns";

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

export function fmtAgo(date: string | number | Date | null | undefined) {
  const d = valid(date);
  return d ? formatDistanceToNowStrict(d, { addSuffix: true }) : "—";
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
