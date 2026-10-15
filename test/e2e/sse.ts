// Minimal SSE reader for the console stream (/api/events/stream), as the browser's EventSource would see it.

import type { ConsoleStreamMessage } from "../../shared/types.ts";
import { resilientFetch } from "./fetch.ts";
import { waitFor } from "./wait.ts";

export interface SseStream {
  messages: ConsoleStreamMessage[];
  /** Comment lines (": connected", ": ping"). */
  comments: string[];
  status: number;
  /** Resolves with the first message (already received or future) matching `pred`. */
  next<K extends ConsoleStreamMessage["kind"]>(
    kind: K,
    pred?: (data: Extract<ConsoleStreamMessage, { kind: K }>["data"]) => boolean,
    timeout?: number,
  ): Promise<Extract<ConsoleStreamMessage, { kind: K }>["data"]>;
  close(): void;
}

export async function openSse(url: string, headers: Record<string, string>): Promise<SseStream> {
  const ctrl = new AbortController();
  const res = await resilientFetch(url, { headers: { accept: "text/event-stream", ...headers }, signal: ctrl.signal });
  const stream: SseStream = {
    messages: [],
    comments: [],
    status: res.status,
    next: (async (kind: string, pred?: (data: unknown) => boolean, timeout = 8000) => {
      const found = await waitFor(() => stream.messages.find((m) => m.kind === kind && (!pred || pred(m.data))), {
        timeout,
        what: `SSE ${kind} message`,
      });
      return found.data;
    }) as SseStream["next"],
    close: () => ctrl.abort(),
  };
  if (!res.ok || !res.body) return stream;

  void (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) stream.comments.push(line.slice(1).trim());
            else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          }
          if (data.length) stream.messages.push(JSON.parse(data.join("\n")) as ConsoleStreamMessage);
        }
      }
    } catch {
      // aborted
    }
  })();
  // The server writes ": connected" first; wait for it so listeners are registered before the test acts.
  await waitFor(() => stream.comments.includes("connected"), { timeout: 3000, what: "SSE connected comment" });
  return stream;
}
