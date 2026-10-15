// The first-run claim page (src/routes/setup.tsx): what a pasted value means and what each state of
// the token check shows. The page renders exactly these views.
import { describe, expect, it } from "vitest";
import { claimView, EMPTY_TOKEN, tokenFromInput } from "../src/lib/setup-token.ts";

const apiError = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });

describe("tokenFromInput", () => {
  it("takes the token out of a whole setup link, its query, or the bare token", () => {
    expect(tokenFromInput("abc123")).toBe("abc123");
    expect(tokenFromInput("  abc123 \n")).toBe("abc123");
    expect(tokenFromInput("http://127.0.0.1:8425/setup?token=abc123")).toBe("abc123");
    expect(tokenFromInput("https://mail.example.com/setup?x=1&token=abc123#top")).toBe("abc123");
    expect(tokenFromInput("?token=abc123")).toBe("abc123");
    expect(tokenFromInput("token=abc123")).toBe("abc123");
    expect(tokenFromInput("/setup?token=abc%20123")).toBe("abc 123");
    // A URL without a token stays as typed (the server says it's wrong).
    expect(tokenFromInput("https://mail.example.com/setup")).toBe("https://mail.example.com/setup");
    expect(tokenFromInput("")).toBe("");
  });
});

describe("claimView", () => {
  it("checks a setup link first, then asks for the password", () => {
    expect(claimView({ status: "checking" }, true)).toEqual({ phase: "checking", status: "Checking the setup link…", submitLabel: "Continue" });
    expect(claimView({ status: "ok" }, true)).toEqual({ phase: "verified", status: "Setup link verified.", submitLabel: "Create admin password" });
    expect(claimView({ status: "ok" }, false).status).toBe("Setup token verified.");
  });

  it("shows the token field, without the password, when there is no link or it's wrong", () => {
    expect(claimView({ status: "idle" }, false)).toEqual({ phase: "enter-token", status: "", submitLabel: "Continue" });
    const wrongLink = claimView({ status: "error", error: apiError(403, "invalid_token", "This setup token isn't valid") }, true);
    expect(wrongLink.phase).toBe("enter-token");
    expect(wrongLink.tokenError).toMatch(/^This setup link isn't valid/);
    const wrongToken = claimView({ status: "error", error: apiError(403, "invalid_token", "This setup token isn't valid") }, false);
    expect(wrongToken.tokenError).toMatch(/^That setup token isn't valid/);
    // Other failures (expired link, lockout) show the server's message.
    const expired = claimView({ status: "error", error: apiError(403, "setup_token_expired", "This setup link is no longer valid") }, true);
    expect(expired).toMatchObject({ phase: "enter-token", tokenError: "This setup link is no longer valid" });
    const locked = claimView({ status: "error", error: apiError(429, "locked_out", "Too many failed attempts. Try again in 15 minutes.") }, false);
    expect(locked.tokenError).toMatch(/Too many failed attempts/);
    expect(claimView({ status: "error", error: EMPTY_TOKEN }, false).tokenError).toBe("Paste the setup link or token from the terminal.");
  });

  it("points to sign-in when the instance was set up meanwhile", () => {
    expect(claimView({ status: "error", error: apiError(409, "conflict", "This instance is already set up") }, true)).toMatchObject({
      phase: "claimed",
      status: "This instance is already set up.",
    });
  });
});
