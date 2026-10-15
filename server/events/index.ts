import type { AppContext } from "../context.ts";
import { stubService } from "../util/stub.ts";
import type { EventsService } from "./types.ts";

// PLACEHOLDER: replaced by the owning work area.
export function createEventsService(_ctx: AppContext): EventsService {
  return stubService<EventsService>("events");
}
