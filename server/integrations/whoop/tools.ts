// The WHOOP ToolSource: seven read tools with pre-pinned definitions, compact text plus structuredContent.

import type { NativeSourceDeps, ToolCallContext, ToolDef, ToolListing, ToolResult, ToolSource } from "../../broker/types.ts";
import { type BodyMeasurement, type Cycle, type Profile, type Recovery, type Sleep, type Workout, PATHS, WhoopRequestError, apiGet, collect } from "./api.ts";
import { bodyText, cycleLine, cycleText, localTime, profileText, recoveryLine, recoveryText, sleepLine, sleepText, workoutLine } from "./format.ts";

const DAY = 86_400_000;
const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const RANGE_PROPS = {
  start: {
    type: "string",
    description: "Earliest time, as a date (YYYY-MM-DD, UTC midnight) or an ISO 8601 timestamp. Defaults to 7 days ago.",
  },
  end: {
    type: "string",
    description: "Latest time, as a date (YYYY-MM-DD, that whole UTC day included) or an ISO 8601 timestamp. Defaults to now.",
  },
  limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `Most records to return (1 to ${MAX_LIMIT}). Defaults to ${DEFAULT_LIMIT}.` },
  nextToken: { type: "string", description: "Continue a previous result: pass the nextToken it returned, with the same start and end." },
} as const;

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const rangeSchema = (extra: Record<string, unknown> = {}) => ({
  type: "object",
  properties: { ...extra, ...RANGE_PROPS },
  additionalProperties: false,
});

/** Pre-pinned, deterministic definitions (the catalog hashes these; changing one is audited as a tool change). */
export const WHOOP_TOOLS: readonly ToolDef[] = [
  {
    name: "get_today",
    title: "WHOOP today",
    description:
      "Today's WHOOP summary in one call: this morning's recovery (score, resting heart rate, heart rate variability), last night's sleep, and the day's strain so far. Use it first for questions like 'how did I sleep' or 'how recovered am I'.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "WHOOP today", ...READ },
  },
  {
    name: "get_recovery",
    title: "WHOOP recovery",
    description:
      "WHOOP recovery scores, newest first: recovery percent, resting heart rate, heart rate variability, blood oxygen and skin temperature. Pass sleepId (as in whoop.recovery_updated events) or cycleId for one recovery, or a date range for a list.",
    inputSchema: rangeSchema({
      sleepId: { type: "string", description: "The sleep this recovery belongs to (from a whoop.recovery_updated event)." },
      cycleId: { type: "integer", description: "The cycle (physiological day) this recovery belongs to." },
    }),
    annotations: { title: "WHOOP recovery", ...READ },
  },
  {
    name: "get_sleep",
    title: "WHOOP sleep",
    description:
      "WHOOP sleeps and naps, newest first: time asleep and in bed, sleep stages, performance, efficiency, consistency, respiratory rate and sleep needed. Pass id for one sleep (as in whoop.sleep_updated events), or a date range for a list.",
    inputSchema: rangeSchema({ id: { type: "string", description: "One sleep's id (a UUID)." } }),
    annotations: { title: "WHOOP sleep", ...READ },
  },
  {
    name: "get_cycles",
    title: "WHOOP cycles",
    description:
      "WHOOP physiological cycles (days, from waking to waking), newest first: day strain, energy in kilojoules and kilocalories, average and max heart rate. Pass id for one cycle, or a date range for a list.",
    inputSchema: rangeSchema({ id: { type: "integer", description: "One cycle's id." } }),
    annotations: { title: "WHOOP cycles", ...READ },
  },
  {
    name: "get_workouts",
    title: "WHOOP workouts",
    description:
      "WHOOP workouts, newest first: sport, duration, strain, energy, heart rate, distance and time in heart rate zones. Pass id for one workout (as in whoop.workout_updated events), or a date range for a list.",
    inputSchema: rangeSchema({ id: { type: "string", description: "One workout's id (a UUID)." } }),
    annotations: { title: "WHOOP workouts", ...READ },
  },
  {
    name: "get_profile",
    title: "WHOOP profile",
    description: "The connected WHOOP member's name, email and user id.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "WHOOP profile", ...READ },
  },
  {
    name: "get_body",
    title: "WHOOP body measurements",
    description: "The connected WHOOP member's height in meters, weight in kilograms and max heart rate in beats per minute.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "WHOOP body measurements", ...READ },
  },
];

class ArgError extends Error {}

/** A date (UTC midnight; for `end`, the next midnight so the day is included) or a timestamp, as ISO 8601. */
export function parseTime(v: unknown, name: string, isEnd: boolean): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new ArgError(`${name} must be a date (YYYY-MM-DD) or an ISO 8601 timestamp`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const t = Date.parse(`${v}T00:00:00.000Z`);
    if (Number.isNaN(t)) throw new ArgError(`${name} is not a valid date: ${v}`);
    return new Date(isEnd ? t + DAY : t).toISOString();
  }
  const t = Date.parse(v);
  if (Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}T/.test(v)) throw new ArgError(`${name} must be a date (YYYY-MM-DD) or an ISO 8601 timestamp`);
  return new Date(t).toISOString();
}

function parseRange(args: Record<string, unknown>, now: number) {
  const start = parseTime(args.start, "start", false) ?? new Date(now - DEFAULT_DAYS * DAY).toISOString();
  const end = parseTime(args.end, "end", true);
  if (end && Date.parse(end) <= Date.parse(start)) throw new ArgError("end must be after start");
  const limit = args.limit === undefined ? DEFAULT_LIMIT : args.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new ArgError(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
  const nextToken = args.nextToken;
  if (nextToken !== undefined && (typeof nextToken !== "string" || !nextToken)) throw new ArgError("nextToken must be the string a previous result returned");
  return { start, end, limit, nextToken: (nextToken as string | undefined) ?? null };
}

function idArg(args: Record<string, unknown>, name: string, kind: "string" | "integer"): string | undefined {
  const v = args[name];
  if (v === undefined || v === null || v === "") return undefined;
  if (kind === "integer" ? !Number.isSafeInteger(v) || (v as number) < 0 : typeof v !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(v)) {
    throw new ArgError(`${name} must be ${kind === "integer" ? "a whole number" : "an id as returned by WHOOP"}`);
  }
  return String(v);
}

const text = (t: string, structured?: unknown): ToolResult => ({
  content: [{ type: "text", text: t }],
  ...(structured === undefined ? {} : { structuredContent: structured }),
});
const toolError = (t: string): ToolResult => ({ content: [{ type: "text", text: t }], isError: true });

function list<T>(noun: string, records: T[], nextToken: string | null, line: (r: T) => string, range: { start: string; end?: string }): ToolResult {
  const window = `from ${localTime(range.start)} to ${range.end ? localTime(range.end) : "now"}`;
  const head = records.length ? `${records.length} ${noun} ${window}, newest first:` : `No ${noun} ${window}.`;
  const tail = nextToken ? `\nMore available: call again with nextToken "${nextToken}" and the same start and end.` : "";
  return text([head, ...records.map(line)].join("\n") + tail, { records, nextToken });
}

export interface WhoopSourceOptions {
  now?: () => number;
}

export function createWhoopSource(deps: NativeSourceDeps, opts: WhoopSourceOptions = {}): ToolSource {
  const now = opts.now ?? Date.now;
  const listing: ToolListing = { tools: WHOOP_TOOLS.map((t) => structuredClone(t)) };

  const tools: Record<string, (args: Record<string, unknown>, signal: AbortSignal) => Promise<ToolResult>> = {
    async get_today(_args, signal) {
      const page = await apiGet<{ records: Cycle[] }>(deps, PATHS.cycles, { limit: "1" }, signal);
      const cycle = page?.records?.[0] ?? null;
      if (!cycle) return text("No WHOOP data yet: the strap hasn't recorded a cycle.", { cycle: null, recovery: null, sleep: null });
      const [recovery, sleep] = await Promise.all([
        apiGet<Recovery>(deps, PATHS.cycleRecovery(cycle.id), {}, signal),
        apiGet<Sleep>(deps, PATHS.cycleSleep(cycle.id), {}, signal),
      ]);
      const lines = [
        `Today: cycle ${cycle.id}, started ${localTime(cycle.start, cycle.timezone_offset)}${cycle.end ? `, ended ${localTime(cycle.end, cycle.timezone_offset)}` : " (ongoing)"}.`,
        `Recovery: ${recovery ? recoveryText(recovery) : "not available yet"}.`,
        `Last night's sleep: ${sleep ? `${localTime(sleep.start, sleep.timezone_offset)} to ${localTime(sleep.end, sleep.timezone_offset)}, ${sleepText(sleep)}` : "not available yet"}.`,
        `Strain so far: ${cycleText(cycle)}.`,
      ];
      return text(lines.join("\n"), { cycle, recovery, sleep });
    },

    async get_recovery(args, signal) {
      const sleepId = idArg(args, "sleepId", "string");
      let cycleId = idArg(args, "cycleId", "integer");
      if (sleepId || cycleId) {
        if (sleepId && !cycleId) {
          const sleep = await apiGet<Sleep>(deps, PATHS.sleep(sleepId), {}, signal);
          if (!sleep) return toolError(`No WHOOP sleep with id ${sleepId}.`);
          cycleId = String(sleep.cycle_id);
        }
        const r = await apiGet<Recovery>(deps, PATHS.cycleRecovery(cycleId!), {}, signal);
        if (!r) return toolError(`No WHOOP recovery for cycle ${cycleId} yet.`);
        return text(`Recovery\n${recoveryLine(r)}`, { records: [r], nextToken: null });
      }
      const range = parseRange(args, now());
      const page = await collect<Recovery>(deps, PATHS.recoveries, range, range.limit, range.nextToken, signal);
      return list("recoveries", page.records, page.nextToken, recoveryLine, range);
    },

    async get_sleep(args, signal) {
      const id = idArg(args, "id", "string");
      if (id) {
        const s = await apiGet<Sleep>(deps, PATHS.sleep(id), {}, signal);
        return s ? text(`Sleep\n${sleepLine(s)}`, { records: [s], nextToken: null }) : toolError(`No WHOOP sleep with id ${id}.`);
      }
      const range = parseRange(args, now());
      const page = await collect<Sleep>(deps, PATHS.sleeps, range, range.limit, range.nextToken, signal);
      return list("sleeps", page.records, page.nextToken, sleepLine, range);
    },

    async get_cycles(args, signal) {
      const id = idArg(args, "id", "integer");
      if (id) {
        const c = await apiGet<Cycle>(deps, PATHS.cycle(id), {}, signal);
        return c ? text(`Cycle\n${cycleLine(c)}`, { records: [c], nextToken: null }) : toolError(`No WHOOP cycle with id ${id}.`);
      }
      const range = parseRange(args, now());
      const page = await collect<Cycle>(deps, PATHS.cycles, range, range.limit, range.nextToken, signal);
      return list("cycles", page.records, page.nextToken, cycleLine, range);
    },

    async get_workouts(args, signal) {
      const id = idArg(args, "id", "string");
      if (id) {
        const w = await apiGet<Workout>(deps, PATHS.workout(id), {}, signal);
        return w ? text(`Workout\n${workoutLine(w)}`, { records: [w], nextToken: null }) : toolError(`No WHOOP workout with id ${id}.`);
      }
      const range = parseRange(args, now());
      const page = await collect<Workout>(deps, PATHS.workouts, range, range.limit, range.nextToken, signal);
      return list("workouts", page.records, page.nextToken, workoutLine, range);
    },

    async get_profile(_args, signal) {
      const p = await apiGet<Profile>(deps, PATHS.profile, {}, signal);
      return p ? text(profileText(p), p) : toolError("WHOOP returned no profile.");
    },

    async get_body(_args, signal) {
      const b = await apiGet<BodyMeasurement>(deps, PATHS.body, {}, signal);
      return b ? text(bodyText(b), b) : toolError("WHOOP has no body measurements for this member.");
    },
  };

  return {
    connectionId: deps.connectionId,
    async listTools() {
      return listing;
    },
    async callTool(name: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
      const run = Object.hasOwn(tools, name) ? tools[name] : undefined;
      if (!run) return toolError(`Unknown WHOOP tool: ${name}`);
      try {
        return await run(args ?? {}, ctx.signal);
      } catch (err) {
        if (err instanceof ArgError || err instanceof WhoopRequestError) return toolError(err.message);
        throw err;
      }
    },
    async close() {},
  };
}
