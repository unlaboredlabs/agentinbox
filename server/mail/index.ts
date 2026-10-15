import type { AppContext } from "../context.ts";
import { stubService } from "../util/stub.ts";
import type { MailService } from "./types.ts";

// PLACEHOLDER: replaced by the owning work area.
export function createMailService(_ctx: AppContext): MailService {
  return stubService<MailService>("mail");
}
