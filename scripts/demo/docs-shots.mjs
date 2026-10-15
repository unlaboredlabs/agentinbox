// Regenerates docs/screenshots/*.png against two running demos (scripts/demo/seed.ts):
//
//   pnpm exec tsx scripts/demo/seed.ts --port 8531                       seeded instance
//   pnpm exec tsx scripts/demo/seed.ts --port 8532 --fresh --stage pubsub  wizard at the Pub/Sub step
//   node scripts/demo/docs-shots.mjs [--out docs/screenshots] [--only name,name]
//
// Console URLs default to the daemons themselves (serving dist/web); pass --app / --wizard to use Vite
// dev servers instead. Needs PLAYWRIGHT_CORE (module path) and CHROMIUM (executable) unless resolvable.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({
  options: {
    out: { type: "string", default: "docs/screenshots" },
    app: { type: "string" },
    wizard: { type: "string" },
    only: { type: "string" },
  },
});
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const demo = JSON.parse(readFileSync("/tmp/agentinbox-demo-8531.json", "utf8"));
const fresh = JSON.parse(readFileSync("/tmp/agentinbox-demo-8532.json", "utf8"));
const APP = a.app ?? demo.url;
const WIZ = a.wizard ?? fresh.url;
const only = a.only?.split(",");

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });

async function session(base, cookie, { theme = "light", width = 1440, height = 900, scale = 1.5 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: scale });
  const [name, value] = cookie.split("=");
  await ctx.addCookies([{ name, value, url: base }]);
  await ctx.addInitScript((t) => localStorage.setItem("agentinbox.theme", t), theme);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("pageerror", e.message));
  return { page, ctx, go: (path) => page.goto(base + path, { waitUntil: "networkidle" }).then(() => page.waitForTimeout(800)) };
}

const api = (path) => fetch(demo.url + path, { headers: { cookie: demo.cookie } }).then((r) => r.json());
const agents = await api("/api/agents");
const agentId = (prefix) => agents.find((x) => x.name.startsWith(prefix))?.id;
const webhooks = await api("/api/webhooks");
const pending = (await api("/api/pairings?status=pending"))[0];

const shots = {
  async overview() {
    const s = await session(APP, demo.cookie);
    await s.go("/");
    return [s, {}];
  },
  async "overview-dark"() {
    const s = await session(APP, demo.cookie, { theme: "dark" });
    await s.go("/");
    return [s, {}];
  },
  async "overview-mobile"() {
    const s = await session(APP, demo.cookie, { width: 390, height: 844, scale: 2 });
    await s.go("/");
    return [s, {}];
  },
  async accounts() {
    const s = await session(APP, demo.cookie, { height: 560 });
    await s.go("/accounts");
    return [s, {}];
  },
  async agents() {
    const s = await session(APP, demo.cookie, { height: 760 });
    await s.go("/agents");
    return [s, {}];
  },
  async "connect-agent"() {
    const s = await session(APP, demo.cookie, { height: 1000 });
    await s.go("/agents?connect=true");
    await s.page.locator("[role=dialog] h2").focus();
    return [s, {}];
  },
  async "agent-grant-editor"() {
    const s = await session(APP, demo.cookie, { height: 1300 });
    await s.go(`/agents/${agentId("Billing")}`);
    await s.page.getByRole("button", { name: /^Edit/ }).first().click();
    await s.page.waitForTimeout(500);
    return [s, {}];
  },
  async "agent-listeners"() {
    const s = await session(APP, demo.cookie, { height: 1150 });
    await s.go(`/agents/${agentId("Claude Code")}`);
    await s.page.evaluate(() => {
      const el = [...document.querySelectorAll("[data-slot=card-title]")].find((e) => e.textContent?.includes("Give it the tools"));
      if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 120);
    });
    await s.page.waitForTimeout(300);
    return [s, {}];
  },
  async "pairing-request"() {
    const s = await session(APP, demo.cookie, { height: 860 });
    await s.go(`/approvals?pairing=${pending.userCode}`);
    await s.page.evaluate(() => window.scrollTo(0, 0));
    return [s, {}];
  },
  async "pairing-approve"() {
    const s = await session(APP, demo.cookie, { height: 1100 });
    await s.go(`/approvals?pairing=${pending.userCode}`);
    await s.page.getByRole("button", { name: "Review and approve" }).first().click();
    await s.page.waitForTimeout(400);
    await s.page.locator("#pairing-code").pressSequentially(pending.userCode.replace("-", ""), { delay: 20 });
    await s.page.getByRole("radio", { name: /Read and draft/ }).first().click();
    await s.page.locator("[role=dialog]").evaluate((d) => (d.scrollTop = 0));
    await s.page.waitForTimeout(300);
    return [s, {}];
  },
  async approvals() {
    const s = await session(APP, demo.cookie, { height: 820 });
    await s.go("/approvals");
    return [s, {}];
  },
  async "webhook-deliveries"() {
    const s = await session(APP, demo.cookie, { height: 1000 });
    await s.go(`/webhooks/${webhooks.find((w) => w.name.startsWith("Slack")).id}`);
    await s.page.getByRole("row").nth(3).click();
    await s.page.waitForTimeout(300);
    return [s, {}];
  },
  async events() {
    const s = await session(APP, demo.cookie);
    await s.go("/events");
    return [s, {}];
  },
  async audit() {
    const s = await session(APP, demo.cookie);
    await s.go("/audit");
    await s.page.getByRole("row").nth(2).click();
    await s.page.waitForTimeout(300);
    return [s, {}];
  },
  async "audit-dark"() {
    const s = await session(APP, demo.cookie, { theme: "dark" });
    await s.go("/audit");
    return [s, {}];
  },
  async settings() {
    const s = await session(APP, demo.cookie, { height: 1100 });
    await s.go("/settings");
    await s.page.evaluate(() => {
      const el = document.getElementById("pairing");
      if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 340);
    });
    await s.page.waitForTimeout(300);
    return [s, {}];
  },
  async "wizard-consent"() {
    const s = await session(WIZ, fresh.cookie, { height: 1250 });
    await s.go("/get-started");
    await s.page.getByRole("navigation", { name: "Setup steps" }).getByText("Consent screen").click();
    await s.page.getByRole("radio", { name: /External/ }).click();
    await s.page.waitForTimeout(400);
    return [s, {}];
  },
  async "wizard-oauth-client"() {
    const s = await session(WIZ, fresh.cookie, { height: 1000 });
    await s.go("/get-started");
    await s.page.getByRole("navigation", { name: "Setup steps" }).getByText("OAuth client").click();
    await s.page.waitForTimeout(400);
    return [s, {}];
  },
  async "wizard-pubsub"() {
    const s = await session(WIZ, fresh.cookie, { height: 860 });
    await s.go("/get-started");
    await s.page.getByRole("navigation", { name: "Setup steps" }).getByText("Real-time delivery").click();
    await s.page.waitForTimeout(400);
    return [s, {}];
  },
};

for (const [name, fn] of Object.entries(shots)) {
  if (only && !only.includes(name)) continue;
  try {
    const [s] = await fn();
    const file = join(a.out, `${name}.png`);
    await s.page.screenshot({ path: file });
    await s.ctx.close();
    console.log(file);
  } catch (err) {
    console.error(`${name}: ${err.message.split("\n")[0]}`);
  }
}
await browser.close();
