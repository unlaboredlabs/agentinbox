// Test double for server/mail/content-worker.ts: same protocol; a task whose input is "SLOW" busy-waits
// (like a pathological message), anything else answers at once.

import { parentPort } from "node:worker_threads";
import type { ContentTask } from "../server/mail/content-worker.ts";

const port = parentPort!;
port.on("message", (task: ContentTask) => {
  const input = task.kind === "content" ? task.parsed.html : task.kind === "html" ? task.html : task.text;
  if (input === "SLOW") {
    const until = Date.now() + 10_000;
    while (Date.now() < until);
  }
  const result = task.kind === "content" ? { body: `fast:${input}`, truncated: false, totalChars: 0, attachments: [], signals: {} } : task.kind === "html" ? { markdown: "fast", removed: 0 } : "fast";
  port.postMessage({ id: task.id, ok: true, result });
});
port.postMessage({ ready: true });
