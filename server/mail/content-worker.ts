// Worker thread for content cleaning (see server/mail/pool.ts). Built as its own entry
// (dist/content-worker.js); in source mode Node loads this .ts file directly.

import { parentPort } from "node:worker_threads";
import type { ParsedMessage } from "../google/types.ts";
import { buildContent, htmlToMarkdown } from "./content.ts";

export type ContentTask =
  | { id: number; kind: "content"; parsed: ParsedMessage; opts: { accountEmail: string; maxChars: number } }
  | { id: number; kind: "html"; html: string };

export type ContentReply = { ready: true } | { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

const port = parentPort;
if (port) {
  port.on("message", (task: ContentTask) => {
    try {
      const result = task.kind === "content" ? buildContent(task.parsed, task.opts) : htmlToMarkdown(task.html);
      port.postMessage({ id: task.id, ok: true, result } satisfies ContentReply);
    } catch (err) {
      port.postMessage({ id: task.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies ContentReply);
    }
  });
  port.postMessage({ ready: true } satisfies ContentReply);
}
