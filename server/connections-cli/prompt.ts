import { createInterface } from "node:readline/promises";
import pc from "picocolors";

/** Terminal I/O for the connections wizard; tests pass a scripted one. */
export interface Prompter {
  /** Questions can be asked (a TTY, or a test script). */
  readonly interactive: boolean;
  /** `--yes`: every confirmation is answered yes, and choices take their defaults. */
  readonly assumeYes: boolean;
  print(line?: string): void;
  ask(question: string, def?: string): Promise<string>;
  /** Not echoed. */
  secret(question: string): Promise<string>;
  confirm(question: string, def: boolean): Promise<boolean>;
  choose<T extends string>(question: string, options: { value: T; label: string }[], def: T): Promise<T>;
  close(): void;
}

export class NeedsConfirmation extends Error {
  constructor(what: string) {
    super(`${what} needs a confirmation, and this isn't a terminal. Re-run it in a terminal, or pass --yes.`);
  }
}

abstract class BasePrompter implements Prompter {
  abstract readonly interactive: boolean;
  constructor(readonly assumeYes: boolean) {}
  abstract print(line?: string): void;
  protected abstract line(question: string): Promise<string>;
  protected abstract hidden(question: string): Promise<string>;

  async ask(question: string, def?: string): Promise<string> {
    if (!this.interactive || (this.assumeYes && def !== undefined)) {
      if (def !== undefined) return def;
      throw new NeedsConfirmation(`"${question}"`);
    }
    const answer = (await this.line(`${question}${def ? pc.dim(` (${def})`) : ""}: `)).trim();
    return answer || def || "";
  }

  async secret(question: string): Promise<string> {
    if (!this.interactive) throw new NeedsConfirmation(`"${question}"`);
    return (await this.hidden(`${question}: `)).trim();
  }

  async confirm(question: string, def: boolean): Promise<boolean> {
    if (this.assumeYes) {
      this.print(`${question} ${pc.dim("yes (--yes)")}`);
      return true;
    }
    if (!this.interactive) throw new NeedsConfirmation(question);
    for (;;) {
      const a = (await this.line(`${question} ${pc.dim(def ? "[Y/n]" : "[y/N]")} `)).trim().toLowerCase();
      if (!a) return def;
      if (["y", "yes"].includes(a)) return true;
      if (["n", "no"].includes(a)) return false;
    }
  }

  async choose<T extends string>(question: string, options: { value: T; label: string }[], def: T): Promise<T> {
    if (this.assumeYes || !this.interactive) return def;
    this.print(question);
    options.forEach((o, i) => this.print(`  ${pc.cyan(String(i + 1))}. ${o.label}${o.value === def ? pc.dim("  (default)") : ""}`));
    for (;;) {
      const a = (await this.line(`Choose 1-${options.length}: `)).trim().toLowerCase();
      if (!a) return def;
      const n = Number(a);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]!.value;
      const named = options.find((o) => o.value === a);
      if (named) return named.value;
    }
  }

  close(): void {}
}

/** The real terminal. */
export class TerminalPrompter extends BasePrompter {
  readonly interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;

  print(line = ""): void {
    process.stdout.write(`${line}\n`);
  }

  protected async line(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  }

  protected hidden(question: string): Promise<string> {
    const stdin = process.stdin;
    process.stdout.write(question);
    return new Promise((resolve, reject) => {
      let value = "";
      const wasRaw = stdin.isRaw;
      stdin.setRawMode?.(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      const done = (err?: Error) => {
        stdin.removeListener("data", onData);
        stdin.setRawMode?.(wasRaw);
        stdin.pause();
        process.stdout.write("\n");
        if (err) reject(err);
        else resolve(value);
      };
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === "\r" || ch === "\n") return done();
          if (ch === "\u0003") return done(Object.assign(new Error("Cancelled."), { code: "ABORT_ERR" }));
          if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
          else if (ch >= " ") value += ch;
        }
      };
      stdin.on("data", onData);
    });
  }
}

/** Tests: answers are taken in order; everything printed is kept. */
export class ScriptedPrompter extends BasePrompter {
  readonly interactive = true;
  readonly output: string[] = [];
  readonly asked: string[] = [];
  constructor(
    private readonly answers: string[],
    assumeYes = false,
  ) {
    super(assumeYes);
  }
  print(line = ""): void {
    // eslint-disable-next-line no-control-regex
    this.output.push(line.replace(/\x1b\[[0-9;]*m/g, ""));
  }
  protected async line(question: string): Promise<string> {
    return this.next(question);
  }
  protected async hidden(question: string): Promise<string> {
    return this.next(question);
  }
  private next(question: string): string {
    // eslint-disable-next-line no-control-regex
    this.asked.push(question.replace(/\x1b\[[0-9;]*m/g, ""));
    if (!this.answers.length) throw new Error(`Unexpected question: ${question}`);
    return this.answers.shift()!;
  }
  get text(): string {
    return this.output.join("\n");
  }
}
