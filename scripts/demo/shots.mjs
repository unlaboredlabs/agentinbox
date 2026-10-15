// Screenshots of console routes against a running demo (scripts/demo/seed.ts).
//
//   node scripts/demo/shots.mjs --state /tmp/agentinbox-demo-8531.json --out /tmp/shots \
//     --routes /,/accounts,/agents --sizes 1440x900,390x844 --themes light,dark [--full] [--scale 2] [--base http://127.0.0.1:5173]
//
// Needs playwright-core and a Chromium: set PLAYWRIGHT_CORE (module path) and CHROMIUM (executable) if
// they are not resolvable from here. Each route may carry a name: "overview=/".

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({
  options: {
    state: { type: "string", default: "/tmp/agentinbox-demo-8531.json" },
    out: { type: "string", default: "/tmp/shots" },
    routes: { type: "string", default: "/" },
    sizes: { type: "string", default: "1440x900" },
    themes: { type: "string", default: "light" },
    full: { type: "boolean", default: false },
    scale: { type: "string", default: "2" },
    base: { type: "string" },
    wait: { type: "string", default: "700" },
    anon: { type: "boolean", default: false },
  },
});

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const state = JSON.parse(readFileSync(a.state, "utf8"));
const base = a.base ?? state.url;
mkdirSync(a.out, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
for (const theme of a.themes.split(",")) {
  for (const size of a.sizes.split(",")) {
    const [width, height] = size.split("x").map(Number);
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, deviceScaleFactor: Number(a.scale) });
    if (state.cookie && !a.anon) {
      const [name, value] = state.cookie.split("=");
      await context.addCookies([{ name, value, url: base }]);
    }
    await context.addInitScript((t) => localStorage.setItem("agentinbox.theme", t), theme);
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("pageerror", e.message));
    page.on("console", (m) => m.type() === "error" && console.error("console", m.text()));
    for (const spec of a.routes.split(",")) {
      const [name, route] = spec.includes("=") ? spec.split("=") : [spec.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "root", spec];
      await page.goto(base + route, { waitUntil: "networkidle" }).catch(() => {});
      await page.waitForTimeout(Number(a.wait));
      const file = join(a.out, `${name}-${width}-${theme}.png`);
      await page.screenshot({ path: file, fullPage: a.full });
      console.log(file);
    }
    await context.close();
  }
}
await browser.close();
