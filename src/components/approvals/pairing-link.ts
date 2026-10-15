// What Approvals shows for a `?pairing=` link (the CLI's approve link), as a pure function so it can be
// tested directly. No React and relative imports only: vitest and the server/test typecheck load it too.

import type { PairingRequest } from "../../../shared/types.ts";

export type LinkedPairing =
  | { kind: "pending"; p: PairingRequest }
  | { kind: "approved"; p: PairingRequest }
  | { kind: "denied"; p: PairingRequest }
  /** Expired, or not found at all. */
  | { kind: "gone" };

/**
 * The request a link points at, by its code. Codes are reused once a request is denied or expired,
 * so the newest request with the code wins (the list is newest first). After a decision on this page
 * the link stays in the URL, so it says what was decided instead of "isn't waiting anymore".
 */
export function linkedPairing(code: string, pairings: PairingRequest[]): LinkedPairing {
  const pending = pairings.find((p) => p.userCode === code && p.status === "pending");
  if (pending) return { kind: "pending", p: pending };
  const newest = pairings.find((p) => p.userCode === code);
  if (newest?.status === "approved") return { kind: "approved", p: newest };
  if (newest?.status === "denied") return { kind: "denied", p: newest };
  return { kind: "gone" };
}

/** The toast after a deny: mentions the note only when one was written. */
export function deniedDescription(note: string | null | undefined): string {
  return note?.trim() ? "The agent's terminal shows that it was denied, with your note." : "The agent's terminal shows that it was denied.";
}
