// Pre-made integrations. Each preset adds one line here.

import type { IntegrationPreset } from "../broker/types.ts";
import { notionPreset } from "./notion/index.ts";
import { whoopPreset } from "./whoop/index.ts";

let cached: IntegrationPreset[] | null = null;

/** Built once: native presets keep per-process state. */
export const presets = (): IntegrationPreset[] => (cached ??= [notionPreset, whoopPreset()]);

export const presetById = (id: string): IntegrationPreset | null => presets().find((p) => p.id === id) ?? null;
