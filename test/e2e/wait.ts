/** Polls `fn` until it returns a truthy value (returned) or the timeout passes (throws with `what`). */
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  opts: { timeout?: number; interval?: number; what?: string } = {},
): Promise<NonNullable<T>> {
  const timeout = opts.timeout ?? 8000;
  const interval = opts.interval ?? 50;
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      const why = lastError instanceof Error ? ` (last error: ${lastError.message})` : "";
      throw new Error(`Timed out after ${timeout} ms waiting for ${opts.what ?? "condition"}${why}`);
    }
    await sleep(interval);
  }
}

/** Asserts that `fn` stays falsy for `ms` (for "nothing happens" checks). */
export async function stays<T>(fn: () => T | Promise<T>, ms = 600, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) throw new Error(`Expected ${what} not to happen`);
    await sleep(50);
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
