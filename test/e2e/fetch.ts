// fetch that retries once when a pooled keep-alive socket turns out to be dead. Restart scenarios
// reuse the same port, so undici's pool may hand out a socket to the previous (closed) server;
// browsers transparently retry in that case, and so do we. Real server errors are never retried.

const STALE_SOCKET = new Set(["UND_ERR_SOCKET", "ECONNRESET", "UND_ERR_CLOSED"]);

function staleSocket(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } })?.cause;
  return err instanceof TypeError && !!cause?.code && STALE_SOCKET.has(cause.code);
}

export const resilientFetch: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init);
  } catch (err) {
    if (!staleSocket(err) || init?.signal?.aborted) throw err;
    return fetch(input, init);
  }
};
