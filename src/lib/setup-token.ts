// The first-run claim page's token handling (src/routes/setup.tsx), kept free of React so it can be
// tested: what a pasted value means, and what the page shows for each state of the token check.

export type TokenCheck = { status: "idle" } | { status: "checking" } | { status: "ok" } | { status: "error"; error: unknown };

/**
 * The setup token in what the user pasted: a whole setup link (…/setup?token=…), just its query
 * (?token=… or token=…), or the bare token.
 */
export function tokenFromInput(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  try {
    const fromUrl = new URL(text).searchParams.get("token");
    if (fromUrl !== null) return fromUrl.trim();
  } catch {
    // Not a full URL.
  }
  const query = /(?:^|[?&])token=([^&#\s]*)/.exec(text);
  if (query) {
    try {
      return decodeURIComponent(query[1]!).trim();
    } catch {
      return query[1]!.trim();
    }
  }
  return text;
}

export interface ClaimView {
  /**
   * - checking: asking the server about the token
   * - verified: ask for the password
   * - enter-token: show the token field (with `tokenError` when the last check failed)
   * - claimed: someone already set the instance up; point to sign-in
   */
  phase: "checking" | "verified" | "enter-token" | "claimed";
  /** Text of the page's one status line ("" when there is nothing to announce). */
  status: string;
  tokenError?: string;
  submitLabel: string;
}

const errorParts = (err: unknown): { status?: number; code?: string; message: string } => {
  const e = (err ?? {}) as { status?: unknown; code?: unknown; message?: unknown };
  return {
    status: typeof e.status === "number" ? e.status : undefined,
    code: typeof e.code === "string" ? e.code : undefined,
    message: typeof e.message === "string" ? e.message : String(err),
  };
};

/** What the claim page shows. `fromLink`: the token being checked came from the setup link the page was opened with. */
export function claimView(check: TokenCheck, fromLink: boolean): ClaimView {
  const what = fromLink ? "link" : "token";
  switch (check.status) {
    case "checking":
      return { phase: "checking", status: `Checking the setup ${what}…`, submitLabel: "Continue" };
    case "ok":
      return { phase: "verified", status: `Setup ${what} verified.`, submitLabel: "Create admin password" };
    case "idle":
      return { phase: "enter-token", status: "", submitLabel: "Continue" };
    case "error": {
      const e = errorParts(check.error);
      if (e.status === 409) return { phase: "claimed", status: "This instance is already set up.", submitLabel: "Continue" };
      const tokenError =
        e.code === "invalid_token"
          ? fromLink
            ? "This setup link isn't valid. It may be incomplete (copy the whole link) or from before a reset-password."
            : "That setup token isn't valid. Paste the whole setup link from the terminal, or the token after ?token=."
          : e.message;
      return { phase: "enter-token", status: "", tokenError, submitLabel: "Continue" };
    }
  }
}

/** The error the page shows when Continue is pressed with nothing pasted. */
export const EMPTY_TOKEN = new Error("Paste the setup link or token from the terminal.");
