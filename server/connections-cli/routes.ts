import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hermesHome } from "../listen/mcpsetup.ts";
import type { ImportClient } from "./clients.ts";
import { readTopMap, UNREADABLE, type YamlValue } from "./yaml.ts";

/**
 * Places in a client's config that confine something to the agentinbox MCP server alone: Hermes platform toolsets,
 * webhook routes (`toolsets: ["mcp-agentinbox", …]`) and cron jobs (`enabled_toolsets: ["agentinbox"]`). Once the
 * imported servers are served through agentinbox, each of these also sees their tools, so `import` warns before
 * replacing anything (docs/listen.md: an email-triggered route confined to agentinbox).
 */
export function confinedRoutes(client: ImportClient, serverName: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (client !== "hermes") return [];
  const home = hermesHome(env);
  const names = new Set([serverName, `mcp-${serverName}`]);
  const confines = (v: unknown) => Array.isArray(v) && v.some((x) => typeof x === "string" && names.has(x));
  const out: string[] = [];
  const read = (file: string): unknown => {
    try {
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) : null;
    } catch {
      return null;
    }
  };
  try {
    const config = join(home, "config.yaml");
    if (existsSync(config)) {
      const yaml = readFileSync(config, "utf8");
      const platforms = readTopMap(yaml, "platform_toolsets") ?? {};
      for (const [platform, toolsets] of Object.entries(platforms)) if (confines(toolsets)) out.push(`platform_toolsets.${platform} (config.yaml)`);
      // Static webhook routes: platforms.webhook.extra.routes, a map of name → route or a list of routes.
      const get = (v: YamlValue | undefined, k: string): YamlValue | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, YamlValue>)[k] : undefined);
      const routes = get(get(get(readTopMap(yaml, "platforms") ?? undefined, "webhook"), "extra"), "routes");
      if (routes === UNREADABLE || (Array.isArray(routes) && routes.some((r) => r === UNREADABLE))) {
        out.push("webhook routes in config.yaml (platforms.webhook.extra.routes: couldn't be read, so check their toolsets)");
      } else if (Array.isArray(routes)) {
        routes.forEach((r, i) => {
          if (confines(get(r, "toolsets"))) out.push(`webhook route ${String(get(r, "name") ?? `#${i + 1}`)} (config.yaml)`);
        });
      } else if (routes && typeof routes === "object") {
        for (const [name, r] of Object.entries(routes as Record<string, YamlValue>)) if (confines(get(r, "toolsets"))) out.push(`webhook route ${name} (config.yaml)`);
      }
    }
  } catch {
    // Unreadable: nothing to warn about from it.
  }
  const subs = read(join(home, "webhook_subscriptions.json"));
  if (subs && typeof subs === "object" && !Array.isArray(subs)) {
    for (const [route, r] of Object.entries(subs as Record<string, { toolsets?: unknown }>)) if (confines(r?.toolsets)) out.push(`webhook route ${route}`);
  }
  const cron = read(join(home, "cron", "jobs.json"));
  const jobs = (Array.isArray(cron) ? cron : ((cron as { jobs?: unknown } | null)?.jobs ?? [])) as { id?: unknown; name?: unknown; enabled_toolsets?: unknown }[];
  if (Array.isArray(jobs)) for (const j of jobs) if (confines(j?.enabled_toolsets)) out.push(`cron job ${String(j.name ?? j.id ?? "?")}`);
  return out;
}
