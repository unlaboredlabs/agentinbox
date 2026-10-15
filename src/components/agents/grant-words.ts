import type { Capability, SendMode } from "../../../shared/types.ts";

const join = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/**
 * A grant in plain words. "Send" with the draft_only mode never reads as sending: it says the
 * agent can save drafts and can't send ("Read and draft" → "Can read and save drafts; can't send").
 */
export function grantInWords(g: { capabilities: Capability[]; sendMode: SendMode }): string {
  const caps = new Set(g.capabilities);
  const sends = caps.has("send") && g.sendMode !== "draft_only";
  const can: string[] = [];
  if (caps.has("read")) can.push("read");
  if (caps.has("draft") || (caps.has("send") && !sends)) can.push("save drafts");
  if (caps.has("organize")) can.push("organize");
  if (caps.has("trash")) can.push("trash");
  if (sends) can.push(g.sendMode === "approval" ? "send once you approve" : "send");
  if (!can.length) return "No access";
  if (can.length === 1 && can[0] === "read") return "Can read; can't change or send anything";
  return `Can ${join(can)}${sends ? "" : "; can't send"}`;
}
