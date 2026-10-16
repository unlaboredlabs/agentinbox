// ToolRegistry over the pinned catalog: per-agent tool lists with connection_grants.level applied. Synchronous and
// cached in memory; call invalidate() whenever connections, grants or the catalog change (Catalog.onChange does the
// last one).

import type { Db } from "../../db/index.ts";
import type { AccessLevel, IntegrationPreset, RegisteredTool, ToolRegistry } from "../types.ts";
import { candidateKey, checkCollisions, exposedName, fold, type NameRefusal } from "./names.ts";
import type { CatalogStore, HeldReason } from "./store.ts";

export interface RegistryConnection {
  id: string;
  slug: string;
  /** Not used to filter: disabled and needs_reauth connections keep their tools listed (calls fail with the fix). */
  status: string;
}

export interface RegistryDeps {
  store: CatalogStore;
  /** Every broker connection (native Google accounts excluded). */
  connections(): RegistryConnection[];
  /** connection_grants rows of one agent. No row: no access. */
  grants(agentId: string): { connectionId: string; level: AccessLevel }[];
  /** The connection's preset, for `targetPath` (not stored in upstream_tools). */
  preset?(connectionId: string): Pick<IntegrationPreset, "classify"> | null;
}

/** Broker connections from migration 8's table (native Google accounts aren't broker connections). */
export function brokerConnections(db: Db): (RegistryConnection & { preset: string | null })[] {
  return db.all("SELECT id, slug, status, preset FROM connections WHERE kind <> 'native_google' ORDER BY id");
}

/** One agent's connection_grants. */
export function connectionGrants(db: Db, agentId: string): { connectionId: string; level: AccessLevel }[] {
  return db.all("SELECT connection_id AS connectionId, level FROM connection_grants WHERE agent_id = ?", agentId);
}

interface Exposed {
  tool: Omit<RegisteredTool, "level">;
}

interface Snapshot {
  /** Active (pinned, not held, named without collision) tools, sorted by exposed name. */
  active: Exposed[];
  /** Held tools by exposed name, so the call path can say `tool_on_hold` instead of "unknown tool". */
  held: Map<string, { connectionId: string; name: string; reason: HeldReason }>;
  refused: NameRefusal[];
}

interface AgentView {
  list: RegisteredTool[];
  byName: Map<string, RegisteredTool>;
}

export class CatalogRegistry implements ToolRegistry {
  private snapshot: Snapshot | null = null;
  private readonly agents = new Map<string, AgentView>();

  constructor(private readonly deps: RegistryDeps) {}

  /** Drops every cached view: connections, slugs, grants or pins changed. */
  invalidate(): void {
    this.snapshot = null;
    this.agents.clear();
  }

  /** Drops one agent's view (its grants changed). */
  invalidateAgent(agentId: string): void {
    this.agents.delete(agentId);
  }

  forAgent(agentId: string): RegisteredTool[] {
    return [...this.view(agentId).list];
  }

  resolve(agentId: string, exposedName: string): RegisteredTool | null {
    return this.view(agentId).byName.get(exposedName) ?? null;
  }

  /**
   * A held tool by exposed name, when the agent has a grant on its connection (so the call path can answer
   * `tool_on_hold`). Additive to the ToolRegistry contract.
   */
  held(agentId: string, exposed: string): { connectionId: string; name: string; reason: HeldReason } | null {
    const h = this.snap().held.get(fold(exposed));
    if (!h) return null;
    return this.deps.grants(agentId).some((g) => g.connectionId === h.connectionId) ? h : null;
  }

  /** Tools that can't be exposed (invalid name, or a collision with a native tool or another connection). */
  refusals(): NameRefusal[] {
    return [...this.snap().refused];
  }

  private view(agentId: string): AgentView {
    const cached = this.agents.get(agentId);
    if (cached) return cached;
    const levels = new Map(this.deps.grants(agentId).map((g) => [g.connectionId, g.level]));
    const list: RegisteredTool[] = [];
    for (const { tool } of this.snap().active) {
      const level = levels.get(tool.connectionId);
      if (!level) continue;
      if (level === "read" && !tool.cls.read) continue;
      list.push({ ...tool, level });
    }
    const v: AgentView = { list, byName: new Map(list.map((t) => [t.exposedName, t])) };
    this.agents.set(agentId, v);
    return v;
  }

  private snap(): Snapshot {
    if (this.snapshot) return this.snapshot;
    const conns = new Map(this.deps.connections().map((c) => [c.id, c]));
    const rows = this.deps.store.allTools().filter((t) => conns.has(t.connectionId));
    // Names are recomputed from the current slug and re-checked for collisions on every rebuild. Every row takes
    // part (held ones too, so a held newcomer can't later steal a name); pinned ones are established.
    const named = rows.map((t) => ({ row: t, exposed: exposedName(conns.get(t.connectionId)!.slug, t.name) }));
    const { ok, refused } = checkCollisions(
      named.map(({ row, exposed }) => ({ connectionId: row.connectionId, name: row.name, exposedName: exposed, established: row.def !== null })),
    );
    const active: Exposed[] = [];
    const held: Snapshot["held"] = new Map();
    for (const { row, exposed } of named) {
      if (!exposed || !ok.has(candidateKey(row.connectionId, row.name))) continue;
      if (row.heldReason) {
        held.set(fold(exposed), { connectionId: row.connectionId, name: row.name, reason: row.heldReason });
        continue;
      }
      if (!row.def || !row.pinHash) continue;
      const targetPath = this.deps.preset?.(row.connectionId)?.classify(row.def)?.targetPath;
      const cls = targetPath ? { ...row.cls, targetPath } : row.cls;
      active.push({
        tool: { exposedName: exposed, connectionId: row.connectionId, slug: conns.get(row.connectionId)!.slug, def: row.def, cls, pinHash: row.pinHash },
      });
    }
    active.sort((a, b) => (a.tool.exposedName < b.tool.exposedName ? -1 : a.tool.exposedName > b.tool.exposedName ? 1 : 0));
    this.snapshot = { active, held, refused };
    return this.snapshot;
  }
}
