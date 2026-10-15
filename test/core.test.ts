import { afterEach, describe, expect, it } from "vitest";
import { matchesAnyGlob, matchesGlob } from "../server/util/glob.ts";
import { testContext } from "./helpers.ts";

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

describe("settings", () => {
  it("returns defaults and validates updates", () => {
    const t = testContext();
    dispose = t.dispose;
    const s = t.ctx.settings;
    expect(s.get().ingestMode).toBe("poll");
    expect(s.update({ publicUrl: "https://mail.example.com/" }).publicUrl).toBe("https://mail.example.com");
    expect(() => s.update({ publicUrl: "not a url" })).toThrow(/full URL/);
    expect(() => s.update({ pollIntervalSeconds: 1 })).toThrow(/Poll interval/);
    expect(s.update({ webhookAllowlist: [" 10.0.0.0/8 ", "10.0.0.0/8"] }).webhookAllowlist).toEqual(["10.0.0.0/8"]);
    s.setState("admin.passwordHash", "x");
    expect(s.getState("admin.passwordHash")).toBe("x");
  });
});

describe("audit", () => {
  it("records, emits and pages newest first", () => {
    const t = testContext();
    dispose = t.dispose;
    const seen: string[] = [];
    t.ctx.bus.on("audit", (e) => seen.push(e.action));
    for (let i = 0; i < 5; i++) t.ctx.audit.record({ actorType: "admin", action: `a${i}`, outcome: "ok" });
    t.ctx.audit.record({ actorType: "system", action: "x", outcome: "denied", reason: "rate_limit" });
    expect(seen).toHaveLength(6);
    const p1 = t.ctx.audit.list({ limit: 4 });
    expect(p1.items.map((e) => e.action)).toEqual(["x", "a4", "a3", "a2"]);
    expect(p1.items[1]!.actorName).toBe("admin");
    const p2 = t.ctx.audit.list({ limit: 4, cursor: p1.nextCursor });
    expect(p2.items.map((e) => e.action)).toEqual(["a1", "a0"]);
    expect(p2.nextCursor).toBeNull();
    expect(t.ctx.audit.list({ outcome: "denied" }).items[0]!.reason).toBe("rate_limit");
  });
});

describe("glob", () => {
  it("matches address globs case-insensitively", () => {
    expect(matchesGlob("Bob@Example.com", "*@example.com")).toBe(true);
    expect(matchesGlob("bob@example.com.evil", "*@example.com")).toBe(false);
    expect(matchesGlob("a+b@x.io", "a+b@x.io")).toBe(true);
    expect(matchesAnyGlob("c@y.io", ["a@x.io", "*@y.io"])).toBe(true);
  });
});
