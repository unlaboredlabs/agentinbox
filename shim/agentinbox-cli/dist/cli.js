#!/usr/bin/env node
// agentinbox-cli is now xaq-cli. This shim says so, then runs xaq-cli's own CLI with the same arguments.
//
// It runs xaq-cli in this same process (an import, not a child process), so a service an older
// agentinbox-cli installed, which starts this file as `node …/agentinbox-cli/dist/cli.js start`, keeps
// working with the same pid, signals and exit code, and the service manager still sees its own process.
// The path dist/cli.js matters for the same reason: older installers check that it exists.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const service = process.env.XAQ_SERVICE === "1" || process.env.AGENTINBOX_SERVICE === "1";
if (!service) process.stderr.write("agentinbox is now xaq: use `npx xaq-cli …` (or `xaq …` once installed with npm i -g xaq-cli).\n");
// xaq-cli would print the same notice when started as `agentinbox`: once is enough.
globalThis.__xaqShimNotice = true;

const pkg = createRequire(import.meta.url).resolve("xaq-cli/package.json");
await import(pathToFileURL(join(dirname(pkg), "dist", "cli.js")).href);
