// Pre-made integrations (docs/MCP-BROKER.md "Pre-made integrations"). Each preset lives in
// server/integrations/<id>/ and adds one entry to the list below; the broker service, the connections API
// (presets list, create from a preset) and the classifier read them from here.
//
// Rules for entries:
// - `id` is stored in connections.preset (checked here, not by the schema) and names its events `<id>.<name>`;
//   it can't be one of xaq's own event prefixes (message, calendar, connection, approval, …).
// - Remote presets (Notion) give `url` and `auth`; native ones (WHOOP) give `createSource` (and `events`).
// - Remote presets whose server the user names (T3 Code) give `userServer` instead of `url`.

import type { IntegrationPreset } from "../broker/types.ts";
import { notionPreset } from "./notion/index.ts";
import { t3codePreset } from "./t3code/index.ts";
import { whoopPreset } from "./whoop/index.ts";

let cached: IntegrationPreset[] | null = null;

/** Every pre-made integration, in display order. Built once: native presets keep per-process state. */
export const presets = (): IntegrationPreset[] => (cached ??= [notionPreset, whoopPreset(), t3codePreset]);

export const presetById = (id: string): IntegrationPreset | null => presets().find((p) => p.id === id) ?? null;
