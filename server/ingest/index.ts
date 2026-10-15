import type { AppContext } from "../context.ts";
import { stubService } from "../util/stub.ts";
import type { IngestService } from "./types.ts";

// PLACEHOLDER: replaced by the owning work area.
export function createIngestService(_ctx: AppContext): IngestService {
  return stubService<IngestService>("ingest");
}
