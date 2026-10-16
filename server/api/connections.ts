// /api/connections: the MCP broker's connections admin API (docs/MCP-BROKER.md, routes in shared/types.ts).
// Console session + CSRF like every /api router (server/app.ts). 404 while Settings.brokerUpstreams is off.
// Credentials never cross this boundary: a static header goes in through /connect and is never returned.

import { z } from "zod";
import {
  ACCESS_LEVELS,
  type AccessLevel,
  CONNECTION_KINDS,
  CONNECTION_SLUG_RE,
  type Connection,
  type ConnectionAuthType,
  type ConnectionGrant,
  type ConnectionKind,
  type ConnectionView,
  type HeldToolView,
  type PresetView,
  type StartConnectResult,
  type ToolDiffLine,
  type ToolHeldReason,
  type UpstreamToolDefinition,
} from "../../shared/types.ts";
import { connectionView, getConnection, listConnections, notifyAgent } from "../broker/service.ts";
import type { IntegrationPreset, PresetAuth } from "../broker/types.ts";
import type { AppContext } from "../context.ts";
import { json, now } from "../db/index.ts";
import { Approvals } from "../mail/approvals.ts";
import { badRequest, conflict, HttpError, notFound } from "../util/errors.ts";
import { newId } from "../util/ids.ts";
import { ADMIN_ACTOR, readBody, router } from "./util.ts";

const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((u) => URL.canParse(u) && /^https?:$/.test(new URL(u).protocol), "URL must be a full http(s) URL, e.g. https://mcp.example.com/mcp")
  .refine((u) => !URL.canParse(u) || (!new URL(u).username && !new URL(u).password), "URL must not contain credentials; add them when connecting instead");
const slug = z.string().trim().regex(CONNECTION_SLUG_RE, "Slug must be 1-24 lowercase letters, digits or dashes");
const name = z.string().trim().min(1, "Name is required").max(100, "Name must be at most 100 characters");
const level = z.enum(ACCESS_LEVELS);

const createSchema = z
  .object({
    preset: z.string().min(1).max(64).optional(),
    url: httpUrl.optional(),
    name: name.optional(),
    slug: slug.optional(),
    levelDefault: level.optional(),
    agentIds: z.array(z.string().min(1)).max(1000).optional(),
  })
  .strict();

const patchSchema = z.object({ name: name.optional(), slug: slug.optional(), url: httpUrl.optional(), levelDefault: level.optional() }).strict();
const grantsSchema = z.object({ grants: z.array(z.object({ agentId: z.string().min(1), level })).max(1000) }).strict();
const privateTargetSchema = z.object({ allow: z.boolean() }).strict();
const probeSchema = z.object({ url: httpUrl, connectionId: z.string().optional() }).strict();
const connectSchema = z
  .object({
    header: z.object({ name: z.string().trim().regex(/^[A-Za-z0-9-]{1,100}$/, "Header name must be letters, digits or dashes"), value: z.string().min(1).max(8192) }).strict().optional(),
    inputs: z.record(z.string().max(100), z.string().max(8192)).optional(),
  })
  .strict();

const authTypeOf = (a: PresetAuth): ConnectionAuthType => (a.type === "none" ? "none" : a.type === "header" ? "header" : "oauth");

/** `scheme://host:port` of a URL, with the default port spelled out (the private-target allow is pinned to it). */
export function exactOrigin(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
}

/** A free slug from a host or preset slug: lowercase, dashes, at most 24, suffixed -2, -3… on collision. */
function freeSlug(ctx: AppContext, base: string): string {
  const root = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "mcp";
  const taken = (s: string) => !!ctx.db.get("SELECT 1 FROM connections WHERE slug = ?", s);
  if (!taken(root)) return root;
  for (let i = 2; ; i++) if (!taken(`${root}-${i}`)) return `${root}-${i}`;
}

/** Line diff of two pretty-printed definitions (LCS; small inputs). */
export function definitionDiff(before: UpstreamToolDefinition | null, after: UpstreamToolDefinition): ToolDiffLine[] {
  const a = before ? JSON.stringify(before, null, 2).split("\n") : [];
  const b = JSON.stringify(after, null, 2).split("\n");
  if (a.length * b.length > 4_000_000) return [...a.map((text) => ({ op: "-" as const, text })), ...b.map((text) => ({ op: "+" as const, text }))];
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const out: ToolDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: " ", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ op: "-", text: a[i++]! });
    else out.push({ op: "+", text: b[j++]! });
  }
  while (i < a.length) out.push({ op: "-", text: a[i++]! });
  while (j < b.length) out.push({ op: "+", text: b[j++]! });
  return out;
}

export function connectionsApi(ctx: AppContext) {
  const app = router();
  const approvals = new Approvals(ctx);
  const audit = (action: string, target: string, detail: Record<string, unknown> | null = null) =>
    ctx.audit.record({ ...ADMIN_ACTOR, action, target, outcome: "ok", detail });

  // Everything here is the unreleased broker: invisible until the setting is on.
  const gate = async (_c: unknown, next: () => Promise<void>) => {
    if (!ctx.broker.enabled()) throw new HttpError(404, "not_found", "No such API route");
    await next();
  };
  app.use("/connections", gate);
  app.use("/connections/*", gate);

  const requireConnection = (id: string): Connection => {
    const c = getConnection(ctx, id);
    if (!c) throw notFound("Connection");
    return c;
  };
  const view = (id: string): ConnectionView => connectionView(ctx, requireConnection(id));
  const grantsOf = (connectionId: string): ConnectionGrant[] =>
    ctx.db
      .all<{ agent_id: string; level: AccessLevel; created_at: string; updated_at: string }>(
        "SELECT agent_id, level, created_at, updated_at FROM connection_grants WHERE connection_id = ? ORDER BY created_at, agent_id",
        connectionId,
      )
      .map((r) => ({ agentId: r.agent_id, connectionId, level: r.level, createdAt: r.created_at, updatedAt: r.updated_at }));
  const requireAgents = (ids: string[]) => {
    const missing = ids.filter((id) => !ctx.db.get("SELECT 1 FROM agents WHERE id = ?", id));
    if (missing.length) throw badRequest(`Unknown agent ${missing.join(", ")}`);
  };
  const heldOf = (connectionId: string): HeldToolView[] =>
    ctx.db
      .all<{ name: string; exposed_name: string; held_reason: ToolHeldReason; definition: string | null; candidate_definition: string; updated_at: string }>(
        "SELECT name, exposed_name, held_reason, definition, candidate_definition, updated_at FROM upstream_tools WHERE connection_id = ? AND state = 'held' ORDER BY name",
        connectionId,
      )
      .map((r) => {
        const pinned = json.parse<UpstreamToolDefinition | null>(r.definition, null);
        const candidate = json.parse<UpstreamToolDefinition>(r.candidate_definition, { inputSchema: {} });
        return { name: r.name, exposedName: r.exposed_name, heldReason: r.held_reason, pinned, candidate, diff: definitionDiff(pinned, candidate), updatedAt: r.updated_at };
      });

  const presetView = (p: IntegrationPreset): PresetView => {
    const publicUrl = ctx.settings.publicUrl();
    const steps = p.setupSteps({
      publicUrl,
      redirectUri: `${publicUrl}/oauth/connections/callback`,
      webhookUrl: publicUrl.startsWith("https://") ? `${publicUrl}/integrations/${p.id}/webhook` : null,
    });
    return {
      id: p.id,
      displayName: p.displayName,
      slug: p.slug,
      kind: p.kind,
      url: p.url ?? null,
      authType: authTypeOf(p.auth),
      setupSteps: steps.map((s) => ({ ...s })),
      reconnectPolicy: p.reconnectPolicy ?? null,
    };
  };

  app.get("/connections", (c) => c.json<ConnectionView[]>(listConnections(ctx).map((x) => connectionView(ctx, x))));

  app.get("/connections/presets", (c) => c.json<PresetView[]>(ctx.broker.presets().map(presetView)));

  app.post("/connections/probe", async (c) => {
    const body = await readBody(c, probeSchema);
    const conn = body.connectionId ? requireConnection(body.connectionId) : null;
    // The allow only covers the exact origin it was granted for.
    const privateTarget = conn?.privateTarget && conn.privateTarget === exactOrigin(body.url) ? conn.privateTarget : null;
    return c.json(await ctx.broker.connector.probe({ url: body.url, privateTarget }, c.req.raw.signal));
  });

  app.post("/connections", async (c) => {
    const body = await readBody(c, createSchema);
    const preset = body.preset ? (ctx.broker.presets().find((p) => p.id === body.preset) ?? null) : null;
    if (body.preset && !preset) throw badRequest(`The ${body.preset} integration isn't available in this version`);
    const url = preset?.url ?? body.url ?? null;
    if (!preset && !url) throw badRequest("Pass a url, or a preset");
    const kind: ConnectionKind = preset?.kind === "native" ? (`native_${preset.id}` as ConnectionKind) : "remote_http";
    if (!(CONNECTION_KINDS as readonly string[]).includes(kind)) throw badRequest(`The ${preset!.id} integration isn't available in this version`);
    if (kind === "remote_http" && !url) throw badRequest("This integration has no URL");
    const chosenSlug = body.slug ?? freeSlug(ctx, preset?.slug ?? new URL(url!).hostname.split(".").find((p) => p !== "mcp" && p !== "www") ?? "mcp");
    if (ctx.db.get("SELECT 1 FROM connections WHERE slug = ?", chosenSlug)) throw conflict(`The slug ${chosenSlug} is taken`, "Pick another: tools are named <slug>__<tool>.");
    const agentIds = body.agentIds ?? ctx.db.all<{ id: string }>("SELECT id FROM agents ORDER BY created_at").map((a) => a.id);
    requireAgents(agentIds);
    const levelDefault = body.levelDefault ?? "ask";
    const id = newId("con");
    const t = now();
    ctx.db.tx(() => {
      ctx.db.run(
        `INSERT INTO connections (id, kind, preset, slug, name, url, auth_type, level_default, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        id,
        kind,
        preset?.id ?? null,
        chosenSlug,
        body.name ?? preset?.displayName ?? new URL(url!).hostname,
        url,
        preset ? authTypeOf(preset.auth) : "none",
        levelDefault,
        t,
        t,
      );
      for (const agentId of new Set(agentIds)) {
        ctx.db.run("INSERT INTO connection_grants (agent_id, connection_id, level, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", agentId, id, levelDefault, t, t);
      }
    });
    audit("connection.create", id, { slug: chosenSlug, preset: preset?.id ?? null, agents: agentIds.length, level: levelDefault });
    for (const agentId of new Set(agentIds)) notifyAgent(ctx, agentId);
    return c.json<ConnectionView>(view(id), 201);
  });

  app.get("/connections/:id", (c) => c.json<ConnectionView>(view(c.req.param("id"))));

  app.patch("/connections/:id", async (c) => {
    const id = c.req.param("id");
    const before = requireConnection(id);
    const body = await readBody(c, patchSchema);
    const changed: string[] = [];
    ctx.db.tx(() => {
      const t = now();
      if (body.name !== undefined && body.name !== before.name) {
        ctx.db.run("UPDATE connections SET name = ?, updated_at = ? WHERE id = ?", body.name, t, id);
        changed.push("name");
      }
      if (body.levelDefault !== undefined && body.levelDefault !== before.levelDefault) {
        ctx.db.run("UPDATE connections SET level_default = ?, updated_at = ? WHERE id = ?", body.levelDefault, t, id);
        changed.push("levelDefault");
      }
      if (body.slug !== undefined && body.slug !== before.slug) {
        if (ctx.db.get("SELECT 1 FROM connections WHERE slug = ? AND id <> ?", body.slug, id)) throw conflict(`The slug ${body.slug} is taken`);
        ctx.db.run("UPDATE connections SET slug = ?, updated_at = ? WHERE id = ?", body.slug, t, id);
        // Exposed names follow the slug; approval rules keep the upstream name, so they survive.
        try {
          ctx.db.run("UPDATE upstream_tools SET exposed_name = ? || '__' || name WHERE connection_id = ?", body.slug, id);
        } catch {
          throw badRequest(`With the slug ${body.slug}, a tool name would be too long or clash with another; pick a shorter slug`);
        }
        changed.push("slug");
      }
      if (body.url !== undefined && body.url !== before.url) {
        if (before.kind !== "remote_http") throw badRequest("Only custom MCP connections have an editable URL");
        // Editing the URL clears the private-target allow (it was granted for the old host).
        ctx.db.run("UPDATE connections SET url = ?, private_target = NULL, updated_at = ? WHERE id = ?", body.url, t, id);
        changed.push("url");
      }
    });
    if (changed.includes("url")) {
      await ctx.broker.reload(id);
      if (before.privateTarget) audit("connection.private_target.revoke", id, { target: before.privateTarget, why: "url_changed" });
    }
    if (changed.length) audit("connection.update", id, { changed });
    return c.json<ConnectionView>(view(id));
  });

  app.delete("/connections/:id", async (c) => {
    await ctx.broker.remove(c.req.param("id"));
    return c.body(null, 204);
  });

  app.post("/connections/:id/kill", async (c) => {
    const id = c.req.param("id");
    requireConnection(id);
    await ctx.broker.kill(id, "Disabled by the owner (kill switch).");
    return c.json<ConnectionView>(view(id));
  });

  app.post("/connections/:id/connect", async (c) => {
    const id = c.req.param("id");
    const conn = requireConnection(id);
    const body = await readBody(c, connectSchema);
    const r = await ctx.broker.connector.startConnect(conn, body, c.req.raw.signal);
    await ctx.broker.reload(id);
    audit("connection.connect", id, { status: r.status, header: !!body.header });
    if (r.status === "connected") return c.json<StartConnectResult>({ status: "connected", connection: view(id) });
    return c.json<StartConnectResult>(r);
  });

  app.get("/connections/:id/grants", (c) => {
    const id = c.req.param("id");
    requireConnection(id);
    return c.json<ConnectionGrant[]>(grantsOf(id));
  });

  app.put("/connections/:id/grants", async (c) => {
    const id = c.req.param("id");
    const conn = requireConnection(id);
    const body = await readBody(c, grantsSchema);
    const next = new Map(body.grants.map((g) => [g.agentId, g.level]));
    requireAgents([...next.keys()]);
    const before = new Map(grantsOf(id).map((g) => [g.agentId, g.level]));
    const removed = [...before.keys()].filter((a) => !next.has(a));
    const changed = [...next].filter(([a, l]) => before.get(a) !== l).map(([a]) => a);
    ctx.db.tx(() => {
      const t = now();
      for (const agentId of removed) ctx.db.run("DELETE FROM connection_grants WHERE agent_id = ? AND connection_id = ?", agentId, id);
      for (const [agentId, lvl] of next) {
        ctx.db.run(
          `INSERT INTO connection_grants (agent_id, connection_id, level, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(agent_id, connection_id) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at WHERE level <> excluded.level`,
          agentId,
          id,
          lvl,
          t,
          t,
        );
      }
    });
    for (const agentId of removed) approvals.cancelForConnection(id, agentId, `the agent's access to ${conn.name} was removed`);
    if (removed.length || changed.length) audit("connection.grants", id, { removed, changed });
    for (const agentId of new Set([...removed, ...changed])) notifyAgent(ctx, agentId);
    return c.json<ConnectionGrant[]>(grantsOf(id));
  });

  app.put("/connections/:id/private-target", async (c) => {
    const id = c.req.param("id");
    const conn = requireConnection(id);
    const { allow } = await readBody(c, privateTargetSchema);
    if (allow && !conn.url) throw badRequest("This connection has no URL to allow");
    const target = allow ? exactOrigin(conn.url!) : null;
    if (target !== conn.privateTarget) {
      ctx.db.run("UPDATE connections SET private_target = ?, updated_at = ? WHERE id = ?", target, now(), id);
      await ctx.broker.reload(id);
      audit(allow ? "connection.private_target.allow" : "connection.private_target.revoke", id, { target: target ?? conn.privateTarget });
    }
    return c.json<ConnectionView>(view(id));
  });

  app.get("/connections/:id/held", (c) => {
    const id = c.req.param("id");
    requireConnection(id);
    return c.json<HeldToolView[]>(heldOf(id));
  });

  app.post("/connections/:id/held/:name/accept", (c) => {
    const id = c.req.param("id");
    requireConnection(id);
    const toolName = c.req.param("name");
    ctx.broker.acceptTool(id, toolName);
    audit("connection.tool_accept", id, { tool: toolName.slice(0, 128) });
    return c.json<HeldToolView[]>(heldOf(id));
  });

  return app;
}
