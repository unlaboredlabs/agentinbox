// Timing helpers for performance tests that must hold on slow CI runners: linearity is asserted by ratio
// (quadratic work grows 16x when the input grows 4x; linear grows ~4x), absolute bounds only generously.

import { expect } from "vitest";

/** Best of `runs` timings in ms, after one warm-up run. */
export function bestOf(fn: () => unknown, runs = 3): number {
  fn();
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

/** Ratio below which 4x more input counts as linear (quadratic would be ~16). */
export const LINEAR_RATIO = 8;
/** Timings below this are noise; the small run is floored to it before taking the ratio. */
const FLOOR_MS = 2;

/** Asserts that `make(4n)` costs less than LINEAR_RATIO times `make(n)`. */
export function expectLinear(label: string, make: (n: number) => () => unknown, n: number): void {
  const small = bestOf(make(n));
  const large = bestOf(make(4 * n));
  expect(large / Math.max(small, FLOOR_MS), `${label}: ${small.toFixed(1)} ms at n=${n}, ${large.toFixed(1)} ms at 4n`).toBeLessThan(LINEAR_RATIO);
}
