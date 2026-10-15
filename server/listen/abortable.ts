/**
 * Settles with `p`, or rejects as soon as `signal` aborts, whichever comes first. undici (Node 22.13
 * ships 6.21.0) doesn't always settle a fetch or a body read when its signal aborts under load
 * (nodejs/undici#4089), which left a stopped listener waiting forever; with this, abort always wins.
 */
export function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => {});
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
