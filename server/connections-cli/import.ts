import pc from "picocolors";
import type { AccessLevel } from "../broker/types.ts";
import { mcpTarget, type McpSetupResult, type RemoveServer, setupMcp } from "../listen/mcpsetup.ts";
import { DEFAULT_PROFILE, profilePath } from "../listen/paths.ts";
import { loadProfile, profileExists } from "../listen/profile.ts";
import { safeText } from "../listen/ui.ts";
import { NPX } from "../listen/version.ts";
import type { LookupFn } from "../webhooks/ssrf.ts";
import { accessLabel, agentsLabel, chooseAccess, chooseAgents, parseAccess } from "./access.ts";
import type { ConnectionsApi, ConnectionView } from "./api.ts";
import { CLIENT_LABELS, type ClientConfig, type ClientEntry, type ImportClient, parseImportClient, readClientConfig } from "./clients.ts";
import { checkTarget } from "./private.ts";
import type { Prompter } from "./prompt.ts";
import { reconnectHint, slugify } from "./util.ts";

/**
 * `import --from <client>`: one connection per remote MCP server in that client's config, with its static header
 * moved into the broker. OAuth servers are created needing Connect (their tokens stay in the client); stdio ones
 * aren't supported yet (M4) and stay where they are. Nothing is written without a confirmation (or --yes), and
 * the client's config is only touched by the optional setup-mcp step at the end, which removes just the entries
 * whose connection works.
 */

export interface ImportFlags {
  from: string;
  dryRun?: boolean;
  yes?: boolean;
  access?: string;
  agent?: string[];
  profile?: string;
}

export interface ImportDeps {
  prompter: Prompter;
  /** Opens the admin channel (not called for --dry-run). */
  openApi: () => ConnectionsApi;
  lookup?: LookupFn;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** This agentinbox's own MCP origins (loopback with its port), so its entry is never imported. */
  selfOrigins?: string[];
}

export type PlanItem =
  | { action: "self"; entry: ClientEntry }
  | { action: "stdio"; entry: ClientEntry }
  | { action: "skip"; entry: ClientEntry; reason: string }
  | { action: "exists"; entry: ClientEntry; connection: ConnectionView }
  | {
      action: "create";
      entry: ClientEntry;
      slug: string;
      url: string;
      /** header: moved into the broker; oauth: the client says so; none: no credential (the connect finds out). */
      auth: { type: "header"; name: string; value: string } | { type: "oauth" } | { type: "none" };
      /** The exact origin a private-target allow would cover, when the URL is on this machine or a private network. */
      privateTarget: string | null;
    };

const SELF_NAME = /^agentinbox(?:-[a-z0-9][a-z0-9_-]*)?$/;

function isSelf(e: ClientEntry, selfOrigins: string[]): boolean {
  if (SELF_NAME.test(e.name)) return true;
  if (Object.values(e.headers).some((v) => /^Bearer\s+aib_/i.test(v.trim()))) return true;
  if (!e.url) return false;
  try {
    const u = new URL(e.url);
    return u.pathname.replace(/\/+$/, "").endsWith("/mcp") && selfOrigins.includes(u.origin);
  } catch {
    return false;
  }
}

const sameUrl = (a: string | null | undefined, b: string) => {
  try {
    return !!a && new URL(a).href.replace(/\/+$/, "") === new URL(b).href.replace(/\/+$/, "");
  } catch {
    return false;
  }
};

export async function planImport(config: ClientConfig, ctx: { existing?: ConnectionView[]; lookup?: LookupFn; selfOrigins?: string[] } = {}): Promise<PlanItem[]> {
  const label = CLIENT_LABELS[config.client];
  const taken = new Set((ctx.existing ?? []).map((c) => c.slug));
  const items: PlanItem[] = [];
  for (const entry of config.entries) {
    if (isSelf(entry, ctx.selfOrigins ?? [])) {
      items.push({ action: "self", entry });
      continue;
    }
    if (entry.transport === "stdio") {
      items.push({ action: "stdio", entry });
      continue;
    }
    if (entry.problem) {
      items.push({ action: "skip", entry, reason: entry.problem });
      continue;
    }
    if (!entry.enabled) {
      items.push({ action: "skip", entry, reason: `it's turned off in ${label}` });
      continue;
    }
    let url: URL;
    try {
      url = new URL(entry.url!);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
    } catch {
      items.push({ action: "skip", entry, reason: "its url isn't an http(s) URL" });
      continue;
    }
    const headerNames = Object.keys(entry.headers);
    if (headerNames.length > 1) {
      items.push({ action: "skip", entry, reason: `it sends ${headerNames.length} headers (${headerNames.join(", ")}); a connection keeps one (not supported yet)` });
      continue;
    }
    const existing = (ctx.existing ?? []).find((c) => sameUrl(c.url, url.href));
    if (existing) {
      items.push({ action: "exists", entry, connection: existing });
      continue;
    }
    const target = await checkTarget(url, ctx.lookup);
    if (target.kind === "never") {
      items.push({
        action: "skip",
        entry,
        reason:
          target.why === "ipv6_literal"
            ? `the private-network allow takes a hostname or an IPv4 address, not ${target.address}`
            : `it's on ${target.address}, a link-local or cloud metadata address, which is never allowed`,
      });
      continue;
    }
    if (target.kind === "public" && url.protocol === "http:") {
      items.push({ action: "skip", entry, reason: "plain http to a public host isn't allowed; use its https URL" });
      continue;
    }
    let slug = slugify(entry.name);
    for (let n = 2; taken.has(slug); n++) slug = `${slugify(entry.name).slice(0, 21)}-${n}`;
    taken.add(slug);
    const auth = headerNames.length
      ? { type: "header" as const, name: headerNames[0]!, value: entry.headers[headerNames[0]!]! }
      : entry.oauth
        ? { type: "oauth" as const }
        : { type: "none" as const };
    items.push({ action: "create", entry, slug, url: entry.url!.trim(), auth, privateTarget: target.kind === "private" ? target.origin : null });
  }
  return items;
}

const where = (e: ClientEntry) => (e.scope ? ` (${e.scope} scope)` : "");

/** The plan in plain words. Never prints a header value. */
export function renderPlan(config: ClientConfig, items: PlanItem[]): string[] {
  const label = CLIENT_LABELS[config.client];
  const out: string[] = [];
  const width = Math.min(24, Math.max(4, ...items.map((i) => i.entry.name.length)));
  const pad = (s: string) => s.padEnd(width);
  const cont = " ".repeat(width + 4);
  out.push(`${label}: ${config.files.join(", ") || "no config file"} lists ${items.length} MCP server${items.length === 1 ? "" : "s"}.`);
  for (const i of items) {
    const name = `  ${pad(safeText(i.entry.name, 40))}  `;
    switch (i.action) {
      case "self":
        out.push(`${name}${pc.dim("skip: this is agentinbox itself")}`);
        break;
      case "stdio":
        out.push(`${name}${pc.yellow("not supported yet (M4)")}: a local command (${safeText(i.entry.command ?? "", 60)}); it stays in ${label}`);
        break;
      case "skip":
        out.push(`${name}${pc.yellow("skip")}: ${i.reason}; it stays in ${label}`);
        break;
      case "exists":
        out.push(`${name}already a connection: "${i.connection.slug}" (${i.connection.status}, ${i.connection.tools.total} tools)`);
        break;
      case "create": {
        out.push(`${name}${pc.green("create")} connection "${i.slug}" → ${safeText(i.url, 120)}${where(i.entry)}`);
        if (i.auth.type === "header") out.push(`${cont}its ${i.auth.name} header moves into agentinbox (encrypted; never shown)`);
        else if (i.auth.type === "oauth") out.push(`${cont}OAuth: created needing Connect (${label} keeps its own tokens); sign in once with the link it prints`);
        else out.push(`${cont}no credential in ${label}: connected as it is (if it turns out to use OAuth, it needs Connect)`);
        if (i.privateTarget) out.push(`${cont}${pc.yellow("private network")}: needs the allow for exactly ${i.privateTarget}`);
        break;
      }
    }
  }
  return out;
}

interface Outcome {
  item: Extract<PlanItem, { action: "create" }>;
  /** connected: works now; authorize: needs a sign-in (the link); failed: nothing was kept. */
  status: "connected" | "authorize" | "failed";
  connection?: ConnectionView;
  authorizeUrl?: string;
  error?: string;
}

/** An existing connection proves itself by having tools; a fresh custom one starts "active" with none. */
const works = (c: ConnectionView) => c.status === "active" && c.tools.total > 0;

function setupLines(r: McpSetupResult): string[] {
  const out = [r.ok ? `${r.dryRun ? pc.cyan("○") : pc.green("✔")} ${r.message}` : `${pc.yellow("!")} ${r.message}`];
  for (const l of r.changes ?? []) out.push(l.startsWith(" ") ? pc.gray(`  ${l}`) : `  - ${l}`);
  if (r.backup) out.push(pc.gray(`  Backup: ${r.backup}`));
  if (!r.ok) for (const l of r.manual ?? []) out.push(`    ${l}`);
  for (const n of r.notes ?? []) out.push(pc.dim(`  ${n}`));
  if (r.ok && r.verify?.length) out.push(`  ${r.dryRun ? "Afterwards, check it with" : "Check it with"}: ${r.verify.map((v) => pc.cyan(v)).join("; ")}`);
  return out;
}

const toRemove = (e: ClientEntry): RemoveServer => ({ name: e.name, scope: e.scope, projectDir: e.scope === "user" ? undefined : e.projectDir });

export async function runImport(flags: ImportFlags, deps: ImportDeps): Promise<number> {
  const p = deps.prompter;
  const client: ImportClient = parseImportClient(flags.from);
  const label = CLIENT_LABELS[client];
  const access: AccessLevel | undefined = flags.access ? parseAccess(flags.access) : undefined;
  const config = readClientConfig(client, { env: deps.env, cwd: deps.cwd });
  if (!config.entries.length) {
    p.print(`${label} has no MCP servers configured (${config.files.join(", ") || "no config file"}). Nothing to import.`);
    return 0;
  }
  const profileName = flags.profile ?? DEFAULT_PROFILE;

  if (flags.dryRun) {
    const items = await planImport(config, { lookup: deps.lookup, selfOrigins: deps.selfOrigins });
    p.print(pc.bold("Dry run: nothing is created or changed."));
    for (const l of renderPlan(config, items)) p.print(l);
    const creates = items.filter((i) => i.action === "create");
    const priv = creates.filter((i) => i.privateTarget);
    p.print("");
    p.print(`Would create ${creates.length} connection${creates.length === 1 ? "" : "s"} with ${access ? accessLabel(access) : "the access you choose (default: Ask before risky actions)"}.`);
    if (priv.length) p.print(`Would ask before allowing ${priv.map((i) => i.privateTarget).join(", ")}.`);
    p.print(pc.dim("Existing connections are checked on the real run (a server already connected isn't created twice)."));
    const removable = items.filter((i) => i.action === "create" && i.auth.type !== "oauth").map((i) => toRemove(i.entry));
    p.print("");
    if (!removable.length) p.print(`${label}'s config isn't changed.`);
    else if (!profileExists(profileName)) {
      p.print(`Afterwards it offers to replace the imported entries in ${label} with the single agentinbox entry, once this machine's ${label} is paired (${NPX} connect <agentinbox-url> --tool ${client}).`);
    } else {
      p.print(`Afterwards it offers setup-mcp --tool ${client}, which would (for the entries whose connection works; OAuth ones after you Reconnect them):`);
      const r = setupMcp(client, mcpTarget(profileName, loadProfile(profileName)), profilePath(profileName), { dryRun: true, removeServers: removable });
      for (const l of setupLines(r)) p.print(l);
    }
    return 0;
  }

  const api = deps.openApi();
  const existing = await api.list();
  const items = await planImport(config, { existing, lookup: deps.lookup, selfOrigins: deps.selfOrigins });
  for (const l of renderPlan(config, items)) p.print(l);
  let creates = items.filter((i): i is Extract<PlanItem, { action: "create" }> => i.action === "create");
  const already = items.filter((i): i is Extract<PlanItem, { action: "exists" }> => i.action === "exists");
  p.print("");

  // The private-target allow: always its own explicit confirmation, listing the exact origins.
  const priv = creates.filter((i) => i.privateTarget);
  if (priv.length) {
    p.print(pc.yellow("These servers are on this machine or your private network:"));
    for (const i of priv) p.print(`  ${i.privateTarget}  (${safeText(i.entry.name, 40)})`);
    p.print(
      pc.dim("A connection to such a server can reach other services there too. Each allow covers exactly that scheme://host:port, for that connection only."),
    );
    const ok = await p.confirm(`Allow agentinbox to connect to ${priv.length === 1 ? "it" : `these ${priv.length}`}?`, false);
    if (!ok) {
      p.print(`Skipping ${priv.map((i) => i.entry.name).join(", ")}: they stay in ${label}.`);
      creates = creates.filter((i) => !i.privateTarget);
    }
  }
  if (!creates.length) {
    p.print("Nothing to create.");
    return await offerSetup(deps, client, profileName, already.filter((a) => works(a.connection)).map((a) => a.entry), [], 0);
  }

  const level = await chooseAccess(p, access);
  const agents = await chooseAgents(p, api, flags.agent);
  if (!(await p.confirm(`Create ${creates.length} connection${creates.length === 1 ? "" : "s"} (${accessLabel(level)}, ${agentsLabel(agents)})?`, true))) {
    p.print("Nothing was created.");
    return 0;
  }

  const outcomes: Outcome[] = [];
  for (const item of creates) {
    let created: ConnectionView | null = null;
    try {
      created = await api.create({ slug: item.slug, name: item.entry.name, url: item.url, levelDefault: level, ...(agents === "all" ? {} : { agentIds: agents }) });
      if (item.privateTarget) await api.allowPrivateTarget(created.id, true);
      const r = await api.connect(created.id, item.auth.type === "header" ? { header: { name: item.auth.name, value: item.auth.value } } : {});
      if (r.status === "connected") outcomes.push({ item, status: "connected", connection: r.connection });
      else if (r.status === "authorize") outcomes.push({ item, status: "authorize", connection: created, authorizeUrl: r.authorizeUrl });
      else throw new Error(r.message);
    } catch (err) {
      // Nothing half-made stays behind: running the import again retries it cleanly.
      if (created) await api.remove(created.id).catch(() => {});
      outcomes.push({ item, status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }

  p.print("");
  for (const o of outcomes) {
    const name = safeText(o.item.entry.name, 40);
    if (o.status === "failed") p.print(`${pc.red("✘")} ${name}: ${safeText(o.error!, 300)} (it stays in ${label})`);
    else if (o.status === "connected") p.print(`${pc.green("✔")} ${name} → "${o.connection!.slug}", ${o.connection!.tools.total} tools`);
    else {
      p.print(`${pc.yellow("○")} ${name} → "${o.connection!.slug}": needs Connect. Sign in (link valid 15 minutes):`);
      p.print(`    ${pc.cyan(o.authorizeUrl!)}`);
      p.print(`    ${reconnectHint(o.connection!)}`);
    }
  }
  const failed = outcomes.filter((o) => o.status === "failed").length;
  const working = [...already.filter((a) => works(a.connection)).map((a) => a.entry), ...outcomes.filter((o) => o.status === "connected").map((o) => o.item.entry)];
  const pending = outcomes.filter((o) => o.status === "authorize").map((o) => o.item.entry.name);
  return offerSetup(deps, client, profileName, working, pending, failed ? 1 : 0);
}

/** Step 2: replace the entries now served by the broker with the single agentinbox entry (setup-mcp). */
async function offerSetup(deps: ImportDeps, client: ImportClient, profileName: string, working: ClientEntry[], pending: string[], code: number): Promise<number> {
  const p = deps.prompter;
  const label = CLIENT_LABELS[client];
  if (pending.length) p.print(pc.dim(`${pending.join(", ")} stay${pending.length === 1 ? "s" : ""} in ${label} until you Reconnect; then run this import again to replace ${pending.length === 1 ? "it" : "them"}.`));
  if (!working.length) return code;
  if (!profileExists(profileName)) {
    p.print(
      `To replace ${working.map((e) => e.name).join(", ")} in ${label} with the single agentinbox entry, pair it first ` +
        `(${NPX} connect <agentinbox-url> --tool ${client}) and run this import again.`,
    );
    return code;
  }
  p.print("");
  const ok = await p.confirm(
    `Replace ${working.map((e) => `"${e.name}"`).join(", ")} in ${label} with the single agentinbox entry (setup-mcp --tool ${client}, with a backup)?`,
    true,
  );
  if (!ok) {
    p.print(`${label}'s config wasn't changed. Run this import again any time to do it.`);
    return code;
  }
  const r = setupMcp(client, mcpTarget(profileName, loadProfile(profileName)), profilePath(profileName), { removeServers: working.map(toRemove) });
  for (const l of setupLines(r)) p.print(l);
  const vars = [...new Set(working.flatMap((e) => (r.removed ?? []).includes(e.name) ? e.headerVars : []))];
  if (r.ok && vars.length) {
    p.print(pc.dim(`  ${vars.join(", ")} ${vars.length === 1 ? "is" : "are"} no longer needed by the removed entries; delete ${vars.length === 1 ? "it" : "them"} from your environment${client === "hermes" ? " (~/.hermes/.env)" : ""} once everything works through agentinbox.`));
  }
  return r.ok ? code : 1;
}
