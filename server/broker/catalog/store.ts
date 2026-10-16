// Persistence of the pinned catalog: `upstream_tools` (migration 8) plus the catalog columns of `connections`
// (tools_cached_at, instructions_hash). The catalog and the registry only talk to the CatalogStore interface;
// SqliteCatalogStore is the real one, MemoryCatalogStore backs unit tests.

import { type Db, json } from "../../db/index.ts";
import type { ClassSource, ToolAnnotations, ToolClass, ToolDef } from "../types.ts";

export type HeldReason = "changed" | "new";

/** One upstream tool of a connection: its pin, and the candidate definition while it's on hold. */
export interface PinnedTool {
  connectionId: string;
  /** The upstream's own name (what `callTool` gets). */
  name: string;
  /** `<slug>__<name>` (unique across connections; tools that can't be named aren't stored). */
  exposedName: string;
  /** The pinned, cleaned definition; null for a new tool on hold that was never accepted. */
  def: ToolDef | null;
  pinHash: string | null;
  /** Classification of `def` (of the candidate while `def` is null). `targetPath` isn't stored: the preset gives it. */
  cls: ToolClass;
  heldReason: HeldReason | null;
  candidateDef: ToolDef | null;
  candidateHash: string | null;
  firstSeenAt: string;
  updatedAt: string;
}

/** Per-connection catalog state. Only `refreshedAt` and `instructionsHash` are persisted (columns of `connections`). */
export interface CatalogState {
  connectionId: string;
  /** Pinned, cleaned server instructions (in memory: after a restart, restored when the listing matches the hash). */
  instructions: string | null;
  instructionsHash: string | null;
  /** Changed instructions are waiting for the owner (the pinned ones keep being served). */
  instructionsHeld: boolean;
  candidateInstructions: string | null;
  candidateInstructionsHash: string | null;
  /** Last successful listing; null before the first one (the next one is the "first connect"). */
  refreshedAt: string | null;
  lastError: string | null;
  ttlMs: number | null;
}

export interface CatalogStore {
  tools(connectionId: string): PinnedTool[];
  allTools(): PinnedTool[];
  get(connectionId: string, name: string): PinnedTool | null;
  upsert(tool: PinnedTool): void;
  remove(connectionId: string, name: string): void;
  state(connectionId: string): CatalogState | null;
  setState(state: CatalogState): void;
  /** Drops every tool and the state of a connection (URL change, delete). */
  forget(connectionId: string): void;
  tx<T>(fn: () => T): T;
}

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryCatalogStore implements CatalogStore {
  private readonly rows = new Map<string, Map<string, PinnedTool>>();
  private readonly states = new Map<string, CatalogState>();

  tools(connectionId: string): PinnedTool[] {
    return [...(this.rows.get(connectionId)?.values() ?? [])].map(clone);
  }
  allTools(): PinnedTool[] {
    return [...this.rows.values()].flatMap((m) => [...m.values()]).map(clone);
  }
  get(connectionId: string, name: string): PinnedTool | null {
    const r = this.rows.get(connectionId)?.get(name);
    return r ? clone(r) : null;
  }
  upsert(tool: PinnedTool): void {
    for (const [cid, m] of this.rows) {
      for (const r of m.values()) {
        if (r.exposedName === tool.exposedName && !(cid === tool.connectionId && r.name === tool.name)) {
          throw new Error("UNIQUE constraint failed: upstream_tools.exposed_name");
        }
      }
    }
    let m = this.rows.get(tool.connectionId);
    if (!m) this.rows.set(tool.connectionId, (m = new Map()));
    m.set(tool.name, clone(tool));
  }
  remove(connectionId: string, name: string): void {
    this.rows.get(connectionId)?.delete(name);
  }
  state(connectionId: string): CatalogState | null {
    const s = this.states.get(connectionId);
    return s ? clone(s) : null;
  }
  setState(state: CatalogState): void {
    this.states.set(state.connectionId, clone(state));
  }
  forget(connectionId: string): void {
    this.rows.delete(connectionId);
    this.states.delete(connectionId);
  }
  tx<T>(fn: () => T): T {
    // Synchronous and single-threaded: snapshot and restore on throw.
    const rows = new Map([...this.rows].map(([k, v]) => [k, new Map(v)]));
    const states = new Map(this.states);
    try {
      return fn();
    } catch (err) {
      this.rows.clear();
      for (const [k, v] of rows) this.rows.set(k, v);
      this.states.clear();
      for (const [k, v] of states) this.states.set(k, v);
      throw err;
    }
  }
}

interface ToolRow {
  connection_id: string;
  name: string;
  exposed_name: string;
  definition: string | null;
  pin_hash: string | null;
  risky: number;
  read: number;
  class_source: ClassSource;
  state: "active" | "held";
  held_reason: HeldReason | null;
  candidate_definition: string | null;
  candidate_hash: string | null;
  first_seen_at: string;
  updated_at: string;
}

/** upstream_tools.definition: the definition without its name (the row has it). */
type StoredDefinition = Omit<ToolDef, "name" | "description"> & { description?: string };

function toStored(def: ToolDef | null): string | null {
  if (!def) return null;
  const { name: _name, ...rest } = def;
  return json.str(rest);
}

function fromStored(name: string, v: string | null): ToolDef | null {
  if (v === null) return null;
  const d = json.parse<StoredDefinition | null>(v, null);
  if (!d) return null;
  const out: ToolDef = { name, description: d.description ?? "", inputSchema: d.inputSchema ?? { type: "object" } };
  if (d.title !== undefined) out.title = d.title;
  if (d.outputSchema !== undefined) out.outputSchema = d.outputSchema;
  if (d.annotations !== undefined) out.annotations = d.annotations as ToolAnnotations;
  return out;
}

const toTool = (r: ToolRow): PinnedTool => ({
  connectionId: r.connection_id,
  name: r.name,
  exposedName: r.exposed_name,
  def: fromStored(r.name, r.definition),
  pinHash: r.pin_hash,
  cls: { risky: r.risky === 1, read: r.read === 1, source: r.class_source },
  heldReason: r.held_reason,
  candidateDef: fromStored(r.name, r.candidate_definition),
  candidateHash: r.candidate_hash,
  firstSeenAt: r.first_seen_at,
  updatedAt: r.updated_at,
});

/** The real store, on migration 8's tables. The in-memory parts of CatalogState live here too. */
export class SqliteCatalogStore implements CatalogStore {
  private readonly volatile = new Map<string, Omit<CatalogState, "connectionId" | "refreshedAt" | "instructionsHash">>();

  constructor(private readonly db: Db) {}

  tools(connectionId: string): PinnedTool[] {
    return this.db.all<ToolRow>("SELECT * FROM upstream_tools WHERE connection_id = ? ORDER BY name", connectionId).map(toTool);
  }
  allTools(): PinnedTool[] {
    return this.db.all<ToolRow>("SELECT * FROM upstream_tools ORDER BY connection_id, name").map(toTool);
  }
  get(connectionId: string, name: string): PinnedTool | null {
    const r = this.db.get<ToolRow>("SELECT * FROM upstream_tools WHERE connection_id = ? AND name = ?", connectionId, name);
    return r ? toTool(r) : null;
  }
  upsert(t: PinnedTool): void {
    this.db.run(
      `INSERT INTO upstream_tools (connection_id, name, exposed_name, definition, pin_hash, risky, read, class_source, state,
         held_reason, candidate_definition, candidate_hash, first_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (connection_id, name) DO UPDATE SET exposed_name = excluded.exposed_name, definition = excluded.definition,
         pin_hash = excluded.pin_hash, risky = excluded.risky, read = excluded.read, class_source = excluded.class_source,
         state = excluded.state, held_reason = excluded.held_reason, candidate_definition = excluded.candidate_definition,
         candidate_hash = excluded.candidate_hash, updated_at = excluded.updated_at`,
      t.connectionId,
      t.name,
      t.exposedName,
      toStored(t.def),
      t.pinHash,
      t.cls.risky ? 1 : 0,
      t.cls.read && !t.cls.risky ? 1 : 0,
      t.cls.source,
      t.heldReason ? "held" : "active",
      t.heldReason,
      toStored(t.candidateDef),
      t.candidateHash,
      t.firstSeenAt,
      t.updatedAt,
    );
  }
  remove(connectionId: string, name: string): void {
    this.db.run("DELETE FROM upstream_tools WHERE connection_id = ? AND name = ?", connectionId, name);
  }
  state(connectionId: string): CatalogState | null {
    const c = this.db.get<{ tools_cached_at: string | null; instructions_hash: string | null }>(
      "SELECT tools_cached_at, instructions_hash FROM connections WHERE id = ?",
      connectionId,
    );
    if (!c) return null;
    const v = this.volatile.get(connectionId);
    return {
      connectionId,
      refreshedAt: c.tools_cached_at,
      instructionsHash: c.instructions_hash,
      instructions: v?.instructions ?? null,
      instructionsHeld: v?.instructionsHeld ?? false,
      candidateInstructions: v?.candidateInstructions ?? null,
      candidateInstructionsHash: v?.candidateInstructionsHash ?? null,
      lastError: v?.lastError ?? null,
      ttlMs: v?.ttlMs ?? null,
    };
  }
  setState(s: CatalogState): void {
    this.db.run(
      "UPDATE connections SET tools_cached_at = ?, instructions_hash = ? WHERE id = ?",
      s.refreshedAt,
      s.instructionsHash,
      s.connectionId,
    );
    const { connectionId, refreshedAt: _r, instructionsHash: _h, ...rest } = s;
    this.volatile.set(connectionId, rest);
  }
  forget(connectionId: string): void {
    this.db.tx(() => {
      this.db.run("DELETE FROM upstream_tools WHERE connection_id = ?", connectionId);
      this.db.run("UPDATE connections SET tools_cached_at = NULL, instructions_hash = NULL WHERE id = ?", connectionId);
    });
    this.volatile.delete(connectionId);
  }
  tx<T>(fn: () => T): T {
    return this.db.tx(fn);
  }
}
