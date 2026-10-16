// Webhook reachability (server/broker/reachability.ts): an https public URL isn't proof the internet can reach it.
// DNS and the Tailscale CLI are fakes; nothing here touches the network or runs tailscale.

import { describe, expect, it } from "vitest";
import { type ReachabilityDeps, checkWebhookReachability, classifyByDns, classifyHost, reachabilityCache } from "../server/broker/reachability.ts";

const LOCAL = "http://127.0.0.1:8425";
const HOST = "box.tail1234.ts.net";

function fakes(answers: Record<string, string[]>, serve: unknown = null) {
  const calls = { lookup: 0, tailscale: [] as string[][] };
  const deps: ReachabilityDeps = {
    lookup: async (host) => {
      calls.lookup++;
      const a = answers[host];
      if (!a) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    tailscale: async (args) => {
      calls.tailscale.push(args);
      return serve === null ? null : { bin: "tailscale", stdout: typeof serve === "string" ? serve : JSON.stringify(serve) };
    },
  };
  return { deps, calls };
}

/** Console on 443 through `tailscale serve`, no Funnel. */
const SERVE_ONLY = { TCP: { "443": { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: LOCAL } } } } };

describe("classifyHost", () => {
  it("loopback, private, CGNAT (Tailscale), link-local, ULA, .local, localhost and bare names are private", () => {
    for (const h of ["localhost", "app.localhost", "127.0.0.1", "::1", "10.1.2.3", "172.20.0.1", "192.168.1.10", "100.101.102.103", "169.254.1.1", "fd7a:115c:a1e0::1", "nas.local", "nas", "xaq.internal", "router.home.arpa"]) {
      expect(classifyHost(h), h).toBe("private");
    }
  });

  it("a public IP literal is public; an ordinary name needs DNS", () => {
    expect(classifyHost("93.184.216.34")).toBe("public");
    expect(classifyHost("2606:4700::1111")).toBe("public");
    expect(classifyHost("100.128.0.1")).toBe("public"); // just past CGNAT's 100.64.0.0/10
    expect(classifyHost("inbox.example.com")).toBeNull();
    expect(classifyHost(HOST)).toBeNull();
  });
});

describe("classifyByDns", () => {
  it("only private answers: private; any public one: public; failure, no answers or a timeout: unknown", async () => {
    const { deps } = fakes({ "split.example.com": ["192.168.1.5"], "mixed.example.com": ["10.0.0.1", "93.184.216.34"], "empty.example.com": [] });
    expect(await classifyByDns("split.example.com", deps.lookup)).toBe("private");
    expect(await classifyByDns("mixed.example.com", deps.lookup)).toBe("public");
    expect(await classifyByDns("empty.example.com", deps.lookup)).toBe("unknown");
    expect(await classifyByDns("nope.example.com", deps.lookup)).toBe("unknown");
    expect(await classifyByDns("slow.example.com", () => new Promise(() => {}), 10)).toBe("unknown");
  });
});

describe("checkWebhookReachability", () => {
  it("a public host: public, webhooks to the public URL, the Tailscale CLI never asked", async () => {
    const { deps, calls } = fakes({ "inbox.example.com": ["93.184.216.34"] });
    expect(await checkWebhookReachability("https://inbox.example.com/", LOCAL, deps)).toMatchObject({ reach: "public", webhookBase: "https://inbox.example.com", funnel: null });
    expect(calls.tailscale).toEqual([]);
  });

  it("public over plain http: no webhook URL (WHOOP delivers to https only)", async () => {
    const { deps } = fakes({ "inbox.example.com": ["93.184.216.34"] });
    expect(await checkWebhookReachability("http://inbox.example.com", LOCAL, deps)).toMatchObject({ reach: "public", webhookBase: null });
  });

  it("private hosts never reach DNS; a name that doesn't resolve is unknown", async () => {
    const { deps, calls } = fakes({});
    expect(await checkWebhookReachability("http://localhost:8425", LOCAL, deps)).toMatchObject({ reach: "private", webhookBase: null, funnel: null });
    expect(await checkWebhookReachability("https://192.168.1.10", LOCAL, deps)).toMatchObject({ reach: "private", webhookBase: null });
    expect(calls.lookup).toBe(0);
    expect(await checkWebhookReachability("https://gone.example.com", LOCAL, deps)).toMatchObject({ reach: "unknown", webhookBase: null, funnel: null });
  });

  it("*.ts.net resolving to 100.x without the Tailscale CLI: private, no offer", async () => {
    const { deps, calls } = fakes({ [HOST]: ["100.101.102.103"] });
    expect(await checkWebhookReachability(`https://${HOST}`, LOCAL, deps)).toMatchObject({ reach: "private", webhookBase: null, funnel: null });
    expect(calls.tailscale).toEqual([["serve", "status", "--json"]]);
  });

  it("a CLI that fails or prints garbage counts as missing", async () => {
    const throwing: ReachabilityDeps = { ...fakes({ [HOST]: ["100.101.102.103"] }).deps, tailscale: () => Promise.reject(new Error("ENOENT")) };
    expect(await checkWebhookReachability(`https://${HOST}`, LOCAL, throwing)).toMatchObject({ reach: "private", funnel: null });
    expect(await checkWebhookReachability(`https://${HOST}`, LOCAL, fakes({ [HOST]: ["100.101.102.103"] }, "not json").deps)).toMatchObject({ reach: "private", funnel: null });
  });

  it("tailnet-only with the CLI: offers Funnel of the hooks path only, on a port the console doesn't use", async () => {
    const r = await checkWebhookReachability(`https://${HOST}`, LOCAL, fakes({ [HOST]: ["100.101.102.103"] }, SERVE_ONLY).deps);
    expect(r).toMatchObject({ reach: "private", webhookBase: null });
    expect(r.funnel).toEqual({
      port: 8443,
      origin: `https://${HOST}:8443`,
      command: `tailscale funnel --bg --https=8443 --set-path=/hooks/connections ${LOCAL}/hooks/connections`,
      offCommand: "tailscale funnel --https=8443 --set-path=/hooks/connections off",
    });
    // Never the console's port, never the root path.
    expect(r.funnel!.command).not.toMatch(/--https=443\b|--set-path=\/(\s|$)/);

    // The console on 8443: the next allowed Funnel port.
    const on8443 = { TCP: { "8443": { HTTPS: true } }, Web: { [`${HOST}:8443`]: { Handlers: { "/": { Proxy: LOCAL } } } } };
    const r2 = await checkWebhookReachability(`https://${HOST}:8443`, LOCAL, fakes({ [HOST]: ["100.101.102.103"] }, on8443).deps);
    expect(r2.funnel).toMatchObject({ port: 10000, command: expect.stringContaining("--https=10000 --set-path=/hooks/connections") });
  });

  it("the macOS app's binary is what the offered command names when it answered", async () => {
    const { deps } = fakes({ [HOST]: ["100.101.102.103"] });
    const app = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
    const r = await checkWebhookReachability(`https://${HOST}`, LOCAL, { ...deps, tailscale: async () => ({ bin: app, stdout: JSON.stringify(SERVE_ONLY) }) });
    expect(r.funnel!.command.startsWith(`${app} funnel --bg`)).toBe(true);
  });

  it("after the Funnel command ran: webhooks go to the Funnel origin, and nothing is offered", async () => {
    const funnelled = {
      ...SERVE_ONLY,
      TCP: { ...SERVE_ONLY.TCP, "8443": { HTTPS: true } },
      Web: { ...SERVE_ONLY.Web, [`${HOST}:8443`]: { Handlers: { "/hooks/connections": { Proxy: `${LOCAL}/hooks/connections` } } } },
      AllowFunnel: { [`${HOST}:8443`]: true },
    };
    expect(await checkWebhookReachability(`https://${HOST}`, LOCAL, fakes({ [HOST]: ["100.101.102.103"] }, funnelled).deps)).toMatchObject({
      reach: "private",
      webhookBase: `https://${HOST}:8443`,
      funnel: null,
    });
    // A foreground (no --bg) session counts too.
    const foreground = { ...SERVE_ONLY, Foreground: { s1: { TCP: { "8443": { HTTPS: true } }, Web: funnelled.Web, AllowFunnel: funnelled.AllowFunnel } } };
    expect(await checkWebhookReachability(`https://${HOST}`, LOCAL, fakes({ [HOST]: ["100.101.102.103"] }, foreground).deps)).toMatchObject({ webhookBase: `https://${HOST}:8443` });
  });

  it("Funnel on the public URL's own port (the owner funnelled the console): public", async () => {
    const all = { ...SERVE_ONLY, AllowFunnel: { [`${HOST}:443`]: true } };
    expect(await checkWebhookReachability(`https://${HOST}`, LOCAL, fakes({ [HOST]: ["100.101.102.103"] }, all).deps)).toMatchObject({ reach: "public", webhookBase: `https://${HOST}`, funnel: null });
  });
});

describe("reachabilityCache", () => {
  it("unknown until checked, then cached per public URL; a new URL checks again", async () => {
    let url = "https://inbox.example.com";
    const { deps, calls } = fakes({ "inbox.example.com": ["93.184.216.34"], [HOST]: ["100.101.102.103"] });
    let t = 0;
    const cache = reachabilityCache({ publicUrl: () => url, localOrigin: () => LOCAL, deps, now: () => t, ttlMs: 1000 });
    expect(cache.current().reach).toBe("unknown");
    expect((await cache.check()).reach).toBe("public");
    expect(cache.current().reach).toBe("public");
    await cache.check();
    expect(calls.lookup).toBe(1);
    t = 2000;
    await cache.check();
    expect(calls.lookup).toBe(2);
    url = `https://${HOST}`;
    expect(cache.current().reach).toBe("unknown");
    expect((await cache.check()).reach).toBe("private");
  });
});
