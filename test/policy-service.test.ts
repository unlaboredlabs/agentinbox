import { afterEach, describe, expect, it } from "vitest";
import type { GmailLabel } from "../shared/types.ts";
import { sha256 } from "../server/crypto.ts";
import { disallowedRecipients, labelSearchTerm, querySyntaxError, scopedQuery, threadLabels } from "../server/policy/enforce.ts";
import { grantInput, mailTestContext } from "./mail-fakes.ts";

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

function setup() {
  const t = mailTestContext();
  dispose = t.dispose;
  t.addAccount("acc_a", "me@acme.com");
  t.addAccount("acc_b", "other@acme.com");
  return t;
}

describe("agents and keys", () => {
  it("creates agents with a hashed aib_ key shown once", () => {
    const { ctx } = setup();
    const { agent, apiKey } = ctx.policy.createAgent({ name: "  Support bot ", description: "triage", grants: [grantInput("acc_a")] });
    expect(apiKey).toMatch(/^aib_[0-9a-z]{32}$/);
    expect(agent.keyPrefix).toBe(apiKey.slice(0, 8));
    expect(agent.name).toBe("Support bot");
    expect(agent.grants).toHaveLength(1);
    const row = ctx.db.get<{ key_hash: string }>("SELECT key_hash FROM agents WHERE id = ?", agent.id)!;
    expect(row.key_hash).toBe(sha256(apiKey));
    expect(JSON.stringify(ctx.policy.getAgent(agent.id))).not.toContain(apiKey);
    expect(ctx.audit.list({ action: "agent.create" }).items[0]!.target).toBe(agent.id);
  });

  it("authenticates keys, rejects unknown/disabled ones and throttles last_used_at writes", () => {
    const { ctx } = setup();
    const { agent, apiKey } = ctx.policy.createAgent({ name: "a" });
    expect(ctx.policy.authenticate(apiKey)).toEqual({ agentId: agent.id, name: "a" });
    const first = ctx.policy.getAgent(agent.id)!.lastUsedAt;
    expect(first).not.toBeNull();
    ctx.policy.authenticate(apiKey);
    expect(ctx.policy.getAgent(agent.id)!.lastUsedAt).toBe(first);
    ctx.db.run("UPDATE agents SET last_used_at = ? WHERE id = ?", new Date(Date.now() - 120_000).toISOString(), agent.id);
    ctx.policy.authenticate(apiKey);
    expect(Date.parse(ctx.policy.getAgent(agent.id)!.lastUsedAt!)).toBeGreaterThan(Date.now() - 5_000);

    expect(ctx.policy.authenticate("aib_" + "0".repeat(32))).toBeNull();
    expect(ctx.policy.authenticate("not-a-key")).toBeNull();
    ctx.policy.updateAgent(agent.id, { disabled: true });
    expect(ctx.policy.authenticate(apiKey)).toBeNull();
  });

  it("rotates keys so the old one stops working", () => {
    const { ctx } = setup();
    const { agent, apiKey } = ctx.policy.createAgent({ name: "a" });
    const rotated = ctx.policy.rotateKey(agent.id);
    expect(rotated.apiKey).not.toBe(apiKey);
    expect(ctx.policy.authenticate(apiKey)).toBeNull();
    expect(ctx.policy.authenticate(rotated.apiKey)?.agentId).toBe(agent.id);
    expect(rotated.agent.keyPrefix).toBe(rotated.apiKey.slice(0, 8));
  });

  it("updates and deletes agents, auditing each change", () => {
    const { ctx } = setup();
    const { agent } = ctx.policy.createAgent({ name: "a", grants: [grantInput("acc_a")] });
    expect(ctx.policy.updateAgent(agent.id, { name: "b", description: null }).name).toBe("b");
    expect(() => ctx.policy.updateAgent(agent.id, { name: " " })).toThrow(/Name/);
    ctx.policy.deleteAgent(agent.id);
    expect(ctx.policy.getAgent(agent.id)).toBeNull();
    expect(ctx.policy.grants(agent.id)).toEqual([]);
    expect(() => ctx.policy.deleteAgent(agent.id)).toThrow(/not found/);
    const actions = ctx.audit.list().items.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["agent.create", "agent.update", "agent.delete"]));
  });
});

describe("grants", () => {
  it("upserts one grant per agent × account and audits", () => {
    const { ctx } = setup();
    const { agent } = ctx.policy.createAgent({ name: "a" });
    const g1 = ctx.policy.upsertGrant(agent.id, "acc_a", grantInput("acc_a", { capabilities: ["send", "read", "read"], sendMode: "approval" }));
    expect(g1.capabilities).toEqual(["read", "send"]);
    const g2 = ctx.policy.upsertGrant(agent.id, "acc_a", grantInput("acc_a", { allowTo: [" *@Acme.com "], maxSendsPerDay: 5 }));
    expect(g2.id).toBe(g1.id);
    expect(g2.allowTo).toEqual(["*@acme.com"]);
    expect(g2.maxSendsPerDay).toBe(5);
    expect(ctx.policy.grants(agent.id)).toHaveLength(1);
    expect(ctx.policy.grant(agent.id, "acc_a")?.sendMode).toBe("direct");
    ctx.policy.deleteGrant(agent.id, "acc_a");
    expect(ctx.policy.grant(agent.id, "acc_a")).toBeNull();
    expect(() => ctx.policy.deleteGrant(agent.id, "acc_a")).toThrow(/not found/);
    const audited = ctx.audit.list().items.filter((e) => e.action.startsWith("grant."));
    expect(audited.map((e) => e.action)).toEqual(["grant.delete", "grant.upsert", "grant.upsert"]);
    expect(audited[0]!.accountId).toBe("acc_a");
  });

  it.each([
    ["unknown capability", { capabilities: ["read", "admin"] }],
    ["no capabilities", { capabilities: [] }],
    ["empty label scope", { labelScope: [] }],
    ["bad send mode", { sendMode: "yolo" }],
    ["malformed glob", { allowTo: ["not an address"] }],
    ["glob without domain", { allowTo: ["alice@"] }],
    ["zero cap", { maxSendsPerHour: 0 }],
    ["fractional cap", { maxSendsPerDay: 1.5 }],
  ])("rejects %s", (_name, patch) => {
    const { ctx } = setup();
    const { agent } = ctx.policy.createAgent({ name: "a" });
    expect(() => ctx.policy.upsertGrant(agent.id, "acc_a", { ...grantInput("acc_a"), ...(patch as object) })).toThrow(/Invalid grant/);
  });

  it("rejects unknown accounts, duplicate accounts and mismatched ids", () => {
    const { ctx } = setup();
    const { agent } = ctx.policy.createAgent({ name: "a" });
    expect(() => ctx.policy.upsertGrant(agent.id, "acc_nope", grantInput("acc_nope"))).toThrow(/Account acc_nope not found/);
    expect(() => ctx.policy.upsertGrant(agent.id, "acc_a", grantInput("acc_b"))).toThrow(/does not match/);
    expect(() => ctx.policy.createAgent({ name: "b", grants: [grantInput("acc_a"), grantInput("acc_a")] })).toThrow(/one grant per account/);
    expect(ctx.policy.listAgents()).toHaveLength(1);
  });

  it("accepts well-formed globs", () => {
    const { ctx } = setup();
    const { agent } = ctx.policy.createAgent({ name: "a" });
    const g = ctx.policy.upsertGrant(agent.id, "acc_a", grantInput("acc_a", { allowTo: ["alice@example.com", "*@example.com", "billing@*", "*@*.corp.example"] }));
    expect(g.allowTo).toHaveLength(4);
    expect(disallowedRecipients(g, ["bob@example.com", "billing@vendor.io", "x@eu.corp.example", "eve@evil.com"])).toEqual(["eve@evil.com"]);
  });
});

describe("canSeeEvent", () => {
  it("requires read, honours thread-level label scope and passes account events", () => {
    const { ctx } = setup();
    const { agent: scoped } = ctx.policy.createAgent({ name: "s", grants: [grantInput("acc_a", { labelScope: ["Label_support"] })] });
    const { agent: noRead } = ctx.policy.createAgent({ name: "n", grants: [grantInput("acc_a", { capabilities: ["send"] })] });
    const { agent: full } = ctx.policy.createAgent({ name: "f", grants: [grantInput("acc_a")] });
    const ev = (type: "message.received" | "sync.gap" | "account.auth_failed", labels: string[], accountId = "acc_a") => ({ accountId, type, threadLabelIds: labels });

    expect(ctx.policy.canSeeEvent(scoped.id, ev("message.received", ["INBOX", "Label_support"]))).toBe(true);
    expect(ctx.policy.canSeeEvent(scoped.id, ev("message.received", ["INBOX"]))).toBe(false);
    expect(ctx.policy.canSeeEvent(scoped.id, ev("sync.gap", []))).toBe(true);
    expect(ctx.policy.canSeeEvent(scoped.id, ev("account.auth_failed", []))).toBe(true);
    expect(ctx.policy.canSeeEvent(scoped.id, ev("message.received", ["Label_support"], "acc_b"))).toBe(false);
    expect(ctx.policy.canSeeEvent(noRead.id, ev("message.received", ["INBOX"]))).toBe(false);
    expect(ctx.policy.canSeeEvent(noRead.id, ev("sync.gap", []))).toBe(false);
    expect(ctx.policy.canSeeEvent(full.id, ev("message.received", []))).toBe(true);
    ctx.policy.updateAgent(full.id, { disabled: true });
    expect(ctx.policy.canSeeEvent(full.id, ev("message.received", []))).toBe(false);
  });
});

describe("query scoping", () => {
  const labels: GmailLabel[] = [
    { id: "INBOX", name: "INBOX", type: "system" },
    { id: "CATEGORY_UPDATES", name: "CATEGORY_UPDATES", type: "system" },
    { id: "Label_1", name: "Support", type: "user" },
    { id: "Label_2", name: "Clients/Big Co", type: "user" },
    { id: "Label_3", name: 'Odd "quoted"', type: "user" },
  ];

  it("maps labels to search terms", () => {
    expect(labelSearchTerm(labels[0]!)).toBe("in:inbox");
    expect(labelSearchTerm(labels[1]!)).toBe("category:updates");
    expect(labelSearchTerm(labels[2]!)).toBe("label:Support");
    expect(labelSearchTerm(labels[3]!)).toBe('label:"Clients/Big Co"');
    expect(labelSearchTerm(labels[4]!)).toBe('label:"Odd quoted"');
  });

  it("ANDs the scope onto the user query", () => {
    expect(scopedQuery("from:bob", null, labels)).toBe("from:bob");
    expect(scopedQuery("from:bob OR from:eve", ["Label_1"], labels)).toBe("(from:bob OR from:eve) label:Support");
    expect(scopedQuery("", ["Label_1", "INBOX"], labels)).toBe("(label:Support OR in:inbox)");
    expect(scopedQuery("x", ["Label_gone"], labels)).toBeNull();
  });

  it("rejects queries that could escape the wrapping group", () => {
    expect(querySyntaxError('subject:"a (b" (x OR y) {c d}')).toBeNull();
    expect(querySyntaxError("x) OR (label:secret")).toMatch(/closing/);
    expect(querySyntaxError("(x")).toMatch(/opening/);
    expect(querySyntaxError('subject:"open')).toMatch(/quote/);
    expect(querySyntaxError("a } OR {b")).toMatch(/closing/);
  });

  it("computes thread-level label unions", () => {
    expect(threadLabels({ messages: [{ labelIds: ["A"] }, { labelIds: ["B", "A"] }, {}] }).sort()).toEqual(["A", "B"]);
  });
});
