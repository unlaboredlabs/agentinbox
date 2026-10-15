// Test double for server/mail/content-worker.ts (plain JS so it loads on every supported Node): same
// protocol; a task whose input is "SLOW" busy-waits like a pathological message, anything else answers at once.

import { parentPort } from "node:worker_threads";

const port = parentPort;
port.on("message", (task) => {
  const input = task.kind === "content" ? task.parsed.html : task.kind === "html" ? task.html : task.text;
  if (input === "SLOW") {
    const until = Date.now() + 10_000;
    while (Date.now() < until);
  }
  const result =
    task.kind === "content"
      ? { body: `fast:${input}`, truncated: false, totalChars: 0, attachments: [], signals: {} }
      : task.kind === "html"
        ? { markdown: "fast", removed: 0 }
        : "fast";
  port.postMessage({ id: task.id, ok: true, result });
});
port.postMessage({ ready: true });
