/** Minimal, spec-following text/event-stream parser (https://html.spec.whatwg.org/multipage/server-sent-events.html). */

export interface SseMessage {
  id: string | null;
  event: string;
  data: string;
}

export class SseParser {
  private buf = "";
  private data: string[] = [];
  private event = "";
  private id: string | null = null;

  constructor(
    private readonly onMessage: (m: SseMessage) => void,
    private readonly onComment: (text: string) => void = () => {},
  ) {}

  push(chunk: string): void {
    this.buf += chunk;
    // A lone \r at the end may be the first half of \r\n: keep it for the next chunk.
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buf);
      if (!m) break;
      if (m[0] === "\r" && m.index === this.buf.length - 1) break;
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      this.line(line);
    }
  }

  private line(line: string): void {
    if (line === "") {
      if (this.data.length) this.onMessage({ id: this.id, event: this.event || "message", data: this.data.join("\n") });
      this.data = [];
      this.event = "";
      return;
    }
    if (line.startsWith(":")) {
      this.onComment(line.slice(1).trim());
      return;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.id = value;
    // "retry" is ignored: reconnect timing is ours (jittered backoff).
  }
}
