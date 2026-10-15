import pc from "picocolors";

/** Visible width of a string (ignores ANSI colour codes). */
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

/** Draws a rounded box around lines of text. */
export function box(lines: string[], color: (s: string) => string = pc.cyan): string {
  const width = Math.max(...lines.map(visible));
  const top = color(`╭${"─".repeat(width + 4)}╮`);
  const bottom = color(`╰${"─".repeat(width + 4)}╯`);
  const body = lines.map((l) => `${color("│")}  ${l}${" ".repeat(width - visible(l))}  ${color("│")}`);
  return [top, ...body, bottom].join("\n");
}

/** Makes untrusted text (email subjects, senders, command output) safe to print to a terminal: no escape sequences or control characters. */
export const safeText = (s: string, max = 200): string => {
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
};

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * A one-line status that redraws in place on a TTY. Without a TTY (CI, an agent capturing output,
 * a log file) it prints a plain line only when the text changes meaningfully, at most every `plainEveryMs`.
 */
export class StatusLine {
  private frame = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastPlain = 0;
  private text = "";
  constructor(
    private readonly out: NodeJS.WriteStream = process.stderr,
    private readonly plainEveryMs = 30_000,
  ) {}

  get tty(): boolean {
    return !!this.out.isTTY && !process.env.CI;
  }

  start(render: () => string): void {
    const tick = () => {
      this.text = render();
      if (this.tty) {
        this.out.write(`\r\x1b[2K${pc.cyan(FRAMES[this.frame++ % FRAMES.length]!)} ${this.text}`);
      } else if (Date.now() - this.lastPlain >= this.plainEveryMs) {
        this.lastPlain = Date.now();
        this.out.write(`${this.text}\n`);
      }
    };
    tick();
    this.timer = setInterval(tick, this.tty ? 100 : 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.tty) this.out.write("\r\x1b[2K");
  }
}
