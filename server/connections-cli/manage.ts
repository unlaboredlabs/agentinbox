import pc from "picocolors";
import type { SetupStepView, StartConnectInput } from "../../shared/types.ts";
import { safeText } from "../listen/ui.ts";
import { NPX } from "../listen/version.ts";
import { accessLabel, agentsLabel, chooseAccess, chooseAgents, parseAccess } from "./access.ts";
import type { ConnectionProbe, ConnectionsApi, ConnectionView, PresetView } from "./api.ts";
import { exactOrigin } from "./private.ts";
import type { Prompter } from "./prompt.ts";
import { reconnectHint, slugify, validSlug } from "./util.ts";

/** `connections add | list | reconnect | disable | remove`. */

export interface AddFlags {
  slug?: string;
  access?: string;
  agent?: string[];
  /** Header name for a server that wants a static key (default Authorization). */
  header?: string;
  /** Always paste the address the browser lands on, instead of waiting for the redirect. */
  paste?: boolean;
  yes?: boolean;
}

export interface ManageDeps {
  prompter: Prompter;
  api: ConnectionsApi;
  openBrowser?: (url: string) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  /** Tests: poll faster. */
  pollMs?: number;
  timeoutMs?: number;
}

const isUrl = (s: string) => /^https?:\/\//i.test(s.trim());

/** Renders a preset's setup step in the terminal (the console renders the same steps). */
export function renderStep(step: SetupStepView, n: number): string[] {
  const out = [pc.bold(`${n}. ${safeText(step.title, 120)}`)];
  for (const para of step.body.split(/\n{2,}/)) out.push(`   ${para.replace(/\s*\n\s*/g, " ").replace(/`([^`]+)`/g, (_m, c: string) => pc.cyan(c))}`);
  if (step.link) out.push(`   ${step.link.label}: ${pc.cyan(step.link.url)}`);
  if (step.copy) out.push(`   ${step.copy.label}: ${pc.cyan(step.copy.value)}`);
  return out;
}

async function askInput(p: Prompter, input: NonNullable<SetupStepView["input"]>): Promise<string> {
  for (;;) {
    const v = input.secret ? await p.secret(input.label) : await p.ask(input.label);
    if (!v) {
      p.print(pc.yellow("  This is needed to continue."));
      continue;
    }
    if (input.pattern && !new RegExp(input.pattern).test(v)) {
      p.print(pc.yellow(`  That doesn't look right${input.placeholder ? ` (it looks like ${input.placeholder})` : ""}.`));
      continue;
    }
    return v;
  }
}

async function askSlug(p: Prompter, flag: string | undefined, def: string, taken: Set<string>): Promise<string> {
  if (flag) {
    if (!validSlug(flag)) throw new Error(`--slug "${flag}": use 1-24 lowercase letters, digits and dashes.`);
    if (taken.has(flag)) throw new Error(`There's already a connection "${flag}".`);
    return flag;
  }
  let suggestion = def;
  for (let n = 2; taken.has(suggestion); n++) suggestion = `${def.slice(0, 21)}-${n}`;
  for (;;) {
    const s = (await p.ask("Name it (agents see its tools as <name>__<tool>)", suggestion)).toLowerCase();
    if (!validSlug(s)) p.print(pc.yellow("  Use 1-24 lowercase letters, digits and dashes."));
    else if (taken.has(s)) p.print(pc.yellow(`  There's already a connection "${s}".`));
    else return s;
  }
}

/** A slug from a URL: the host's first label that says something (mcp.notion.com → notion). */
export function slugFromUrl(url: URL): string {
  const labels = url.hostname.split(".").filter((l) => !["mcp", "api", "www"].includes(l));
  const first = /^\d/.test(url.hostname) || url.hostname.includes(":") ? `${url.hostname}-${url.port || "mcp"}` : (labels[0] ?? url.hostname);
  return slugify(first);
}

const registrationWords: Record<string, string> = {
  preregistered: "with a registered client",
  metadata_document: "registers itself automatically (client metadata document)",
  dcr: "registers itself automatically (dynamic client registration)",
  manual: "needs a client ID you get from the provider",
};

const overSsh = (env: NodeJS.ProcessEnv) => !!(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
const isLoopbackHost = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";

/** Where the provider sends the browser after consent: the authorize URL's redirect_uri. */
function redirectOf(authorizeUrl: string): URL | null {
  try {
    const r = new URL(authorizeUrl).searchParams.get("redirect_uri");
    return r ? new URL(r) : null;
  } catch {
    return null;
  }
}

/**
 * OAuth: open the browser and wait for the callback, or paste the address the browser lands on: over SSH when the
 * redirect goes to localhost (the browser isn't on this machine), and always for an https://localhost redirect
 * (providers that refuse http, where nothing listens).
 */
export async function authorize(
  conn: ConnectionView,
  start: { authorizeUrl: string; callbackMode?: "direct" | "paste"; redirectUri?: string },
  deps: ManageDeps,
  flags: { paste?: boolean } = {},
): Promise<ConnectionView> {
  const { api, prompter: p } = deps;
  const env = deps.env ?? process.env;
  const authorizeUrl = start.authorizeUrl;
  const redirect = (() => {
    try {
      return start.redirectUri ? new URL(start.redirectUri) : redirectOf(authorizeUrl);
    } catch {
      return redirectOf(authorizeUrl);
    }
  })();
  const loopback = !!redirect && isLoopbackHost(redirect.hostname);
  const paste = !!flags.paste || start.callbackMode === "paste" || (loopback && (overSsh(env) || redirect!.protocol === "https:"));
  const name = safeText(conn.name, 60);
  if (paste) {
    p.print(`Open this link in a browser where you can sign in to ${name}:`);
    p.print(`  ${pc.cyan(authorizeUrl)}`);
    const start = redirect ? `${redirect.origin}${redirect.pathname}` : "the callback address";
    p.print(pc.dim(`After you approve, the browser goes to an address starting with ${start} (it may say the page can't be reached). Copy that whole address.`));
    for (;;) {
      const pasted = await p.ask("Paste the address here");
      if (!/[?&](code|error)=/.test(pasted)) {
        p.print(pc.yellow(`  That isn't the address after signing in: it starts with ${start} and has ?code=… in it.`));
        continue;
      }
      const r = await api.finish(pasted.trim());
      if (r.status === "connected") return r.connection;
      throw new Error(r.status === "error" ? r.message : "The sign-in didn't finish.");
    }
  }
  const before = (await api.get(conn.id)).updatedAt;
  p.print(`Opening your browser to sign in to ${name}. If it doesn't open, use this link:`);
  p.print(`  ${pc.cyan(authorizeUrl)}`);
  try {
    await (deps.openBrowser ?? (async (u: string) => (await import("open")).default(u)))(authorizeUrl);
  } catch {
    // The link is printed.
  }
  const pollMs = deps.pollMs ?? 2000;
  const deadline = Date.now() + (deps.timeoutMs ?? 15 * 60_000);
  p.print(pc.dim("Waiting for you to approve in the browser… (Ctrl+C to stop)"));
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const now = await api.get(conn.id);
    // The callback marks it active and touches updated_at; the sign-in page itself shows any error.
    if (now.status === "active" && now.updatedAt !== before) return now;
  }
  throw new Error(`Timed out waiting for the sign-in. Try again with \`${NPX} connections reconnect ${conn.slug}\`${overSsh(env) ? "" : " (add --paste to paste the address instead)"}.`);
}

/** Connects (header, setup inputs, or OAuth) and returns the connection as it ends up. */
export async function connectNow(conn: ConnectionView, input: StartConnectInput, deps: ManageDeps, flags: { paste?: boolean } = {}): Promise<ConnectionView> {
  const r = await deps.api.connect(conn.id, input);
  if (r.status === "connected") return r.connection;
  if (r.status === "authorize") return authorize(conn, r, deps, flags);
  throw new Error(r.message);
}

function printResult(p: Prompter, c: ConnectionView): void {
  if (c.status === "active") {
    p.print(`${pc.green("✔")} Connected "${c.slug}": ${c.tools.total} tool${c.tools.total === 1 ? "" : "s"}, seen by agents as ${c.slug}__<tool> (${accessLabel(c.levelDefault)}).`);
  } else {
    p.print(`${pc.yellow("○")} "${c.slug}" was added but is ${c.status}${c.statusReason ? `: ${safeText(c.statusReason, 200)}` : ""}.`);
    p.print(`  ${reconnectHint(c)}`);
  }
}

interface Pending {
  slug: string;
  name: string;
  preset?: string;
  url?: string;
}

/** The access question, the agents, then create; `after` runs on the new connection (allow, connect). */
async function createThen(base: Pending, flags: AddFlags, deps: ManageDeps, after: (c: ConnectionView) => Promise<ConnectionView>): Promise<number> {
  const { api, prompter: p } = deps;
  const level = await chooseAccess(p, flags.access ? parseAccess(flags.access) : undefined);
  const agents = await chooseAgents(p, api, flags.agent);
  if (!(await p.confirm(`Add "${base.slug}" (${accessLabel(level)}, ${agentsLabel(agents)})?`, true))) {
    p.print("Nothing was added.");
    return 0;
  }
  const created = await api.create({ ...base, levelDefault: level, ...(agents === "all" ? {} : { agentIds: agents }) });
  let conn: ConnectionView;
  try {
    conn = await after(created);
  } catch (err) {
    p.print(pc.yellow(`"${created.slug}" was added but isn't connected: ${safeText(err instanceof Error ? err.message : String(err), 300)}`));
    p.print(`  ${reconnectHint(created)}   (or remove it: ${NPX} connections remove ${created.slug})`);
    return 1;
  }
  printResult(p, conn);
  return conn.status === "active" ? 0 : 1;
}

async function addPreset(preset: PresetView, flags: AddFlags, deps: ManageDeps, taken: Set<string>): Promise<number> {
  const p = deps.prompter;
  p.print(pc.bold(`Connect ${safeText(preset.displayName, 60)}`));
  preset.setupSteps.forEach((step, i) => {
    for (const l of renderStep(step, i + 1)) p.print(l);
  });
  const inputs: Record<string, string> = {};
  for (const step of preset.setupSteps) if (step.input) inputs[step.input.key] = await askInput(p, step.input);
  let header: StartConnectInput["header"];
  if (preset.authType === "header") {
    const name = flags.header ?? "Authorization";
    header = { name, value: await askInput(p, { key: "header", label: `${name} value (not shown)`, secret: true }) };
  }
  const slug = await askSlug(p, flags.slug, preset.slug, taken);
  const input: StartConnectInput = { ...(header ? { header } : {}), ...(Object.keys(inputs).length ? { inputs } : {}) };
  return createThen({ slug, name: preset.displayName, preset: preset.id }, flags, deps, (c) => connectNow(c, input, deps, flags));
}

async function headerFor(p: Prompter, flags: { header?: string }): Promise<NonNullable<StartConnectInput["header"]>> {
  const name = flags.header ?? (await p.ask("Header name", "Authorization"));
  const value = await askInput(p, { key: "header", label: `${name} value (not shown)`, secret: true });
  return { name, value: /^authorization$/i.test(name) && !/\s/.test(value) ? `Bearer ${value}` : value };
}

function describeProbe(p: Prompter, probe: ConnectionProbe): void {
  if (probe.auth === "oauth") {
    p.print(`It signs in with OAuth${probe.issuer ? ` via ${safeText(probe.issuer, 120)}` : ""}${probe.registration ? `, and ${registrationWords[probe.registration] ?? probe.registration}` : ""}.`);
  } else if (probe.auth === "header") p.print(`It needs an API key or token. ${safeText(probe.message, 200)}`);
  else if (probe.auth === "none") p.print("It doesn't need a sign-in.");
  else p.print(safeText(probe.message, 200));
}

const MANUAL_CLIENT = "It needs a client ID from the provider; finish it in the console's Connections page.";

async function addUrl(raw: string, flags: AddFlags, deps: ManageDeps, taken: Set<string>): Promise<number> {
  const { api, prompter: p } = deps;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`"${raw}" isn't a URL. Use the server's full MCP address, e.g. https://mcp.example.com/mcp.`);
  }
  p.print(`Checking ${pc.cyan(url.href)}…`);
  const probe = await api.probe(url.href);
  let allowPrivate = false;
  let header: StartConnectInput["header"];
  if (probe.blocked === "private_target") {
    const origin = exactOrigin(url);
    p.print(pc.yellow(`${url.host} is on this machine or your private network.`));
    p.print(
      "agentinbox blocks those by default: a connection to a server there can reach other services on the same machine or network. " +
        `An allow covers exactly ${origin}, for this connection only (and plain http on that host).`,
    );
    if (!(await p.confirm(`Allow this connection to reach ${origin}?`, false))) {
      p.print("Nothing was added.");
      return 0;
    }
    // Probed again once the connection (and its allow) exists.
    allowPrivate = true;
  } else if (probe.blocked || !probe.reachable) throw new Error(probe.message);
  else {
    describeProbe(p, probe);
    if (probe.auth === "oauth" && probe.registration === "manual") throw new Error(MANUAL_CLIENT);
    if (probe.auth === "header") header = await headerFor(p, flags);
  }
  const slug = await askSlug(p, flags.slug, slugFromUrl(url), taken);
  return createThen({ slug, name: url.hostname, url: url.href }, flags, deps, async (c) => {
    if (allowPrivate) {
      await api.allowPrivateTarget(c.id, true);
      const again = await api.probe(url.href, c.id);
      if (again.blocked || !again.reachable) throw new Error(again.message);
      describeProbe(p, again);
      if (again.auth === "oauth" && again.registration === "manual") throw new Error(MANUAL_CLIENT);
      if (again.auth === "header") header = await headerFor(p, flags);
    }
    return connectNow(c, header ? { header } : {}, deps, flags);
  });
}

export async function addConnection(target: string, flags: AddFlags, deps: ManageDeps): Promise<number> {
  const existing = await deps.api.list();
  const taken = new Set(existing.map((c) => c.slug));
  if (isUrl(target)) return addUrl(target, flags, deps, taken);
  const presets = await deps.api.presets();
  const preset = presets.find((x) => x.id === target.trim().toLowerCase());
  if (!preset) throw new Error(`Unknown integration "${target}". Use ${[...presets.map((x) => x.id), "<an MCP server URL>"].join(", ")}.`);
  return addPreset(preset, flags, deps, taken);
}

export async function listConnections(deps: ManageDeps): Promise<number> {
  const { api, prompter: p } = deps;
  const all = await api.list();
  if (!all.length) {
    p.print(`No connections yet. Add one: ${NPX} connections add notion|whoop|<url>`);
    return 0;
  }
  const w = Math.max(4, ...all.map((c) => c.slug.length));
  p.print(pc.dim(`${"NAME".padEnd(w)}  ${"STATUS".padEnd(12)}  ${"ACCESS".padEnd(24)}  ${"TOOLS".padEnd(5)}  URL`));
  for (const c of all) {
    const status = c.status === "active" ? pc.green(c.status.padEnd(12)) : pc.yellow(c.status.padEnd(12));
    const notes: string[] = [];
    if (c.privateTarget) notes.push("private network");
    const d = c.expiresInDays;
    if (d !== null && d <= 7) notes.push(d <= 0 ? "expires today: Reconnect" : `expires in ${d} day${d === 1 ? "" : "s"}`);
    if (c.tools.held) notes.push(`${c.tools.held} held`);
    if (c.status === "needs_reauth") notes.push("Reconnect");
    p.print(
      `${c.slug.padEnd(w)}  ${status}  ${accessLabel(c.levelDefault).padEnd(24)}  ${String(c.tools.total).padEnd(5)}  ${safeText(c.url ?? c.kind, 80)}${notes.length ? pc.yellow(`  (${notes.join(", ")})`) : ""}`,
    );
  }
  return 0;
}

export async function reconnectConnection(slug: string, flags: { paste?: boolean; header?: string }, deps: ManageDeps): Promise<number> {
  const { api, prompter: p } = deps;
  const c = await api.bySlug(slug);
  const after = await connectNow(c, c.authType === "header" ? { header: await headerFor(p, flags) } : {}, deps, flags);
  printResult(p, after);
  return after.status === "active" ? 0 : 1;
}

export async function disableConnection(slug: string, deps: ManageDeps): Promise<number> {
  const { api, prompter: p } = deps;
  const c = await api.bySlug(slug);
  if (!(await p.confirm(`Disable "${slug}"? Agents lose its tools at once, its pending approvals are cancelled and its stored credentials are deleted.`, false))) return 0;
  await api.kill(c.id);
  p.print(`${pc.green("✔")} Disabled "${slug}". To use it again, turn it on in the console's Connections page and reconnect.`);
  return 0;
}

export async function removeConnection(slug: string, deps: ManageDeps): Promise<number> {
  const { api, prompter: p } = deps;
  const c = await api.bySlug(slug);
  if (!(await p.confirm(`Remove "${slug}" and delete its stored credentials? This can't be undone.`, false))) return 0;
  await api.remove(c.id);
  p.print(`${pc.green("✔")} Removed "${slug}".`);
  return 0;
}
