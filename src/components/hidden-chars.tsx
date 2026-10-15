import { EyeOffIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

/**
 * Characters a reviewer can't see: zero-width and joiner characters, bidi controls (which reorder
 * what's displayed), invisible operators, BOM, soft hyphen and Unicode tag characters (U+E0000–E007F,
 * used to smuggle hidden text).
 */
const HIDDEN = /\u034F|[\u00AD\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\u{E0000}-\u{E007F}]/gu;

export function hasHidden(...texts: (string | null | undefined)[]): boolean {
  return texts.some((t) => !!t && new RegExp(HIDDEN.source, "u").test(t));
}

const label = (ch: string) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

/** Renders text with every hidden character replaced by a visible ⟨U+XXXX⟩ marker. Plain text only. */
export function Visible({ text, className }: { text: string; className?: string }) {
  if (!hasHidden(text)) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(HIDDEN)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <mark
        key={m.index}
        title="Hidden character"
        className={cn("mx-px rounded-sm bg-critical/15 px-0.5 font-mono text-[0.8em] text-critical not-italic", className)}
      >
        ⟨{label(m[0])}⟩
      </mark>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

export function HiddenCharsWarning({ what = "This message" }: { what?: string }) {
  return (
    <Alert variant="destructive">
      <EyeOffIcon />
      <AlertTitle>{what} contains hidden characters</AlertTitle>
      <AlertDescription>
        Invisible or text-reordering characters are shown below as ⟨U+…⟩. They can hide words or make text read differently than it will be sent.
        Reject unless you know why they're there.
      </AlertDescription>
    </Alert>
  );
}
