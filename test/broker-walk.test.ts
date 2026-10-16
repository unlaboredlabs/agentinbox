// The new-user walk's broker fixes: pairing an agent on an install with no Gmail, "All agents" covering agents
// created later, a killed connection's tools leaving tools/list, and "Refresh tools".

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import type { PairingStart } from "../shared/agent-api.ts";
import { agentApi } from "../server/agentapi/index.ts";
import type { AppContext } from "../server/context.ts";
import { buildMcpServer } from "../server/mcp/server.ts";
import { CSRF, type Harness, harness, json } from "./platform-helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

async function setup() {
  h = harness();
  agentApi(h.ctx, {});
  const cookie = await h.claim();
  h.ctx.settings.update({ brokerUpstreams: true });
  const api = (path: string, init: RequestInit & { json?: unknown } = {}) => h!.request(`/api${path}`, { cookie, ...init, headers: { ...CSRF, ...(init.headers as object) } });
  return { h, ctx: h.ctx, api };
}

/** A Notion connection whose tools are already pinned (no upstream needed). Loopback URL: never dialled here. */
async function notion(s: Awaited<ReturnType<typeof setup>>, body: Record<string, unknown> = {}) {
  const res = await s.api("/connections", { method: "POST", json: { url: "http://127.0.0.1:9/mcp", slug: "notion", name: "Notion", levelDefault: "ask", ...body } });
  expect(res.status).toBe(201);
  const con = await json(res);
  s.ctx.broker.catalog.applyListing(con.id, {
    tools: [
      { name: "notion-search", description: "Search the workspace.", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } },
      { name: "notion-update-page", description: "Edit a page.", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
    ],
  });
  return con as { id: string; allAgents: boolean };
}

async function toolNames(ctx: AppContext, agentId: string): Promise<string[]> {
  const server = buildMcpServer(ctx, { agentId, name: "agent" });
  const client = new Client({ name: "t", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  const names = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  await server.close();
  return names;
}

describe("All agents", () => {
  it("covers agents created after the connection, at its default level; per-agent edits still work", async () => {
    const s = await setup();
    const con = await notion(s); // no agentIds: "All agents", before any agent exists
    expect(con.allAgents).toBe(true);

    const { agent } = s.ctx.policy.createAgent({ name: "Hermes" });
    expect(s.ctx.db.get("SELECT level FROM connection_grants WHERE agent_id = ? AND connection_id = ?", agent.id, con.id)).toEqual({ level: "ask" });
    expect(await toolNames(s.ctx, agent.id)).toEqual(expect.arrayContaining(["notion__notion-search", "notion__notion-update-page"]));

    // Per agent: read only for this one.
    const grants = await json(await s.api(`/connections/${con.id}/grants`, { method: "PUT", json: { grants: [{ agentId: agent.id, level: "read" }] } }));
    expect(grants).toEqual([expect.objectContaining({ agentId: agent.id, level: "read" })]);
    const names = await toolNames(s.ctx, agent.id);
    expect(names).toContain("notion__notion-search");
    expect(names).not.toContain("notion__notion-update-page");

    // Picked agents only: a later agent gets nothing; turning "All agents" on grants everyone without access.
    const picked = await notion(s, { slug: "wiki", agentIds: [agent.id] });
    expect(picked.allAgents).toBe(false);
    const later = s.ctx.policy.createAgent({ name: "Later" }).agent;
    expect(s.ctx.db.get("SELECT 1 AS x FROM connection_grants WHERE agent_id = ? AND connection_id = ?", later.id, picked.id)).toBeUndefined();
    expect(await json(await s.api(`/connections/${picked.id}`, { method: "PATCH", json: { allAgents: true } }))).toMatchObject({ allAgents: true, agents: 2 });
    expect(s.ctx.db.get("SELECT level FROM connection_grants WHERE agent_id = ? AND connection_id = ?", later.id, picked.id)).toEqual({ level: "ask" });
  });
});

describe("pairing without Gmail", () => {
  it("approves with no mailbox grant and the connection levels chosen on the card; the key works on /mcp", async () => {
    const s = await setup();
    const con = await notion(s);
    const other = await notion(s, { slug: "wiki" });
    const start = await s.h.request("/agent/v1/pairings", { method: "POST", json: { name: "Hermes", client: { tool: "hermes" } } });
    expect(start.status).toBe(200);
    const body = (await start.json()) as PairingStart;
    const pending = (await json(await s.api("/pairings?status=pending"))) as { id: string; userCode: string }[];
    const p = pending.find((x) => x.userCode === body.userCode)!;

    const approved = await s.api(`/pairings/${p.id}/approve`, {
      method: "POST",
      json: { userCode: body.userCode, grants: [], connections: [{ connectionId: con.id, level: "read" }, { connectionId: other.id, level: "none" }] },
    });
    expect(approved.status).toBe(200);
    const agent = await json(approved);
    expect(agent.grants).toEqual([]);
    expect(s.ctx.db.all("SELECT connection_id, level FROM connection_grants WHERE agent_id = ? ORDER BY connection_id", agent.id)).toEqual([{ connection_id: con.id, level: "read" }]);

    // The CLI collects a working key, exactly as with Gmail.
    const poll = await json(await s.h.request("/agent/v1/pairings/poll", { method: "POST", json: { deviceCode: body.deviceCode } }));
    expect(poll).toMatchObject({ status: "approved", agent: { id: agent.id } });
    expect(s.ctx.policy.authenticate(poll.apiKey)?.agentId).toBe(agent.id);
    const names = await toolNames(s.ctx, agent.id);
    expect(names).toContain("notion__notion-search");
    expect(names.some((n) => n.startsWith("wiki__"))).toBe(false);
    // And the listener: a connection grant counts as read access for the stream.
    const stream = await s.h.request("/agent/v1/events/stream?start=now", { headers: { authorization: `Bearer ${poll.apiKey}` } });
    expect(stream.status).toBe(200);
    await stream.body?.cancel();

    // Unknown connection ids are refused.
    const again = await s.h.request("/agent/v1/pairings", { method: "POST", json: { name: "Other" } });
    const b2 = (await again.json()) as PairingStart;
    const p2 = ((await json(await s.api("/pairings?status=pending"))) as { id: string; userCode: string }[]).find((x) => x.userCode === b2.userCode)!;
    expect((await s.api(`/pairings/${p2.id}/approve`, { method: "POST", json: { userCode: b2.userCode, grants: [], connections: [{ connectionId: "con_nope", level: "read" }] } })).status).toBe(400);
  });
});

describe("disabled connections and Refresh tools", () => {
  it("a killed connection's tools leave tools/list; refresh lists again (and reports failure)", async () => {
    const s = await setup();
    const con = await notion(s);
    const { agent } = s.ctx.policy.createAgent({ name: "Hermes" });
    expect(await toolNames(s.ctx, agent.id)).toContain("notion__notion-search");

    // The loopback URL has no private-target allow: the listing fails, and says so.
    const refreshed = await json(await s.api(`/connections/${con.id}/refresh`, { method: "POST" }));
    expect(refreshed).toMatchObject({ ok: false });
    expect(refreshed.error).toBeTruthy();

    expect((await s.api(`/connections/${con.id}/kill`, { method: "POST" })).status).toBe(204);
    expect((await toolNames(s.ctx, agent.id)).some((n) => n.startsWith("notion__"))).toBe(false);
    expect((await s.api(`/connections/${con.id}/refresh`, { method: "POST" })).status).toBe(409);
  });
});
