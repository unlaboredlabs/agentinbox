import type { IntegrationPreset } from "../broker/types.ts";
import { notionPreset } from "./notion/index.ts";

export const presets = (): IntegrationPreset[] => [notionPreset];
