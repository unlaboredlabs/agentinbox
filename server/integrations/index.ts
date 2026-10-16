// Pre-made integrations (docs/MCP-BROKER.md "Pre-made integrations"). Each preset lives in
// server/integrations/<id>/ and adds one entry to PRESETS below; the broker service, the connections API
// (presets list, create from a preset) and the classifier read them from here.
//
// Rules for entries:
// - `id` must be in CONNECTION_PRESETS (shared/types.ts): connections.preset has a CHECK on it, and
//   `<id>.<name>` event types are recognised through it.
// - Remote presets (Notion) give `url` and `auth`; native ones (WHOOP) give `createSource` (and `events`).

import type { IntegrationPreset } from "../broker/types.ts";

const PRESETS: IntegrationPreset[] = [
  // Notion and WHOOP add their entries here.
];

/** Every pre-made integration, in display order. */
export function presets(): IntegrationPreset[] {
  return PRESETS;
}

export function presetById(id: string): IntegrationPreset | null {
  return PRESETS.find((p) => p.id === id) ?? null;
}
