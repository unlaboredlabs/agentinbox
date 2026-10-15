// Where long commands and URLs may wrap (pure, unit-tested; rendered by <Wrapped> in components/common).

// Soft wrap points inside a long token: after URL separators (/ ? & ,), never after a hyphen or "="
// (so `--set-as-default`, `--project=agentinbox-123456` stay whole) and never between "//".
const SOFT_BREAK = /(?<=[/?&,])(?=[^/])/;

/** One entry per whitespace run or token; each token split into unbreakable segments. */
export type WrapPart = { space: string } | { segments: string[] };

export function wrapParts(text: string): WrapPart[] {
  return text
    .split(/(\s+)/)
    .filter((tok) => tok !== "")
    .map((tok) => (/^\s+$/.test(tok) ? { space: tok } : { segments: tok.split(SOFT_BREAK) }));
}
