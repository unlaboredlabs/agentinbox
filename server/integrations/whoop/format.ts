// Compact, unit-spelled text for WHOOP records. Times are shown in the record's own local time (timezone_offset).

import type { BodyMeasurement, Cycle, Profile, Recovery, ScoreState, Sleep, Workout } from "./api.ts";

const round = (n: number, digits = 1) => {
  const f = 10 ** digits;
  return String(Math.round(n * f) / f);
};
const thousands = (n: number) => Math.round(n).toLocaleString("en-US");
const bpm = (n: number) => `${Math.round(n)} beats per minute`;
const kj = (n: number) => `${thousands(n)} kilojoules (${thousands(n / 4.184)} kilocalories)`;

/** "7 hours 12 minutes", "45 minutes", "1 hour". */
export function duration(ms: number): string {
  const total = Math.round(ms / 60_000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} hour${h === 1 ? "" : "s"}`);
  if (m || !h) parts.push(`${m} minute${m === 1 ? "" : "s"}`);
  return parts.join(" ");
}

function offsetMinutes(offset: string | undefined): number | null {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(offset ?? "");
  if (!m) return offset === "Z" ? 0 : null;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** "2026-10-15 06:31" in the record's local time, or "… UTC" without an offset. */
export function localTime(iso: string | null | undefined, offset?: string): string {
  if (!iso) return "unknown time";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const mins = offsetMinutes(offset);
  const shifted = new Date(t + (mins ?? 0) * 60_000).toISOString().slice(0, 16).replace("T", " ");
  return mins === null ? `${shifted} UTC` : shifted;
}

function unscored(state: ScoreState): string | null {
  if (state === "PENDING_SCORE") return "not scored yet";
  if (state === "UNSCORABLE") return "could not be scored";
  return null;
}

export function recoveryText(r: Recovery): string {
  const s = r.score;
  if (!s || r.score_state !== "SCORED") return unscored(r.score_state) ?? "no score";
  const parts = [
    `recovery ${round(s.recovery_score, 0)}%`,
    `resting heart rate ${bpm(s.resting_heart_rate)}`,
    `heart rate variability (RMSSD) ${round(s.hrv_rmssd_milli)} milliseconds`,
  ];
  if (typeof s.spo2_percentage === "number") parts.push(`blood oxygen ${round(s.spo2_percentage)}%`);
  if (typeof s.skin_temp_celsius === "number") parts.push(`skin temperature ${round(s.skin_temp_celsius)} degrees Celsius`);
  if (s.user_calibrating) parts.push("still calibrating");
  return parts.join(", ");
}

export const recoveryLine = (r: Recovery) =>
  `- cycle ${r.cycle_id}, sleep ${r.sleep_id} (recorded ${localTime(r.created_at)}): ${recoveryText(r)}`;

export function sleepText(s: Sleep): string {
  const sc = s.score;
  if (!sc || s.score_state !== "SCORED") return unscored(s.score_state) ?? "no score";
  const st = sc.stage_summary;
  const asleep = st.total_light_sleep_time_milli + st.total_slow_wave_sleep_time_milli + st.total_rem_sleep_time_milli;
  const parts = [`${duration(asleep)} asleep of ${duration(st.total_in_bed_time_milli)} in bed`];
  if (typeof sc.sleep_performance_percentage === "number") parts.push(`performance ${round(sc.sleep_performance_percentage, 0)}%`);
  if (typeof sc.sleep_efficiency_percentage === "number") parts.push(`efficiency ${round(sc.sleep_efficiency_percentage, 0)}%`);
  if (typeof sc.sleep_consistency_percentage === "number") parts.push(`consistency ${round(sc.sleep_consistency_percentage, 0)}%`);
  if (typeof sc.respiratory_rate === "number") parts.push(`respiratory rate ${round(sc.respiratory_rate)} breaths per minute`);
  parts.push(
    `light ${duration(st.total_light_sleep_time_milli)}, deep (slow wave) ${duration(st.total_slow_wave_sleep_time_milli)}, REM ${duration(st.total_rem_sleep_time_milli)}, awake ${duration(st.total_awake_time_milli)}`,
  );
  parts.push(`${st.sleep_cycle_count} sleep cycles, ${st.disturbance_count} disturbances`);
  const need = sc.sleep_needed;
  if (need) {
    const total = need.baseline_milli + need.need_from_sleep_debt_milli + need.need_from_recent_strain_milli - need.need_from_recent_nap_milli;
    parts.push(`sleep needed ${duration(Math.max(0, total))}`);
  }
  return parts.join("; ");
}

export const sleepLine = (s: Sleep) =>
  `- ${localTime(s.start, s.timezone_offset)} to ${localTime(s.end, s.timezone_offset)}${s.nap ? " (nap)" : ""}, sleep ${s.id}, cycle ${s.cycle_id}: ${sleepText(s)}`;

export function cycleText(c: Cycle): string {
  const s = c.score;
  if (!s || c.score_state !== "SCORED") return unscored(c.score_state) ?? "no score";
  return `strain ${round(s.strain)} (of 21), ${kj(s.kilojoule)}, average heart rate ${bpm(s.average_heart_rate)}, max heart rate ${bpm(s.max_heart_rate)}`;
}

export const cycleLine = (c: Cycle) =>
  `- ${localTime(c.start, c.timezone_offset)} to ${c.end ? localTime(c.end, c.timezone_offset) : "now (ongoing)"}, cycle ${c.id}: ${cycleText(c)}`;

export function workoutText(w: Workout): string {
  const s = w.score;
  if (!s || w.score_state !== "SCORED") return unscored(w.score_state) ?? "no score";
  const parts = [`strain ${round(s.strain)}`, kj(s.kilojoule), `average heart rate ${bpm(s.average_heart_rate)}`, `max heart rate ${bpm(s.max_heart_rate)}`];
  if (typeof s.distance_meter === "number") parts.push(`distance ${thousands(s.distance_meter)} meters`);
  if (typeof s.altitude_gain_meter === "number") parts.push(`climbed ${thousands(s.altitude_gain_meter)} meters`);
  const z = s.zone_durations;
  if (z) {
    const zones = [z.zone_zero_milli, z.zone_one_milli, z.zone_two_milli, z.zone_three_milli, z.zone_four_milli, z.zone_five_milli];
    parts.push(`minutes in heart rate zones 0 to 5: ${zones.map((ms) => Math.round((ms ?? 0) / 60_000)).join(", ")}`);
  }
  if (typeof s.percent_recorded === "number" && s.percent_recorded < 100) parts.push(`${round(s.percent_recorded, 0)}% recorded`);
  return parts.join(", ");
}

export const workoutLine = (w: Workout) =>
  `- ${localTime(w.start, w.timezone_offset)}, ${w.sport_name}, ${duration(Date.parse(w.end) - Date.parse(w.start))}, workout ${w.id}: ${workoutText(w)}`;

export const profileText = (p: Profile) => `WHOOP member ${p.first_name} ${p.last_name} (${p.email}), user id ${p.user_id}.`;

export const bodyText = (b: BodyMeasurement) =>
  `Height ${round(b.height_meter, 2)} meters, weight ${round(b.weight_kilogram)} kilograms, max heart rate ${bpm(b.max_heart_rate)}.`;
