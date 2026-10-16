import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../server/db/index.ts";
import { brokerConnections, Catalog, CatalogRegistry, connectionGrants, SqliteCatalogStore } from "../server/broker/catalog/index.ts";
import type { ToolDef } from "../server/broker/types.ts";

const T = "2026-10-16T12:00:00.000Z";
const tool = (name: string, extra: Partial<ToolDef> = {}): ToolDef => ({ name, description: `Does ${name}`, inputSchema: { type: "object" }, ...extra });

describe("SqliteCatalogStore on migration 8", () => {
  let db: Db;
  beforeEach(() => {
    db = new Db(":memory:");
    const con = (id: string, slug: string) =>
      db.run(
        "INSERT INTO connections (id, kind, slug, name, url, created_at, updated_at) VALUES (?, 'remote_http', ?, ?, 'https://mcp.example.com/mcp', ?, ?)",
        id,
        slug,
        slug,
        T,
        T,
      );
    con("con_a", "alpha");
    con("con_b", "beta");
    db.run("INSERT INTO agents (id, name, key_prefix, key_hash, created_at) VALUES ('agt_1', 'A', 'aib_x', 'h1', ?)", T);
    db.run("INSERT INTO connection_grants (agent_id, connection_id, level, created_at, updated_at) VALUES ('agt_1', 'con_a', 'read', ?, ?)", T, T);
  });
  afterEach(() => db.close());

  const make = () => {
    const store = new SqliteCatalogStore(db);
    const catalog = new Catalog({
      store,
      connection: (id) => {
        const c = brokerConnections(db).find((x) => x.id === id);
        return c ? { slug: c.slug, preset: null } : null;
      },
      connections: () => brokerConnections(db),
      audit: () => {},
      emit: () => {},
    });
    const registry = new CatalogRegistry({ store, connections: () => brokerConnections(db), grants: (a) => connectionGrants(db, a) });
    catalog.onChange(() => registry.invalidate());
    return { store, catalog, registry };
  };

  it("persists pins, holds and accepts within the schema's CHECKs", () => {
    const { store, catalog, registry } = make();
    catalog.applyListing("con_a", { tools: [tool("get_page", { annotations: { readOnlyHint: true } }), tool("delete_page")], instructions: "Hi" });
    expect(db.get("SELECT tools_cached_at AS t, instructions_hash AS h FROM connections WHERE id = 'con_a'")).toMatchObject({ t: expect.any(String), h: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(registry.forAgent("agt_1").map((t) => t.exposedName)).toEqual(["alpha__get_page"]);

    catalog.applyListing("con_a", { tools: [tool("get_page", { annotations: { readOnlyHint: true }, title: "Get" }), tool("delete_page"), tool("new_one")], instructions: "Hi" });
    const rows = db.all<{ name: string; state: string; held_reason: string | null; definition: string | null }>(
      "SELECT name, state, held_reason, definition FROM upstream_tools WHERE connection_id = 'con_a' ORDER BY name",
    );
    expect(rows.map((r) => [r.name, r.state, r.held_reason, r.definition === null])).toEqual([
      ["delete_page", "active", null, false],
      ["get_page", "held", "changed", false],
      ["new_one", "held", "new", true],
    ]);
    // The stored definition has no name (the row has it); it round-trips to the same pin.
    const back = store.get("con_a", "delete_page")!;
    expect(back.def).toEqual({ name: "delete_page", description: "Does delete_page", inputSchema: { type: "object" } });
    expect(back.cls).toEqual({ risky: true, read: false, source: "heuristic" });

    catalog.acceptHeldTool("con_a", "new_one");
    catalog.acceptHeldTool("con_a", "get_page");
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM upstream_tools WHERE state = 'held'")!.n).toBe(0);

    catalog.applyListing("con_a", { tools: [tool("get_page")] });
    expect(store.tools("con_a").map((t) => t.name)).toEqual(["get_page"]);
    catalog.close();
  });

  it("after a restart, the next listing isn't a first connect and restores the pinned instructions", () => {
    const one = make();
    one.catalog.applyListing("con_a", { tools: [tool("a")], instructions: "Pinned text" });
    one.catalog.close();
    const two = make();
    expect(two.catalog.instructions("con_a")).toBeNull();
    const out = two.catalog.applyListing("con_a", { tools: [tool("a"), tool("b")], instructions: "Pinned text" });
    expect(out.first).toBe(false);
    expect(out.held).toEqual([{ name: "b", reason: "new" }]);
    expect(two.catalog.instructions("con_a")).toBe("Pinned text");
    two.catalog.forget("con_a");
    expect(two.store.state("con_a")!.refreshedAt).toBeNull();
    expect(two.store.tools("con_a")).toEqual([]);
  });

  it("renames on a slug edit and refuses a sanitised duplicate instead of breaking the UNIQUE index", () => {
    const { catalog, registry } = make();
    catalog.applyListing("con_a", { tools: [tool("x")] });
    db.run("UPDATE connections SET slug = 'gamma' WHERE id = 'con_a'");
    registry.invalidate();
    expect(registry.forAgent("agt_1")).toEqual([]); // x isn't a read tool; check names via the table instead
    const out = catalog.applyListing("con_a", { tools: [tool("x"), tool("a.b"), tool("a_b")] });
    expect(out.refused).toEqual([{ connectionId: "con_a", name: "a_b", reason: "collision", with: "gamma__a_b" }]);
    expect(db.all("SELECT name AS n, exposed_name AS e FROM upstream_tools ORDER BY n")).toEqual([
      { n: "a.b", e: "gamma__a_b" },
      { n: "x", e: "gamma__x" },
    ]);
  });
});
