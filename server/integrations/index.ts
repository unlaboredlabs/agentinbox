// Pre-made integrations. Each preset adds one line here.

import type { IntegrationPreset } from "../broker/types.ts";
import { whoopPreset } from "./whoop/index.ts";

let cached: IntegrationPreset[] | null = null;

/** Built once: native presets keep per-process state (e.g. WHOOP's webhook dedupe). */
export const presets = (): IntegrationPreset[] => (cached ??= [whoopPreset()]);

export const presetById = (id: string): IntegrationPreset | null => presets().find((p) => p.id === id) ?? null;
