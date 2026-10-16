// The extension manifest (server/extensions/manifest.ts): the strict validator, the JSON Schema the xaq-extensions
// repo validates with (they must agree), template substitution, the risk map, presetFromManifest for both kinds,
// the presets() registry over the extension store, the bootstrap pins and usedBy.

import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { classifyTool } from "../server/broker/catalog/classify.ts";
import type { SetupContext, ToolDef } from "../server/broker/types.ts";
import { BOOTSTRAP_PINS, isPlaceholderPin, usedBy } from "../server/extensions/bootstrap.ts";
import { MANIFEST_JSON_SCHEMA, ManifestError, presetFromManifest, renderSetup, validateManifest } from "../server/extensions/manifest.ts";
import { brokenExtensions, presetById, presets, reloadPresets, useExtensionStore } from "../server/integrations/index.ts";
import { FIXTURE_EXTENSIONS, fixtureExtension, fixtureManifest, stubExtensionStore } from "./extension-fixtures.ts";
import { testContext } from "./helpers.ts";

afterEach(() => useExtensionStore(null));

const ajv = new Ajv2020({ allErrors: true });
const schemaValid = ajv.compile(MANIFEST_JSON_SCHEMA);

const CTX: SetupContext = { publicUrl: "https://xaq.example", redirectUri: "https://xaq.example/oauth/connections/callback", webhookUrl: null };
const tool = (name: string, properties: Record<string, unknown> = {}, annotations?: ToolDef["annotations"]): ToolDef => ({
  name,
  description: "",
  inputSchema: { type: "object", properties },
  ...(annotations ? { annotations } : {}),
});

/** A small valid remote manifest to mutate. */
const remote = (): Record<string, unknown> => ({
  schema: 1,
  name: "demo",
  displayName: "Demo",
  version: "1.2.3",
  description: "A demo server.",
  kind: "remote",
  slug: "demo",
  remote: { url: "https://mcp.demo.example/mcp", auth: { type: "mcp_oauth" } },
  setup: [{ id: "connect", title: "Connect", body: "Press Connect." }],
  risk: { tools: { list_things: { class: "read" }, drop_thing: { class: "risky", target: "/id" } } },
});

const code = (): Record<string, unknown> => ({
  schema: 1,
  name: "whoopish",
  displayName: "Whoopish",
  version: "1.0.0",
  description: "A code extension.",
  kind: "code",
  slug: "whoopish",
  code: {
    entry: "dist/server.mjs",
    node: ">=22.13",
    auth: { type: "user_app", authorizeUrl: "https://api.example/oauth/auth", tokenUrl: "https://api.example/oauth/token", scopes: ["read:all", "offline"], clientIdInput: "client_id", clientSecretInput: "client_secret" },
    network: ["api.example"],
    events: ["whoopish.recovery_updated"],
  },
  setup: [
    { id: "app", title: "Create an app", body: "Use this redirect.", copy: { label: "Redirect URI", value: "{{redirectUri}}" } },
    { id: "id", title: "Client ID", body: "Paste it.", input: { key: "client_id", label: "Client ID", pattern: "^\\S{8,200}$" } },
    { id: "secret", title: "Client secret", body: "Paste it.", input: { key: "client_secret", label: "Client secret", secret: true } },
    { id: "hook", title: "Webhooks", body: "Optional.", copy: { label: "Webhook URL", value: "{{webhookUrl}}" }, when: "webhookUrl" },
  ],
  risk: { tools: { get_recovery: { class: "read" } } },
});

/** Sets `value` at a dotted path in a copy of the manifest (numbers index arrays). */
function patch(m: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const copy = structuredClone(m);
  const keys = path.split(".");
  let cur = copy as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
  if (value === undefined) delete cur[keys.at(-1)!];
  else cur[keys.at(-1)!] = value;
  return copy;
}

describe("validateManifest and the JSON Schema", () => {
  it.each(FIXTURE_EXTENSIONS)("the repo's %s manifest is valid, by both", (name) => {
    const m = fixtureManifest(name);
    expect(() => validateManifest(m)).not.toThrow();
    expect(schemaValid(m), JSON.stringify(schemaValid.errors)).toBe(true);
  });

  it("valid samples pass both, and validation returns a copy", () => {
    for (const m of [remote(), code()]) {
      expect(validateManifest(m)).toEqual(m);
      expect(validateManifest(m)).not.toBe(m);
      expect(schemaValid(m), JSON.stringify(schemaValid.errors)).toBe(true);
    }
    const user = patch(patch(remote(), "remote.url", undefined), "remote.userServer", { defaultPath: "/mcp", sameOriginIssuer: true });
    expect(() => validateManifest(user)).not.toThrow();
    expect(schemaValid(user)).toBe(true);
    // reconnectPolicy, setup and risk are optional, and so is every reconnectPolicy field.
    const bare = patch(patch(remote(), "setup", undefined), "risk", undefined);
    expect(() => validateManifest(bare)).not.toThrow();
    expect(schemaValid(bare)).toBe(true);
    for (const policy of [{}, { idleDays: 30 }, { maxLifetimeDays: 180, idleDays: 30, tokenLifetimeCapDays: 30 }]) {
      const m = patch(remote(), "reconnectPolicy", policy);
      expect(() => validateManifest(m)).not.toThrow();
      expect(schemaValid(m)).toBe(true);
    }
  });

  // Each: refused by validateManifest with a message matching `why`, and by the schema too.
  it.each([
    ["an unknown top-level key", "homepage", "https://x", /unknown key "homepage"/],
    ["an unknown remote key", "remote.headers", {}, /remote has an unknown key "headers"/],
    ["an unknown auth key", "remote.auth.scope", "x", /remote.auth has an unknown key "scope"/],
    ["a key another auth type takes", "remote.auth.headerName", "X-Key", /doesn't take/],
    ["an unknown step key", "setup.0.icon", "x", /setup\[0\] has an unknown key "icon"/],
    ["an unknown risk entry key", "risk.tools.list_things.why", "x", /unknown key "why"/],
    ["an unknown reconnectPolicy key", "reconnectPolicy", { days: 3 }, /unknown key "days"/],
    ["schema 2", "schema", 2, /schema must be 1/],
    ["an uppercase name", "name", "Demo", /name must be/],
    ["a reserved name", "name", "connection", /xaq uses it/],
    ["a long slug", "slug", "a".repeat(25), /slug must be at most 24/],
    ["a non-semver version", "version", "v1", /semantic version/],
    ["an unknown kind", "kind", "stdio", /kind must be/],
    ["http for a fixed url", "remote.url", "http://mcp.demo.example/mcp", /https/],
    ["both url and userServer", "remote.userServer", { defaultPath: "/mcp" }, /exactly one/],
    ["an unknown auth type", "remote.auth", { type: "basic" }, /remote.auth.type must be/],
    ["a bad header name", "remote.auth", { type: "header", headerName: "X Key" }, /HTTP header name/],
    ["a zero-day policy", "reconnectPolicy", { maxLifetimeDays: 0 }, /whole number of days/],
    ["a fractional policy", "reconnectPolicy", { tokenLifetimeCapDays: 1.5 }, /whole number of days/],
    ["an unknown risk class", "risk.tools.list_things", { class: "safe" }, /must be "read", "write" or "risky"/],
    ["a target that isn't a pointer", "risk.tools.drop_thing.target", "id", /JSON Pointer/],
    ["an empty target list", "risk.tools.drop_thing.target", [], /must not be empty/],
    ["a step without a body", "setup.0.body", undefined, /missing "body"/],
    ["an unknown when", "setup.0.when", "funnel", /when must be "webhookUrl"/],
    ["a non-https link", "setup.0.link", { label: "Open", url: "http://example.com" }, /https/],
    ["a secret that isn't a boolean", "setup.0.input", { key: "k", label: "K", secret: "yes" }, /true or false/],
  ])("refuses %s", (_what, path, value, why) => {
    const m = patch(remote(), path, value);
    expect(() => validateManifest(m)).toThrow(why);
    expect(() => validateManifest(m)).toThrow(ManifestError);
    expect(schemaValid(m)).toBe(false);
  });

  // Rules only the validator checks (the schema can't express them).
  it.each([
    ["an unknown template variable", "setup.0.body", "Open {{consoleUrl}}.", /only \{\{publicUrl\}\}, \{\{redirectUri\}\} and \{\{webhookUrl\}\}/],
    ["a stray brace", "setup.0.body", "Open {{publicUrl}.", /unbalanced/],
    ["{{webhookUrl}} without when", "setup.0.copy", { label: "Webhook URL", value: "{{webhookUrl}}" }, /needs "when": "webhookUrl"/],
    ["an exempt name the table doesn't list", "risk.nameCheckExempt", ["send_it"], /doesn't list/],
    ["an exempt name that's already risky", "risk.nameCheckExempt", ["drop_thing"], /already risky/],
    ["a bad input pattern", "setup.0.input", { key: "k", label: "K", pattern: "(" }, /regular expression/],
    ["duplicate step ids", "setup.1", { id: "connect", title: "Again", body: "x" }, /same id/],
    ["a bidi control character", "displayName", "Demo\u202e", /control characters/],
  ])("refuses %s", (_what, path, value, why) => {
    expect(() => validateManifest(patch(remote(), path, value))).toThrow(why);
  });

  it("code manifests: entry inside the extension, events under its name, user_app inputs asked for", () => {
    for (const [path, value, why] of [
      ["code.entry", "../evil.mjs", /relative path/],
      ["code.entry", "/abs/server.mjs", /relative path/],
      ["code.entry", "dist/server.ts", /relative path/],
      ["code.events", ["other.recovery_updated"], /must be "whoopish.<event>"/],
      ["code.network", ["API.example"], /host name/],
      ["code.auth.clientSecretInput", "client_id", /different inputs/],
      ["code.auth.clientIdInput", "app_id", /no setup step asks for/],
      ["code.auth.authorizeUrl", "http://api.example/oauth/auth", /https/],
      ["remote", { url: "https://x.example/mcp", auth: { type: "none" } }, /only for "kind": "remote"/],
    ] as const) {
      expect(() => validateManifest(patch(code(), path, value)), path).toThrow(why);
    }
    expect(() => validateManifest(patch(code(), "code", undefined))).toThrow(/required for "kind": "code"/);
  });

  it("the schema's top-level keys are exactly the validator's", () => {
    const keys = Object.keys(MANIFEST_JSON_SCHEMA.properties).sort();
    expect(keys).toEqual(["code", "description", "displayName", "kind", "name", "reconnectPolicy", "remote", "risk", "schema", "setup", "slug", "version"]);
    for (const k of keys) {
      // A key the validator didn't know would be refused as unknown.
      const m = remote();
      if (!(k in m)) continue;
      expect(() => validateManifest(m)).not.toThrow();
    }
  });
});

describe("setup copy", () => {
  it("fills {{publicUrl}}, {{redirectUri}} and {{webhookUrl}}, and shows `when` steps only with that context", () => {
    const m = validateManifest(code());
    const without = renderSetup(m.setup!, CTX);
    expect(without.map((s) => s.id)).toEqual(["app", "id", "secret"]);
    expect(without[0]!.copy).toEqual({ label: "Redirect URI", value: CTX.redirectUri });
    expect(without[2]!.input).toEqual({ key: "client_secret", label: "Client secret", secret: true });
    const withHook = renderSetup(m.setup!, { ...CTX, webhookUrl: "https://xaq.example/hooks/connections/whoopish" });
    expect(withHook.map((s) => s.id)).toEqual(["app", "id", "secret", "hook"]);
    expect(withHook[3]).not.toHaveProperty("when");
    expect(withHook[3]!.copy!.value).toBe("https://xaq.example/hooks/connections/whoopish");
    const link = validateManifest(patch(remote(), "setup.0.link", { label: "Open {{publicUrl}}", url: "{{publicUrl}}/settings" }));
    expect(renderSetup(link.setup!, CTX)[0]!.link).toEqual({ label: "Open https://xaq.example", url: "https://xaq.example/settings" });
  });

  it("the repo's manifests carry no template the context doesn't fill", () => {
    for (const name of FIXTURE_EXTENSIONS) {
      const steps = presetFromManifest(fixtureExtension(name)).setupSteps(CTX);
      for (const s of steps) {
        for (const v of [s.title, s.body, s.link?.label, s.link?.url, s.copy?.label, s.copy?.value]) expect(v ?? "").not.toMatch(/\{\{|\}\}/);
      }
    }
  });
});

describe("presetFromManifest", () => {
  it("remote: url, auth, reconnectPolicy, classify and nameCheckExempt", () => {
    const m = patch(patch(remote(), "reconnectPolicy", { maxLifetimeDays: 180, tokenLifetimeCapDays: 30 }), "risk.nameCheckExempt", ["list_things"]);
    const p = presetFromManifest({ ...fixtureExtension("notion"), name: "demo", manifest: m });
    expect(p).toMatchObject({ id: "demo", displayName: "Demo", slug: "demo", kind: "remote_http", url: "https://mcp.demo.example/mcp", auth: { type: "mcp_oauth" } });
    expect(p.reconnectPolicy).toEqual({ maxLifetimeDays: 180, tokenLifetimeCapDays: 30 });
    expect(p.nameCheckExempt).toEqual(["list_things"]);
    expect(p.userServer).toBeUndefined();
    expect(p.createSource).toBeUndefined();
    expect(p.classify(tool("list_things"))).toEqual({ risky: false, read: true, source: "preset" });
    expect(p.classify(tool("drop_thing", { id: {} }))).toEqual({ risky: true, read: false, source: "preset", targetPath: "/id" });
    expect(p.classify(tool("drop_thing", { other: {} }))).toEqual({ risky: true, read: false, source: "preset" });
    // Unlisted tools: null, so the generic rules (annotations, then the verb list) decide.
    for (const name of ["unknown_tool", "toString", "__proto__", "hasOwnProperty"]) expect(p.classify(tool(name))).toBeNull();
    expect(classifyTool(tool("delete_everything", {}, { readOnlyHint: true }), p)).toMatchObject({ risky: true, source: "heuristic" });
  });

  it("write, read and risky map to ToolClass exactly", () => {
    const m = patch(remote(), "risk.tools", { w: { class: "write" }, r: { class: "read" }, x: { class: "risky" } });
    const p = presetFromManifest({ ...fixtureExtension("notion"), name: "demo", manifest: m });
    expect(p.classify(tool("w"))).toEqual({ risky: false, read: false, source: "preset" });
    expect(p.classify(tool("r"))).toEqual({ risky: false, read: true, source: "preset" });
    expect(p.classify(tool("x"))).toEqual({ risky: true, read: false, source: "preset" });
  });

  it("target candidates: the first pointer whose top-level argument the live schema declares", () => {
    const m = patch(remote(), "risk.tools.drop_thing.target", ["/ids", "/thing~1id", "/id"]);
    const p = presetFromManifest({ ...fixtureExtension("notion"), name: "demo", manifest: m });
    expect(p.classify(tool("drop_thing", { id: {}, ids: {} }))?.targetPath).toBe("/ids");
    expect(p.classify(tool("drop_thing", { id: {}, "thing/id": {} }))?.targetPath).toBe("/thing~1id");
    expect(p.classify(tool("drop_thing", { id: {} }))?.targetPath).toBe("/id");
    expect(p.classify(tool("drop_thing", {}))?.targetPath).toBeUndefined();
    expect(p.classify({ name: "drop_thing", description: "", inputSchema: {} })?.targetPath).toBeUndefined();
  });

  it("header auth and a user-named server", () => {
    const p = presetFromManifest(fixtureExtension("brightspace"));
    expect(p).toMatchObject({ kind: "remote_http", auth: { type: "header", headerName: "Authorization", prefix: "Bearer " }, userServer: { defaultPath: "/mcp", sameOriginIssuer: false } });
    expect(p.url).toBeUndefined();
    expect(p.setupSteps(CTX).some((s) => s.id === "server")).toBe(true);
  });

  it("code: a native preset whose source is the host's (stubbed until the host lands), with its OAuth and events", async () => {
    const ext = { ...fixtureExtension("notion"), name: "whoopish", kind: "code" as const, manifest: code() };
    const p = presetFromManifest(ext);
    expect(p).toMatchObject({ id: "whoopish", kind: "native", auth: { type: "user_app", clientIdInput: "client_id", scopes: ["read:all", "offline"] }, events: { types: ["whoopish.recovery_updated"] } });
    const source = p.createSource!({ connectionId: "con_1", accessToken: async () => "t", fetch: globalThis.fetch, log: { info() {}, warn() {} } });
    expect(source.connectionId).toBe("con_1");
    await expect(source.listTools(AbortSignal.timeout(1000))).rejects.toThrow(/can't run in this build/);
  });

  it("code.auth.refreshScope: optional, checked by both, passed through to the preset's auth", () => {
    const ext = (m: Record<string, unknown>) => ({ ...fixtureExtension("notion"), name: "whoopish", kind: "code" as const, manifest: m });
    const withScope = patch(code(), "code.auth.refreshScope", "offline");
    expect(schemaValid(withScope), JSON.stringify(schemaValid.errors)).toBe(true);
    expect(validateManifest(withScope).code!.auth).toMatchObject({ type: "user_app", refreshScope: "offline" });
    expect(presetFromManifest(ext(withScope)).auth).toMatchObject({ type: "user_app", refreshScope: "offline" });
    expect(presetFromManifest(ext(patch(code(), "code.auth.refreshScope", "offline read:recovery"))).auth).toMatchObject({ refreshScope: "offline read:recovery" });
    // Absent: no key at all (the refresh sends no scope).
    expect(presetFromManifest(ext(code())).auth).not.toHaveProperty("refreshScope");
    for (const bad of ["", "offline  read", " offline", 'off"line', ["offline"]]) {
      const m = patch(code(), "code.auth.refreshScope", bad);
      expect(() => validateManifest(m), JSON.stringify(bad)).toThrow(/code.auth.refreshScope/);
      expect(schemaValid(m), JSON.stringify(bad)).toBe(false);
    }
    // Only user_app takes it.
    expect(() => validateManifest(patch(code(), "code.auth", { type: "none", refreshScope: "offline" }))).toThrow(/takes no other keys/);
  });

  it("refuses a manifest that isn't the installed extension's", () => {
    expect(() => presetFromManifest({ ...fixtureExtension("notion"), name: "other" })).toThrow(/installed as "other"/);
    expect(() => presetFromManifest({ ...fixtureExtension("notion"), kind: "code" })).toThrow(/installed as "code"/);
    expect(() => presetFromManifest({ ...fixtureExtension("notion"), manifest: { schema: 1 } })).toThrow(ManifestError);
  });
});

describe("the Brightspace extension's risk map", () => {
  const p = () => presetFromManifest(fixtureExtension("brightspace"));
  const READS = [
    "get_briefing",
    "get_calendar",
    "get_submission_history",
    "get_my_work",
    "get_course_updates",
    "get_my_groups",
    "get_checklists",
    "get_grade_summary",
    "search_course",
    "get_my_courses",
    "get_my_grades",
    "get_announcements",
    "get_assignments",
    "get_course_content",
    "read_course_content",
    "get_roster",
    "get_discussions",
    "get_syllabus",
  ];

  it("lists the server's 19 HTTP tools and its stdio download_file", () => {
    expect(Object.keys(fixtureManifest("brightspace").risk!.tools).sort()).toEqual([...READS, "check_auth", "download_file"].sort());
  });

  it.each(READS)("%s reads (free, listed at read only)", (name) => {
    expect(classifyTool(tool(name, {}, { readOnlyHint: true }), p())).toEqual({ risky: false, read: true, source: "preset" });
  });

  it("check_auth (can start a sign-in with MFA) and download_file (writes a file) are writes; nothing is risky", () => {
    expect(classifyTool(tool("check_auth", {}, { readOnlyHint: true }), p())).toEqual({ risky: false, read: false, source: "preset" });
    expect(classifyTool(tool("download_file", {}, { readOnlyHint: false, destructiveHint: false }), p())).toEqual({ risky: false, read: false, source: "preset" });
    expect(Object.values(fixtureManifest("brightspace").risk!.tools).some((e) => e.class === "risky")).toBe(false);
  });

  it("a tool it adds later falls back to the generic rules (a submit tool would be risky by its name)", () => {
    expect(p().classify(tool("submit_assignment"))).toBeNull();
    expect(classifyTool(tool("post_discussion_reply"), p()).risky).toBe(true);
  });
});

describe("presets(): installed extensions plus what's left in core", () => {
  it("core only without a store; installed extensions in display order; reload picks up changes", async () => {
    expect(presets().map((p) => p.id)).toEqual(["whoop"]);
    const store = stubExtensionStore({ installed: ["brightspace", "t3code"], installable: ["notion"] });
    useExtensionStore(store);
    expect(presets().map((p) => p.id)).toEqual(["whoop", "t3code", "brightspace"]);
    const t3 = presetById("t3code");
    await store.installPinned({ name: "notion", commit: "3".repeat(40), integrity: "sha256-x" });
    expect(presetById("notion")).toBeNull(); // cached until a reload
    reloadPresets();
    expect(presets().map((p) => p.id)).toEqual(["notion", "whoop", "t3code", "brightspace"]);
    // The same install keeps the same preset object across reloads.
    expect(presetById("t3code")).toBe(t3);
  });

  it("an installed extension replaces a core preset of the same name; a broken manifest offers nothing", () => {
    const whoop = { ...fixtureExtension("notion"), name: "whoop", kind: "code" as const, manifest: { ...code(), name: "whoop", slug: "whoop", code: { ...(code().code as object), events: ["whoop.recovery_updated"] } } };
    const broken = { ...fixtureExtension("notion"), name: "broken", manifest: { schema: 1, name: "broken" } };
    useExtensionStore({ list: () => [whoop, broken] });
    const ids = presets().map((p) => p.id);
    expect(ids).toEqual(["whoop"]);
    expect(presetById("whoop")!.kind).toBe("native");
    expect(presetById("whoop")!.auth).toMatchObject({ authorizeUrl: "https://api.example/oauth/auth" });
    expect(brokenExtensions().get("broken")).toMatch(/missing/);
  });
});

describe("migration bookkeeping", () => {
  it("bootstrap.json holds a pin (name, 40-hex commit, sha256 integrity) for each official extension, nothing else", () => {
    expect(BOOTSTRAP_PINS.map((p) => p.name).sort()).toEqual(["brightspace", "notion", "t3code", "whoop"]);
    for (const pin of BOOTSTRAP_PINS) {
      expect(Object.keys(pin).sort()).toEqual(["commit", "integrity", "name"]);
      expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(pin.integrity).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);
      expect(Buffer.from(pin.integrity.slice(7), "base64")).toHaveLength(32);
    }
    // Placeholders until the release fills the real pins in: nothing installs from them.
    expect(BOOTSTRAP_PINS.every(isPlaceholderPin)).toBe(true);
  });

  it("usedBy: the connections bound to an extension (connections.preset), oldest first", async () => {
    const t = testContext();
    try {
      const add = (id: string, preset: string | null, at: string) =>
        t.ctx.db.run("INSERT INTO connections (id, kind, preset, slug, name, url, created_at, updated_at) VALUES (?, 'remote_http', ?, ?, ?, 'https://x.example/mcp', ?, ?)", id, preset, id.replace("_", "-"), id, at, at);
      add("con_b", "notion", "2026-10-02T00:00:00Z");
      add("con_a", "notion", "2026-10-01T00:00:00Z");
      add("con_c", null, "2026-10-01T00:00:00Z");
      add("con_d", "t3code", "2026-10-01T00:00:00Z");
      expect(usedBy(t.ctx.db, "notion")).toEqual(["con_a", "con_b"]);
      expect(usedBy(t.ctx.db, "t3code")).toEqual(["con_d"]);
      expect(usedBy(t.ctx.db, "brightspace")).toEqual([]);
    } finally {
      await t.dispose();
    }
  });
});
