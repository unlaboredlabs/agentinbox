/**
 * Heuristic catastrophic-backtracking check for webhook subject patterns. Filters run synchronously
 * on attacker-controlled subjects during events.emit, and no linear-time regex engine is available,
 * so risky shapes are refused at validation time:
 * - a repeated group that itself contains a repetition: (a+)+, (.*\s*)*, (x{2,})*
 * - a repeated group with alternatives, which may overlap: (a|a)*, (re:\s*|fwd?:\s*)*
 * - adjacent repetitions that can match the same text: \w*\w*, .*\s+, a+a*
 * - more than MAX_UNBOUNDED unbounded repetitions in total (bounds polynomial blowup)
 * Returns a human-readable reason, or null when the pattern looks safe.
 */
export function regexRisk(pattern: string): string | null {
  try {
    const p = new Parser(pattern);
    p.sequence();
    if (p.unbounded > MAX_UNBOUNDED) return `uses more than ${MAX_UNBOUNDED} open-ended repetitions (*, +, {n,})`;
    return null;
  } catch (err) {
    if (err instanceof Risk) return err.message;
    throw err;
  }
}

const MAX_UNBOUNDED = 6;

class Risk extends Error {}

interface Quant {
  /** Can repeat more than once. */
  repeats: boolean;
  unbounded: boolean;
  length: number;
}

interface SeqInfo {
  /** Contains any repetition (bounded or not). */
  hasRepeat: boolean;
  hasAlternation: boolean;
}

class Parser {
  i = 0;
  unbounded = 0;

  constructor(private readonly s: string) {}

  /** Parses alternatives until ")" or the end. */
  sequence(): SeqInfo {
    const info: SeqInfo = { hasRepeat: false, hasAlternation: false };
    let prev: { text: string; unbounded: boolean } | null = null;
    while (this.i < this.s.length && this.s[this.i] !== ")") {
      if (this.s[this.i] === "|") {
        info.hasAlternation = true;
        this.i++;
        prev = null;
        continue;
      }
      const start = this.i;
      const atom = this.atom();
      const text = this.s.slice(start, this.i);
      const q = this.quantifier();
      if (q.unbounded) this.unbounded++;
      if (q.repeats) info.hasRepeat = true;
      if (atom.group && q.repeats) {
        if (atom.group.hasRepeat) throw new Risk("repeats a group that already contains a repetition, like (a+)+");
        if (atom.group.hasAlternation && q.unbounded) throw new Risk("repeats a group with alternatives, like (a|b)*");
      }
      if (atom.group?.hasRepeat) info.hasRepeat = true;
      const cur = { text, unbounded: q.unbounded };
      if (prev?.unbounded && cur.unbounded && (prev.text === cur.text || prev.text === "." || cur.text === ".")) {
        throw new Risk(`has adjacent repetitions that overlap (${prev.text} then ${cur.text})`);
      }
      if (!atom.zeroWidth) prev = cur;
    }
    return info;
  }

  private atom(): { group?: SeqInfo; zeroWidth?: boolean } {
    const ch = this.s[this.i]!;
    if (ch === "\\") {
      const next = this.s[this.i + 1];
      this.i += 2;
      return { zeroWidth: next === "b" || next === "B" };
    }
    if (ch === "[") {
      this.i++;
      if (this.s[this.i] === "]") this.i++;
      while (this.i < this.s.length && this.s[this.i] !== "]") this.i += this.s[this.i] === "\\" ? 2 : 1;
      this.i++;
      return {};
    }
    if (ch === "(") {
      this.i++;
      let lookaround = false;
      if (this.s[this.i] === "?") {
        // (?:  (?=  (?!  (?<=  (?<!  (?<name>
        const m = /^\?(?::|=|!|<=|<!|<[^>]*>)/.exec(this.s.slice(this.i));
        if (m) {
          lookaround = /^\?(=|!|<=|<!)/.test(m[0]);
          this.i += m[0].length;
        }
      }
      const group = this.sequence();
      this.i++; // ")"
      return { group, zeroWidth: lookaround };
    }
    this.i++;
    return { zeroWidth: ch === "^" || ch === "$" };
  }

  private quantifier(): Quant {
    const ch = this.s[this.i];
    let q: Quant = { repeats: false, unbounded: false, length: 0 };
    if (ch === "*" || ch === "+") q = { repeats: true, unbounded: true, length: 1 };
    else if (ch === "?") q = { repeats: false, unbounded: false, length: 1 };
    else if (ch === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(this.s.slice(this.i));
      if (m) {
        const min = Number(m[1]);
        const max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
        q = { repeats: max > 1, unbounded: max === Infinity, length: m[0].length };
      }
    }
    this.i += q.length;
    if (q.length && this.s[this.i] === "?") this.i++; // lazy
    return q;
  }
}
