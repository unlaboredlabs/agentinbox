import pc from "picocolors";
import type { SetupStep } from "../broker/types.ts";
import { safeText } from "../listen/ui.ts";
import { NPX } from "../listen/version.ts";
import { accessLabel, agentsLabel, chooseAccess, chooseAgents, parseAccess } from "./access.ts";
import type { ConnectionsApi, ConnectionView, CreateInput, PresetView, ProbeResult } from "./api.ts";
import type { Prompter } from "./prompt.ts";
import { exactOrigin } from "./private.ts";
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
export function renderStep(step: SetupStep, n: number): string[] {
  const out = [pc.bold(`${n}. ${safeText(step.title, 120)}`)];
  for (const para of step.body.split(/\n{2,}/)) out.push(`   ${para.replace(/\s*\n\s*/g, " ").replace(/`([^`]+)`/g, (_m, c: string) => pc.cyan(c))}`);
  if (step.link) out.push(`   ${step.link.label}: ${pc.cyan(step.link.url)}`);
  if (step.copy) out.push(`   ${step.copy.label}: ${pc.cyan(step.copy.value)}`);
  return out;
}

async function askInput(p: Prompter, input: NonNullable<SetupStep["input"]>): Promise<string> {
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
const loopbackRedirect = (uri: string) => {
  try {
    const h = new URL(uri).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
};

/** OAuth: open the browser and wait, or (over SSH, or when the install can't be redirected to) paste the address. */
export async function authorize(conn: ConnectionView, deps: ManageDeps, flags: { paste?: boolean } = {}): Promise<ConnectionView> {
  const { api, prompter: p } = deps;
  const start = await api.authorize(conn.id);
  const env = deps.env ?? process.env;
  const paste = flags.paste || start.callbackMode === "paste" || (overSsh(env) && loopbackRedirect(start.redirectUri));
  if (paste) {
    p.print(`Open this link in a browser where you can sign in to ${safeText(conn.displayName, 60)}:`);
    p.print(`  ${pc.cyan(start.authorizeUrl)}`);
    p.print(
      pc.dim(`After you approve, the browser goes to an address starting with ${start.redirectUri} (it may say the page can't be reached). Copy that whole address.`),
    );
    for (;;) {
      const pasted = await p.ask("Paste the address here");
      if (pasted.startsWith(start.redirectUri.replace(/\/+$/, "")) || /[?&](code|error)=/.test(pasted)) return api.completeAuthorize(conn.id, pasted);
      p.print(pc.yellow(`  That isn't the address after signing in: it starts with ${start.redirectUri}.`));
    }
  }
  p.print(`Opening your browser to sign in to ${safeText(conn.displayName, 60)}. If it doesn't open, use this link:`);
  p.print(`  ${pc.cyan(start.authorizeUrl)}`);
  try {
    await (deps.openBrowser ?? (async (u: string) => (await import("open")).default(u)))(start.authorizeUrl);
  } catch {
    // The link is printed.
  }
  const pollMs = deps.pollMs ?? 2000;
  const deadline = Date.now() + (deps.timeoutMs ?? 10 * 60_000);
  p.print(pc.dim("Waiting for you to approve in the browser… (Ctrl+C to stop)"));
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const now = await api.get(conn.id);
    if (now?.status === "active") return now;
  }
  throw new Error(`Timed out waiting for the sign-in. Try again with \`${NPX} connections reconnect ${conn.slug}\`${overSsh(env) ? "" : " (add --paste to paste the address instead)"}.`);
}

function printResult(p: Prompter, c: ConnectionView): void {
  if (c.status === "active") {
    p.print(`${pc.green("✔")} Connected "${c.slug}"${c.toolCount !== undefined ? `: ${c.toolCount} tools, seen by agents as ${c.slug}__<tool>` : ""} (${accessLabel(c.level)}).`);
  } else {
    p.print(`${pc.yellow("○")} "${c.slug}" was added but is ${c.status}${c.statusReason ? `: ${safeText(c.statusReason, 200)}` : ""}.`);
    p.print(`  ${reconnectHint(c)}`);
  }
}

async function finishCreate(input: Omit<CreateInput, "level" | "agents">, oauth: boolean, flags: AddFlags, deps: ManageDeps): Promise<number> {
  const { api, prompter: p } = deps;
  const level = await chooseAccess(p, flags.access ? parseAccess(flags.access) : undefined);
  const agents = await chooseAgents(p, api, flags.agent);
  if (!(await p.confirm(`Add "${input.slug}" (${accessLabel(level)}, ${agentsLabel(agents)})?`, true))) {
    p.print("Nothing was added.");
    return 0;
  }
  let conn = await api.create({ ...input, level, agents });
  if (oauth && conn.status !== "active") conn = await authorize(conn, deps, flags);
  printResult(p, conn);
  return conn.status === "active" ? 0 : 1;
}

async function addPreset(preset: PresetView, flags: AddFlags, deps: ManageDeps, taken: Set<string>): Promise<number> {
  const p = deps.prompter;
  p.print(pc.bold(`Connect ${safeText(preset.displayName, 60)}`));
  const inputs: Record<string, string> = {};
  preset.steps.forEach((step, i) => {
    for (const l of renderStep(step, i + 1)) p.print(l);
  });
  for (const step of preset.steps) if (step.input) inputs[step.input.key] = await askInput(p, step.input);
  const slug = await askSlug(p, flags.slug, preset.slug, taken);
  let auth: CreateInput["auth"] = { type: preset.authType === "mcp_oauth" || preset.authType === "user_app" ? "oauth" : "none" };
  if (preset.authType === "header") {
    const name = preset.headerName ?? "Authorization";
    const value = await askInput(p, { key: "header", label: `${name} value`, secret: true });
    auth = { type: "header", name, value: preset.headerPrefix && !value.startsWith(preset.headerPrefix) ? `${preset.headerPrefix}${value}` : value };
  }
  return finishCreate({ preset: preset.id, slug, displayName: preset.displayName, auth, inputs: Object.keys(inputs).length ? inputs : undefined }, auth.type === "oauth", flags, deps);
}

async function addUrl(raw: string, flags: AddFlags, deps: ManageDeps, taken: Set<string>): Promise<number> {
  const { api, prompter: p } = deps;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`"${raw}" isn't a URL. Use the server's full MCP address, e.g. https://mcp.example.com/mcp.`);
  }
  p.print(`Checking ${pc.cyan(url.href)}…`);
  let privateTarget: string | null = null;
  let probe: ProbeResult = await api.probe({ url: url.href });
  if (!probe.ok && probe.code === "private_target") {
    const origin = probe.origin ?? exactOrigin(url);
    p.print(pc.yellow(`${url.host} is on this machine or your private network${probe.address ? ` (${probe.address})` : ""}.`));
    p.print(
      "agentinbox blocks those by default: a connection to a server there can reach other services on the same machine or network. " +
        `An allow covers exactly ${origin}, for this connection only (and plain http on that host).`,
    );
    if (!(await p.confirm(`Allow this connection to reach ${origin}?`, false))) {
      p.print("Nothing was added.");
      return 0;
    }
    privateTarget = origin;
    probe = await api.probe({ url: url.href, privateTarget });
  }
  if (!probe.ok) throw new Error(`${probe.message}${probe.hint ? ` ${probe.hint}` : ""}`);
  let auth: CreateInput["auth"];
  if (probe.auth.type === "oauth") {
    p.print(`It signs in with OAuth via ${safeText(probe.auth.issuer, 120)}, and ${registrationWords[probe.auth.registration] ?? probe.auth.registration}.`);
    auth = { type: "oauth" };
    if (probe.auth.registration === "manual") auth.clientId = await askInput(p, { key: "clientId", label: "Client ID" });
  } else if (probe.auth.type === "header") {
    p.print(`It needs an API key or token${probe.message ? `: ${safeText(probe.message, 200)}` : "."}`);
    const name = flags.header ?? (await p.ask("Header name", "Authorization"));
    const value = await askInput(p, { key: "header", label: `${name} value (not shown)`, secret: true });
    auth = { type: "header", name, value: /^authorization$/i.test(name) && !/\s/.test(value) ? `Bearer ${value}` : value };
  } else {
    p.print("It doesn't need a sign-in.");
    auth = { type: "none" };
  }
  const slug = await askSlug(p, flags.slug, slugFromUrl(url), taken);
  return finishCreate({ slug, url: url.href, auth, privateTarget }, auth.type === "oauth", flags, deps);
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

const daysLeft = (iso: string | null | undefined, now: number) => (iso ? Math.floor((Date.parse(iso) - now) / 86_400_000) : null);

export async function listConnections(deps: ManageDeps, now = Date.now()): Promise<number> {
  const { api, prompter: p } = deps;
  const all = await api.list();
  if (!all.length) {
    p.print(`No connections yet. Add one: ${NPX} connections add notion|whoop|<url>`);
    return 0;
  }
  const w = Math.max(4, ...all.map((c) => c.slug.length));
  p.print(pc.dim(`${"NAME".padEnd(w)}  ${"STATUS".padEnd(12)}  ${"ACCESS".padEnd(24)}  URL`));
  for (const c of all) {
    const status = c.status === "active" ? pc.green(c.status.padEnd(12)) : pc.yellow(c.status.padEnd(12));
    const notes: string[] = [];
    if (c.privateTarget) notes.push("private network");
    const d = daysLeft(c.expiresAt, now);
    if (d !== null && d <= 7) notes.push(d < 0 ? "expired: Reconnect" : `expires in ${d} day${d === 1 ? "" : "s"}`);
    if (c.status === "needs_reauth") notes.push("Reconnect");
    p.print(`${c.slug.padEnd(w)}  ${status}  ${accessLabel(c.level).padEnd(24)}  ${safeText(c.url ?? c.kind, 80)}${notes.length ? pc.yellow(`  (${notes.join(", ")})`) : ""}`);
  }
  return 0;
}

export async function reconnectConnection(slug: string, flags: { paste?: boolean }, deps: ManageDeps): Promise<number> {
  const { api, prompter: p } = deps;
  const c = await api.bySlug(slug);
  let after: ConnectionView;
  if (c.authType === "oauth") after = await authorize(c, deps, flags);
  else if (c.authType === "header") {
    const value = await askInput(p, { key: "header", label: `New value for its header (not shown)`, secret: true });
    const name = c.headerName ?? "Authorization";
    after = await api.setHeader(c.id, name, /^authorization$/i.test(name) && !/\s/.test(value) ? `Bearer ${value}` : value);
  } else {
    p.print(`"${slug}" doesn't sign in, so there's nothing to reconnect.`);
    return 0;
  }
  printResult(p, after);
  return after.status === "active" ? 0 : 1;
}

export async function disableConnection(slug: string, deps: ManageDeps): Promise<number> {
  const { api, prompter: p } = deps;
  const c = await api.bySlug(slug);
  if (!(await p.confirm(`Disable "${slug}"? Agents lose its tools at once and its pending approvals are cancelled.`, false))) return 0;
  await api.disable(c.id);
  p.print(`${pc.green("✔")} Disabled "${slug}". Turn it back on in the console's Connections page.`);
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
